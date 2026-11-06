use super::tests::*;
use super::*;
use crate::ids::test_ids::pid;

/// A capture refill puts the cursor where tmux had it in the captured
/// screen, which the BEGIN marker reads in the capture's own command list.
/// The `list-panes` cursor is from earlier: the prompt's, before the line
/// typed at it. Output after the capture was drawn from there, over the
/// line the capture had just laid down (a v86 story showed an `echo`'s
/// output written into its own command line).
#[test]
fn a_capture_refill_draws_later_output_from_the_cursor_of_the_captured_screen() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    let pane = agg.panes.get_mut("%0").unwrap();
    pane.tmux_cursor_x = 14;
    pane.tmux_cursor_y = 0;
    agg.queue_captures(&[pid("%0")]);
    assert!(
        agg.markers()
            .capture_command(&pid("%0"))
            .starts_with("display-message -p -t %0 "),
        "the cursor is read in the capture's own command list"
    );

    let response = |output: &str| ControlModeEvent::CommandResponse {
        output: output.to_string(),
        success: true,
    };
    agg.process_event(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "0 17 0")));
    agg.process_event(response("root@tmuxy:~# abc\n"));
    agg.process_event(response(&marked(&agg, CAPTURE_END_MARKER, "")));
    agg.process_event(ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"d".to_vec(),
    });

    assert_eq!(
        agg.panes.get_mut("%0").unwrap().get_content()[0]
            .iter()
            .map(|c| c.char.clone())
            .collect::<String>()
            .trim_end(),
        "root@tmuxy:~# abcd"
    );
}
