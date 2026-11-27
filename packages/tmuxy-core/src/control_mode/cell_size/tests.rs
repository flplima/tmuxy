use super::*;

#[test]
fn a_cell_size_reads_as_the_client_writes_it() {
    assert_eq!(
        CellPx::parse("9x24"),
        Some(CellPx {
            width: 9.0,
            height: 24.0
        })
    );
    assert_eq!(
        CellPx::parse("8.5x17.25"),
        Some(CellPx {
            width: 8.5,
            height: 17.25
        })
    );
    assert_eq!(CellPx::parse("8.5x17").unwrap().to_option_value(), "8.5x17");
    assert_eq!(
        CellPx::parse("9.10x24").unwrap().to_option_value(),
        "9.1x24"
    );
}

#[test]
fn anything_else_is_no_size() {
    for value in [
        "", "9", "x24", "9x", "0x24", "9x0", "-9x24", "9x24x3", "9.x24", ".5x24", "9.123x24",
        "1e3x24", "9 x24", "2000x24", "9x24;", "nanx24", "infx24",
    ] {
        assert_eq!(CellPx::parse(value), None, "{value:?}");
    }
}

#[test]
fn only_the_bare_cell_and_text_area_queries_are_answered() {
    assert_eq!(SizeQuery::from_params(&[&[16]]), Some(SizeQuery::Cell));
    assert_eq!(SizeQuery::from_params(&[&[14]]), Some(SizeQuery::TextArea));
    for params in [
        &[&[18][..]][..],
        &[&[15]],
        &[&[19]],
        &[&[8], &[24], &[80]],
        &[&[14], &[2]],
        &[&[22], &[0]],
        &[],
    ] {
        assert_eq!(SizeQuery::from_params(params), None, "{params:?}");
    }
}

#[test]
fn a_reply_says_height_before_width_in_whole_pixels() {
    let cell = CellPx {
        width: 8.5,
        height: 17.4,
    };
    assert_eq!(SizeQuery::Cell.reply(cell, 80, 24), "\x1b[6;17;9t");
    // 24 rows of 17.4 are 417.6, 80 columns of 8.5 are 680.
    assert_eq!(SizeQuery::TextArea.reply(cell, 80, 24), "\x1b[4;418;680t");
}

#[test]
fn the_reply_is_typed_into_the_pane_in_hex_by_one_member_of_a_group() {
    let pane: PaneId = "%7".parse().unwrap();
    let command = reply_command(&pane, "\x1b[6;24;9t");
    assert_eq!(
        command,
        "if-shell -F '#{||:#{==:#{session_group},},#{==:#{s/,.*//:session_group_list},#{session_name}}}' \
         { send-keys -t %7 -H 1b 5b 36 3b 32 34 3b 39 74 }"
    );
}

#[test]
fn a_pane_is_answered_a_few_times_a_second_at_most() {
    let mut budget = ReplyBudget::default();
    let start = Instant::now();
    let taken = (0..10).filter(|_| budget.take(start)).count();
    assert_eq!(taken, usize::from(MAX_REPLIES));
    let later = start + REPLY_WINDOW / 2;
    assert!(!budget.take(later), "the window has not passed");
    let next = start + REPLY_WINDOW;
    assert!(budget.take(next), "a new window has room again");
}
