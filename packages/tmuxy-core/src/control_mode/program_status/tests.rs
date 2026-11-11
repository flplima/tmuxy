use super::*;

fn b64(text: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn set(body: &str) -> Record {
    match Report::parse(body.as_bytes()) {
        Some(Report::Set { record, .. }) => record,
        other => panic!("{body:?} is a report that sets a record, got {other:?}"),
    }
}

fn records(reports: &[&str]) -> Records {
    let mut records = Records::default();
    for body in reports {
        records.apply(Report::parse(body.as_bytes()).expect("a report"));
    }
    records
}

fn shown(records: &Records) -> (PaneStateName, String) {
    let shown = records.shown().expect("a record to show");
    (shown.state, shown.status)
}

/// The specification's own example: Terraform waiting for an approval.
#[test]
fn a_report_is_read_into_its_record() {
    let msg = b64("Apply 3 to add, 1 to change, 0 to destroy?");
    let record = set(&format!(
        "state=blocked:kind=permission:app=terraform:msg={msg}"
    ));
    assert_eq!(record.state, State::Blocked);
    assert_eq!(record.kind, Some("permission"));
    assert_eq!(record.app.as_deref(), Some("terraform"));
    assert_eq!(record.msg.as_deref(), Some(msg.as_str()));
    assert_eq!(record.progress, None);
}

#[test]
fn each_state_reads_as_the_pane_state_that_wants_the_same_of_the_user() {
    for (state, pane_state) in [
        ("idle", PaneStateName::Idle),
        ("working", PaneStateName::Working),
        ("done", PaneStateName::Unread),
        ("blocked", PaneStateName::NeedsInput),
        ("error", PaneStateName::Error),
    ] {
        assert_eq!(
            set(&format!("state={state}")).state.pane_state(),
            pane_state
        );
    }
}

#[test]
fn a_report_without_a_state_it_knows_is_ignored() {
    for body in [
        "?",
        "app=brew",
        "state=paused",
        "state",
        "",
        "state=Working",
    ] {
        assert_eq!(Report::parse(body.as_bytes()), None, "{body:?}");
    }
}

#[test]
fn a_malformed_pair_is_skipped_and_the_rest_still_read() {
    let record = set("nonsense:=empty: state = working :App=x:app=br ew:progress=40;x");
    assert_eq!(
        record.state,
        State::Working,
        "whitespace around a pair goes"
    );
    assert_eq!(
        record.app, None,
        "an upper-case key and a value with a space"
    );
    assert_eq!(record.progress, None, "a value with a byte outside the set");
    assert_eq!(set("state=working:msg=not base64!").msg, None);
}

#[test]
fn a_key_that_repeats_keeps_its_last_value_and_an_unknown_key_is_ignored() {
    let record = set("state=idle:colour=red:state=working:app=a:app=b");
    assert_eq!(record.state, State::Working);
    assert_eq!(record.app.as_deref(), Some("b"));
}

#[test]
fn kind_and_progress_belong_to_the_states_that_carry_them() {
    assert_eq!(set("state=working:kind=auth").kind, None);
    assert_eq!(set("state=blocked:kind=coffee").kind, None);
    assert_eq!(set("state=blocked:kind=auth:progress=7").progress, Some(7));
    assert_eq!(set("state=done:progress=7").progress, None);
    for progress in ["101", "-1", "+40", "4.5", "half", ""] {
        assert_eq!(
            set(&format!("state=working:progress={progress}")).progress,
            None,
            "{progress:?} is no percentage"
        );
    }
}

#[test]
fn free_text_that_is_not_one_line_of_utf8_discards_the_report() {
    let two_lines = b64("first\nsecond");
    let bell = b64("ding\u{7}");
    let c1 = b64("csi\u{9b}31m");
    for bad in [two_lines.as_str(), bell.as_str(), c1.as_str(), "/w==", "A"] {
        for key in ["msg", "title"] {
            assert_eq!(
                Report::parse(format!("state=working:{key}={bad}").as_bytes()),
                None,
                "{key} {bad:?}"
            );
        }
    }
    assert_eq!(
        set(&format!("state=working:msg={}", b64("Deploying v2.4.1"))).state,
        State::Working
    );
}

#[test]
fn padding_is_optional() {
    let unpadded = b64("Healthy").trim_end_matches('=').to_string();
    assert_eq!(
        set(&format!("state=done:msg={unpadded}")).msg,
        Some(unpadded)
    );
}

#[test]
fn a_report_past_a_limit_is_discarded_whole() {
    let long_msg = b64(&"m".repeat(MAX_MSG_DECODED_BYTES + 1));
    let long_title = b64(&"t".repeat(MAX_TITLE_DECODED_BYTES + 1));
    let long_key = "k".repeat(MAX_KEY_BYTES + 1);
    let long_app = "a".repeat(MAX_APP_BYTES + 1);
    let padding = "x".repeat(MAX_SEQUENCE_BYTES);
    for body in [
        format!("state=working:msg={long_msg}"),
        format!("state=working:title={long_title}"),
        format!("state=working:{long_key}=1"),
        format!("state=working:app={long_app}"),
        format!("state=working:pad={padding}"),
    ] {
        assert_eq!(Report::parse(body.as_bytes()), None, "{:.40}…", body);
    }
    // At the limit a report is kept.
    let msg = b64(&"m".repeat(MAX_MSG_DECODED_BYTES));
    let title = b64(&"t".repeat(MAX_TITLE_DECODED_BYTES));
    let app = "a".repeat(MAX_APP_BYTES);
    let record = set(&format!("state=working:app={app}:title={title}:msg={msg}"));
    assert_eq!(record.app, Some(app));
}

#[test]
fn a_report_whose_id_is_outside_the_grammar_never_reaches_the_root() {
    let deep = ["a"; MAX_ID_DEPTH + 1].join("/");
    let long_segment = "s".repeat(MAX_ID_SEGMENT_BYTES + 1);
    for id in [
        "a//b",
        "/a",
        "a/",
        "a b",
        "a,b",
        deep.as_str(),
        long_segment.as_str(),
    ] {
        assert_eq!(
            Report::parse(format!("state=working:id={id}").as_bytes()),
            None,
            "id {id:?}"
        );
    }
    assert_eq!(
        Report::parse(b"state=working:id=build/test"),
        Some(Report::Set {
            id: "build/test".to_string(),
            record: set("state=working"),
        })
    );
}

#[test]
fn a_report_replaces_its_record_completely() {
    let msg = b64("Installing updates");
    let records = records(&[
        &format!("state=working:app=brew:msg={msg}"),
        "state=working",
    ]);
    assert_eq!(
        shown(&records),
        (PaneStateName::Working, "state=working".to_string())
    );
}

#[test]
fn the_pane_shows_the_record_that_wants_the_user_most() {
    let approve = b64("Approve deploy to eu-west (production)?");
    let mut all = records(&[
        "state=working:app=deploy",
        "state=working:id=us-east:progress=40",
        &format!("state=blocked:kind=permission:id=eu-west:msg={approve}"),
        "state=done:id=us-east",
    ]);
    assert_eq!(
        shown(&all),
        (
            PaneStateName::NeedsInput,
            format!("state=blocked:id=eu-west:kind=permission:app=deploy:msg={approve}")
        ),
        "a child without an app takes its nearest ancestor's"
    );

    all.apply(Report::parse(b"state=clear:id=eu-west").unwrap());
    assert_eq!(
        shown(&all),
        (
            PaneStateName::Unread,
            "state=done:id=us-east:app=deploy".to_string()
        )
    );
}

#[test]
fn of_two_records_that_want_the_same_the_newer_is_shown() {
    let records = records(&["state=working:id=a", "state=working:id=b"]);
    assert_eq!(shown(&records).1, "state=working:id=b");
}

#[test]
fn clear_takes_a_record_and_everything_beneath_it() {
    let mut all = records(&[
        "state=working:id=build",
        "state=working:id=build/test",
        "state=working:id=builder",
        "state=idle",
    ]);
    all.apply(Report::parse(b"state=clear:id=build").unwrap());
    assert_eq!(shown(&all).1, "state=working:id=builder");

    all.apply(Report::parse(b"state=clear").unwrap());
    assert_eq!(all.shown(), None, "with no id, every record goes");
}

#[test]
fn a_new_prompt_ends_what_was_working_or_blocked_and_keeps_the_result() {
    let mut all = records(&[
        "state=working:id=a",
        "state=blocked:id=b",
        "state=error:id=c",
    ]);
    all.prompt_began();
    assert_eq!(shown(&all).1, "state=error:id=c");

    let mut busy = records(&["state=working"]);
    busy.prompt_began();
    assert_eq!(busy.shown(), None);
}

#[test]
fn past_the_cap_the_record_updated_least_recently_makes_room() {
    let mut all = Records::default();
    for n in 0..MAX_RECORDS {
        all.apply(Report::parse(format!("state=idle:id=r{n}").as_bytes()).unwrap());
    }
    // r0 is reported again, so r1 is now the oldest.
    all.apply(Report::parse(b"state=idle:id=r0").unwrap());
    all.apply(Report::parse(b"state=idle:id=one-more").unwrap());
    assert_eq!(all.entries.len(), MAX_RECORDS);
    assert!(all.entries.iter().any(|(id, _)| id == "r0"));
    assert!(!all.entries.iter().any(|(id, _)| id == "r1"));
}

fn report(body: &str) -> StatusEvent {
    StatusEvent::Report(Report::parse(body.as_bytes()).expect("a report"))
}

/// The state tmux is to be told, when it is to be told one.
fn state_of(due: Option<Due>) -> Option<Option<PaneStateName>> {
    due.filter(|due| due.write_state).map(|due| due.state)
}

#[test]
fn tmux_is_told_only_what_changes_what_the_pane_shows() {
    let mut tracker = Tracker::default();
    let start = Instant::now();
    assert_eq!(tracker.due(None, start), None, "nothing was reported");

    tracker.read(vec![StatusEvent::PromptBegan], Instant::now());
    assert_eq!(
        tracker.due(Some("working"), start),
        None,
        "a prompt on a pane with no record leaves a hook's state alone"
    );

    tracker.read(vec![report("state=working")], Instant::now());
    assert_eq!(
        state_of(tracker.due(None, start)),
        Some(Some(PaneStateName::Working))
    );
    assert!(
        tracker.take_row_stale(),
        "the next row may predate the write"
    );
    assert!(!tracker.take_row_stale(), "and only the next");

    let later = start + MIN_WRITE_INTERVAL;
    tracker.read(vec![report("state=working")], Instant::now());
    assert_eq!(
        tracker.due(Some("working"), later),
        None,
        "the same again changes nothing"
    );

    tracker.read(vec![StatusEvent::PromptBegan], Instant::now());
    assert_eq!(
        state_of(tracker.due(Some("working"), later)),
        Some(None),
        "the command is over: the state comes off the pane"
    );
}

/// The client takes `unread` off a pane once it is in front. A program that
/// then finishes something else says `done` again, and it shows again.
#[test]
fn a_program_that_reports_the_same_state_again_is_written_again_when_tmux_says_otherwise() {
    let mut tracker = Tracker::default();
    let start = Instant::now();
    tracker.read(vec![report("state=done")], Instant::now());
    assert_eq!(
        state_of(tracker.due(None, start)),
        Some(Some(PaneStateName::Unread))
    );

    let later = start + MIN_WRITE_INTERVAL;
    tracker.read(vec![StatusEvent::PromptBegan], Instant::now());
    assert_eq!(
        tracker.due(None, later),
        None,
        "a prompt is not the program speaking"
    );
    tracker.read(vec![report("state=done")], Instant::now());
    assert_eq!(
        state_of(tracker.due(None, later)),
        Some(Some(PaneStateName::Unread))
    );
}

#[test]
fn a_program_reporting_in_a_loop_is_written_once_per_interval_and_ends_on_its_last_word() {
    let mut tracker = Tracker::default();
    let start = Instant::now();
    tracker.read(vec![report("state=working")], Instant::now());
    assert!(tracker.due(None, start).is_some());

    tracker.read(vec![report("state=blocked")], Instant::now());
    tracker.read(vec![report("state=error")], Instant::now());
    let soon = start + MIN_WRITE_INTERVAL / 2;
    assert_eq!(tracker.due(Some("working"), soon), None, "held back");
    assert_eq!(
        state_of(tracker.due(Some("working"), start + MIN_WRITE_INTERVAL)),
        Some(Some(PaneStateName::Error)),
        "the held write is the newest state, not the first one missed"
    );
}

/// A program that only moves its progress along changes the text tmux holds
/// and leaves the state alone.
#[test]
fn a_change_of_text_alone_writes_the_text_and_not_the_state() {
    let mut tracker = Tracker::default();
    let start = Instant::now();
    tracker.read(vec![report("state=working:progress=40")], Instant::now());
    assert_eq!(
        tracker.due(None, start),
        Some(Due {
            state: Some(PaneStateName::Working),
            status: Some("state=working:progress=40".to_string()),
            write_state: true,
            write_status: true,
        })
    );

    tracker.read(vec![report("state=working:progress=50")], Instant::now());
    assert_eq!(
        tracker.due(Some("working"), start + MIN_WRITE_INTERVAL),
        Some(Due {
            state: Some(PaneStateName::Working),
            status: Some("state=working:progress=50".to_string()),
            write_state: false,
            write_status: true,
        })
    );
    assert!(
        tracker.take_row_stale(),
        "the next row may predate the text"
    );
}

#[test]
fn text_is_for_a_pane_only_while_the_pane_is_in_the_state_it_was_reported_with() {
    let status = "state=blocked:id=eu-west:kind=permission:msg=QQ==";
    assert!(status_is_for(status, Some("needs-input")));
    assert!(!status_is_for(status, Some("working")), "a hook moved on");
    assert!(
        !status_is_for(status, None),
        "the client took the state off"
    );
    assert!(!status_is_for("kind=permission", Some("needs-input")));
    assert!(!status_is_for("state=sleeping", Some("idle")));
    assert!(status_is_for("state=done", Some("unread")));
}

#[test]
fn a_long_command_marks_its_pane_when_it_ends_and_the_next_command_takes_the_mark_off() {
    let mut tracker = Tracker::default();
    let start = Instant::now();
    tracker.read(vec![StatusEvent::CommandBegan], start);
    assert_eq!(
        tracker.due(None, start),
        None,
        "a running command says nothing"
    );

    let end = start + command_finish::LONG_COMMAND;
    tracker.read(
        vec![StatusEvent::CommandEnded(Some(0)), StatusEvent::PromptBegan],
        end,
    );
    let due = tracker.due(None, end).expect("the end is told");
    assert_eq!(due.state, Some(PaneStateName::Unread));
    let status = due.status.expect("with how it ended");
    assert!(
        status.starts_with("state=done:id=tmuxy.command:msg="),
        "{status}"
    );

    let next = end + MIN_WRITE_INTERVAL;
    tracker.read(vec![StatusEvent::CommandBegan], next);
    assert_eq!(
        state_of(tracker.due(Some("unread"), next)),
        Some(None),
        "a new command: the last one's end is no longer news"
    );
}

#[test]
fn a_long_command_that_failed_marks_its_pane_as_an_error() {
    let mut tracker = Tracker::default();
    let start = Instant::now();
    tracker.read(vec![StatusEvent::CommandBegan], start);
    let end = start + command_finish::LONG_COMMAND;
    tracker.read(vec![StatusEvent::CommandEnded(Some(2))], end);
    assert_eq!(
        state_of(tracker.due(None, end)),
        Some(Some(PaneStateName::Error))
    );
}

#[test]
fn a_short_command_and_an_end_without_a_start_leave_the_pane_alone() {
    let mut tracker = Tracker::default();
    let start = Instant::now();
    tracker.read(
        vec![
            StatusEvent::CommandBegan,
            StatusEvent::CommandEnded(Some(1)),
        ],
        start,
    );
    assert_eq!(tracker.due(Some("working"), start), None);

    let later = start + command_finish::LONG_COMMAND * 2;
    tracker.read(vec![StatusEvent::CommandEnded(Some(1))], later);
    assert_eq!(
        tracker.due(Some("working"), later),
        None,
        "the start was never seen, so how long it ran is not known"
    );
}

#[test]
fn a_program_that_reports_for_itself_keeps_its_record_beside_the_shells() {
    let mut tracker = Tracker::default();
    let start = Instant::now();
    tracker.read(
        vec![StatusEvent::CommandBegan, report("state=working")],
        start,
    );
    assert_eq!(
        state_of(tracker.due(None, start)),
        Some(Some(PaneStateName::Working))
    );

    let end = start + command_finish::LONG_COMMAND;
    tracker.read(
        vec![StatusEvent::CommandEnded(Some(0)), StatusEvent::PromptBegan],
        end,
    );
    assert_eq!(
        state_of(tracker.due(Some("working"), end)),
        Some(Some(PaneStateName::Unread)),
        "the prompt ends the program's working, the command's end stays to be seen"
    );
}
