use super::tests::*;
use super::*;
use crate::constants::tmux_formats::PaneColumn;
use crate::ids::test_ids::pid;

fn printed(agg: &mut StateAggregator, pane_id: &str, bytes: &[u8]) -> Vec<String> {
    agg.process_event(ControlModeEvent::Output {
        pane_id: pid(pane_id),
        content: bytes.to_vec(),
    })
    .commands
}

/// A list-panes row for `pane_id` with the two options a report is held in.
fn row(pane_id: &str, state: &str, status: &str) -> String {
    pane_row_builder(pane_id, "@0")
        .set(PaneColumn::PaneState, state)
        .set(PaneColumn::Status, status)
        .build()
}

/// The two writes a report with this state makes on `pane_id`, text first.
fn writes(pane_id: &str, status: &str, state: &str) -> Vec<String> {
    vec![
        format!("set-option -p -t {pane_id} @tmuxy-pane-status '{status}'"),
        format!("set-option -p -t {pane_id} @tmuxy-pane-state {state}"),
    ]
}

/// What a program prints with OSC 7501 is the pane's at once, and commands
/// through control mode make it tmux's, where everything else reads it (the
/// tabs, the push notification, another client, another session's host).
#[test]
fn a_program_status_report_becomes_the_panes_state_and_two_tmux_writes() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");

    let commands = printed(
        &mut agg,
        "%0",
        b"\x1b]7501;state=blocked:kind=question:msg=V2hpY2ggYnJhbmNoPw==\x1b\\",
    );
    let status = "state=blocked:kind=question:msg=V2hpY2ggYnJhbmNoPw==";
    assert_eq!(commands, writes("%0", status, "needs-input"));
    assert_eq!(agg.panes["%0"].pane_state.as_deref(), Some("needs-input"));
    assert_eq!(agg.panes["%0"].pane_status.as_deref(), Some(status));

    assert!(
        printed(&mut agg, "%0", b"plain output").is_empty(),
        "output that reports nothing writes nothing"
    );
}

#[test]
fn a_report_wrapped_in_tmux_passthrough_or_split_across_writes_is_read_the_same() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");

    assert!(printed(&mut agg, "%0", b"\x1b]7501;state=wor").is_empty());
    assert_eq!(
        printed(&mut agg, "%0", b"king\x07"),
        writes("%0", "state=working", "working")
    );

    seed_pane(&mut agg, "%1", "@0");
    assert_eq!(
        printed(
            &mut agg,
            "%1",
            b"\x1bPtmux;\x1b\x1b]7501;state=error\x1b\x1b\\\x1b\\"
        ),
        writes("%1", "state=error", "error")
    );
}

#[test]
fn the_feature_detection_query_and_a_malformed_report_change_nothing() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    for bytes in [
        &b"\x1b]7501;?\x1b\\"[..],
        b"\x1b]7501;state=sleeping\x07",
        b"\x1b]7501;\x07",
        b"\x1b]7501;state=working:msg=/w==\x07",
        b"\x1b]7501;state=working:id=a b\x07",
    ] {
        assert!(printed(&mut agg, "%0", bytes).is_empty(), "{bytes:?}");
    }
    assert_eq!(agg.panes["%0"].pane_state, None);
    assert_eq!(agg.panes["%0"].pane_status, None);
}

/// tmux runs commands in order: a `list-panes` asked for before the writes
/// answers with what they replaced, and must not put it back.
#[test]
fn a_listing_that_predates_the_writes_does_not_undo_them() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    printed(&mut agg, "%0", b"\x1b]7501;state=working\x07");

    agg.parse_list_panes_line(&row("%0", "", ""));
    assert_eq!(agg.panes["%0"].pane_state.as_deref(), Some("working"));
    assert_eq!(
        agg.panes["%0"].pane_status.as_deref(),
        Some("state=working")
    );

    // The listing after it is tmux's word again: a hook's, the client's.
    agg.parse_list_panes_line(&row("%0", "idle", "state=working"));
    assert_eq!(agg.panes["%0"].pane_state.as_deref(), Some("idle"));
}

#[test]
fn a_new_prompt_takes_a_working_state_off_and_leaves_a_result() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    let commands = printed(
        &mut agg,
        "%0",
        b"\x1b]7501;state=working\x07make: done\r\n\x1b]133;A;cl=m\x07$ ",
    );
    assert!(
        commands.is_empty(),
        "working and the prompt that ends it, in one write, show nothing: {commands:?}"
    );

    seed_pane(&mut agg, "%1", "@0");
    assert_eq!(
        printed(&mut agg, "%1", b"\x1b]7501;state=error\x07\x1b]133;A\x07$ "),
        writes("%1", "state=error", "error")
    );
}

/// A write held back for coming too soon goes out with the next listing,
/// so a program that stops printing still ends on its last word.
#[test]
fn a_held_write_goes_out_with_the_next_listing() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    assert_eq!(
        printed(&mut agg, "%0", b"\x1b]7501;state=working\x07"),
        writes("%0", "state=working", "working")
    );
    assert!(
        printed(&mut agg, "%0", b"\x1b]7501;state=done\x07").is_empty(),
        "inside the interval"
    );
    assert!(agg.held_status_commands(Instant::now()).is_empty());

    let due = Instant::now() + program_status::MIN_WRITE_INTERVAL;
    assert_eq!(
        agg.held_status_commands(due),
        writes("%0", "state=done", "unread")
    );
    assert_eq!(agg.panes["%0"].pane_state.as_deref(), Some("unread"));
}

/// Clearing takes both options off the pane.
#[test]
fn a_cleared_status_unsets_both_options() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    printed(&mut agg, "%0", b"\x1b]7501;state=working\x07");
    let later = Instant::now() + program_status::MIN_WRITE_INTERVAL;
    agg.panes
        .get_mut("%0")
        .unwrap()
        .process_output(b"\x1b]7501;state=clear\x07");
    assert_eq!(
        agg.held_status_commands(later),
        vec![
            "set-option -pu -t %0 @tmuxy-pane-status".to_string(),
            "set-option -pu -t %0 @tmuxy-pane-state".to_string(),
        ]
    );
    assert_eq!(agg.panes["%0"].pane_status, None);
}

/// What the program said behind its state (the question, the progress) is
/// read from tmux like the state, so a host that never saw the report has
/// it, and it is the pane's only while the state is still the report's: a
/// hook or the client that changes the state leaves the old text in tmux.
#[test]
fn a_reports_text_is_the_panes_while_the_state_is_still_the_reports() {
    let status = "state=blocked:kind=question:msg=V2hpY2ggYnJhbmNoPw==";
    let shown = |agg: &mut StateAggregator| {
        let pane = agg.panes.get_mut("%3").unwrap();
        pane.build_tmux_pane().expect("placed").pane_status
    };

    // A host that attached after the report reads both options.
    let mut agg = StateAggregator::new();
    agg.parse_list_panes_line(&row("%3", "needs-input", status));
    assert_eq!(shown(&mut agg).as_deref(), Some(status));

    // A hook says the agent is working again: the text is the old state's.
    agg.parse_list_panes_line(&row("%3", "working", status));
    assert_eq!(shown(&mut agg), None);

    // A value with a comma in it, set by hand, shifts no field.
    agg.parse_list_panes_line(&row("%3", "working", "state=working:app=a,b"));
    assert_eq!(
        agg.panes["%3"].pane_status.as_deref(),
        Some("state=working:app=a,b")
    );
}
