use super::*;

// Reported by tmux 3.7c for a 159x48 window split right, then the right
// half split below — checksum included, so serialising must reproduce it.
const MANUAL: &str = "adc3,159x48,0,0{79x48,0,0,0,79x48,80,0[79x24,80,0,1,79x23,80,25,2]}";

#[test]
fn round_trips_the_manual_example_with_its_checksum() {
    let node = parse(MANUAL).expect("parses");
    assert_eq!(serialize(&node), MANUAL);
    // A checksum-less string parses too and gets one on the way out.
    let bare = parse("159x48,0,0,1").expect("parses");
    assert_eq!(
        serialize(&bare),
        format!("{:04x},159x48,0,0,1", checksum("159x48,0,0,1"))
    );
}

/// tmux 3.8 prints `#{window_layout}` as JSON, which no older tmux's
/// `select-layout` takes. The same 80x20 window (a row above a
/// side-by-side pair), as tmux 3.8 printed it and as tmux 3.4 printed it:
/// the JSON comes out as exactly the 3.4 string, checksum and all.
#[test]
fn tmux_3_8_json_layout_becomes_the_classic_string() {
    let json = r#"{"V":2,"L":{"t":"v","w":80,"h":20,"x":0,"y":0,"c":[{"t":"p","w":80,"h":10,"x":0,"y":0,"l":1,"i":0,"I":"%0"},{"t":"h","w":80,"h":9,"x":0,"y":11,"c":[{"t":"p","w":40,"h":9,"x":0,"y":11,"l":0,"i":1,"I":"%1"},{"t":"p","w":39,"h":9,"x":41,"y":11,"a":true,"i":2,"I":"%2"}]}]}}"#;
    let tmux_3_4 = "72ca,80x20,0,0[80x10,0,0,0,80x9,0,11{40x9,0,11,1,39x9,41,11,2}]";
    assert_eq!(
        parse_json(json).map(|n| serialize(&n)).as_deref(),
        Some(tmux_3_4)
    );
    // `parse` takes either form and sees the same tree.
    assert_eq!(parse(json), parse(tmux_3_4));
    // Not a layout: no tree, not a panic.
    assert_eq!(parse_json(r#"{"V":2}"#), None);
    assert_eq!(parse_json("not json"), None);
}

#[test]
fn collapses_every_first_level_row_but_the_active_one() {
    // Three stacked rows of 10 in a 32-row window; the middle row is a
    // side-by-side pair.
    let layout = "0000,80x32,0,0[80x10,0,0,1,80x10,0,11{40x10,0,11,2,39x10,41,11,3},80x10,0,22,4]";
    let out = collapse_first_level(layout, 3).expect("relayout");
    let node = parse(&out).expect("parses back");
    assert_eq!(first_level_heights(&out), Some(vec![2, 27, 1]));
    // The nested pair kept its widths and took the row's full height.
    let Node::Split { children, .. } = &node else {
        panic!()
    };
    let Node::Split { children: pair, .. } = &children[1] else {
        panic!()
    };
    assert_eq!(pair.iter().map(Node::w).collect::<Vec<_>>(), vec![40, 39]);
    assert!(pair.iter().all(|c| c.h() == 27));
    // Offsets are recomputed top to bottom.
    let Node::Leaf { y, .. } = &children[2] else {
        panic!()
    };
    assert_eq!(*y, 31);
    // Applying the same rule again is a no-op.
    assert_eq!(collapse_first_level(&out, 3), None);
    assert_eq!(collapse_first_level(&out, 2), None);
}

#[test]
fn tmux_keeping_a_status_line_on_the_top_row_counts_as_in_shape() {
    // [2, 27, 1] is the shape asked for, so there is nothing to send.
    let layout = "0000,80x32,0,0[80x2,0,0,1,80x27,0,3,2,80x1,0,31,3]";
    assert_eq!(collapse_first_level(layout, 2), None);
}

#[test]
fn the_top_row_keeps_a_line_of_its_own_to_show() {
    // The reported bug: the first pane of a stack was a bare header with
    // no content under it. tmuxy runs with `pane-border-status top`, so
    // every row's status line sits on the separator above it — except the
    // top row, which has no separator, so tmux takes the line out of the
    // pane. Asked for one row, that pane had nothing left.
    let layout = "0000,80x32,0,0[80x10,0,0,1,80x10,0,11,2,80x10,0,22,3]";
    let out = collapse_first_level(layout, 3).expect("relayout");
    assert_eq!(first_level_heights(&out), Some(vec![2, 1, 27]));

    // And when the top row is the active one it is simply the big row —
    // no extra line, it has plenty.
    let out = collapse_first_level(layout, 1).expect("relayout");
    assert_eq!(first_level_heights(&out), Some(vec![28, 1, 1]));
}

#[test]
fn a_nested_stack_collapses_to_one_row_per_pane() {
    let layout = "0000,80x32,0,0[80x15,0,0[80x7,0,0,1,80x7,0,8,2],80x16,0,16,3]";
    let out = collapse_first_level(layout, 3).expect("relayout");
    // One row per stacked pane, one separator between them, and one more
    // for the status line the top row's border takes.
    assert_eq!(first_level_heights(&out), Some(vec![4, 27]));
}

#[test]
fn nothing_to_do_for_side_by_side_roots_or_foreign_panes() {
    assert_eq!(collapse_first_level(MANUAL, 1), None);
    let layout = "0000,80x32,0,0[80x15,0,0,1,80x16,0,16,2]";
    assert_eq!(collapse_first_level(layout, 9), None);
}

#[test]
fn evens_the_first_level_out_and_leaves_nested_proportions() {
    let layout = "0000,80x32,0,0[80x1,0,0,1,80x28,0,2{40x28,0,2,2,39x28,41,2,3},80x1,0,31,4]";
    let out = even_first_level(layout).expect("relayout");
    assert_eq!(first_level_heights(&out), Some(vec![10, 10, 10]));
    assert_eq!(even_first_level(&out), None);
}

#[test]
fn refuses_a_window_too_short_for_its_rows() {
    let layout = "0000,80x3,0,0[80x1,0,0,1,80x1,0,2,2]";
    assert_eq!(collapse_first_level(layout, 1), None);
    assert_eq!(even_first_level(layout), None);
}
