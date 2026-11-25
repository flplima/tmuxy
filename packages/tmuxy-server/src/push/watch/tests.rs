use super::{Notice, Watch};
use tmuxy_core::host::socket_watch::{parse_rows, PaneRow};

fn rows(states: &[(&str, &str)], notify: &str) -> Vec<PaneRow> {
    let reported: Vec<(&str, &str, &str)> = states
        .iter()
        .map(|(pane, state)| (*pane, *state, ""))
        .collect();
    rows_reporting(&reported, notify)
}

/// Rows with what a report said each state is about (`@tmuxy-pane-status`).
fn rows_reporting(states: &[(&str, &str, &str)], notify: &str) -> Vec<PaneRow> {
    parse_rows(
        &states
            .iter()
            .map(|(pane, state, status)| {
                format!("{pane}\twork\t{notify}\t{state}\t2.1.314\t@1\t\t\t\t100\t{status}\tmain")
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// A notification is news: a pane entering `needs-input` or `error`, once
/// per entry, and none for what was already so when the watch began, or
/// while `@tmuxy-notify` is off.
#[test]
fn a_pane_coming_to_need_the_user_is_one_notice() {
    let mut watch = Watch::default();
    assert!(watch
        .update(&rows(&[("%1", "needs-input"), ("%2", "")], "on"), "devbox")
        .is_empty());

    let notices = watch.update(
        &rows(&[("%1", "needs-input"), ("%2", "error")], "on"),
        "devbox",
    );
    assert_eq!(
        notices,
        vec![Notice {
            title: "claude stopped with an error".into(),
            body: "devbox · work · main (%2)".into(),
            tag: "tmuxy-%2-error".into(),
            url: "/?session=work".into(),
            pane_id: "%2".into(),
        }]
    );
    assert!(watch
        .update(&rows(&[("%1", "needs-input"), ("%2", "error")], "on"), "")
        .is_empty());

    watch.update(&rows(&[("%1", "working")], "on"), "");
    let again = watch.update(&rows(&[("%1", "needs-input")], "on"), "");
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].title, "claude needs you");

    watch.update(&rows(&[("%1", "working")], "off"), "");
    assert!(watch
        .update(&rows(&[("%1", "needs-input")], "off"), "")
        .is_empty());
}

/// A notification says what the pane said behind its state, above where it
/// is: the question an agent's hook wrote, cut to a banner's length. Text an
/// earlier state left behind is not this state's, and is not said.
#[test]
fn a_notice_says_the_question_the_pane_waits_on() {
    let asked = tmuxy_core::control_mode::blocked_status(
        "question",
        "claude",
        "Which framework should the dashboard use?",
    )
    .unwrap();
    let mut watch = Watch::default();
    watch.update(&rows(&[("%1", "working")], "on"), "");
    let notices = watch.update(
        &rows_reporting(&[("%1", "needs-input", &asked)], "on"),
        "devbox",
    );
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].title, "claude needs you");
    assert_eq!(
        notices[0].body,
        "Which framework should the dashboard use?\ndevbox · work · main (%1)"
    );

    let long = tmuxy_core::control_mode::blocked_status("question", "claude", &"why ".repeat(100))
        .unwrap();
    watch.update(&rows(&[("%1", "working")], "on"), "");
    let notices = watch.update(&rows_reporting(&[("%1", "needs-input", &long)], "on"), "");
    let said = notices[0].body.lines().next().unwrap();
    assert_eq!(said.chars().count(), 240);
    assert!(said.ends_with("why\u{2026}"), "{said}");

    // An agent's hook that ran in a shell names the agent, not the shell.
    let in_a_shell = |state: &str, status: &str| {
        parse_rows(&format!(
            "%1\twork\ton\t{state}\tbash\t@1\t\t\t\t100\t{status}\tmain"
        ))
    };
    watch.update(&in_a_shell("working", ""), "");
    let notices = watch.update(&in_a_shell("needs-input", &asked), "");
    assert_eq!(notices[0].title, "claude needs you");
    watch.update(&in_a_shell("working", ""), "");
    let notices = watch.update(&in_a_shell("error", &asked), "");
    assert_eq!(notices[0].title, "bash stopped with an error");

    // The question was answered and the pane moved on; a later error does
    // not say it.
    watch.update(&rows(&[("%1", "working")], "on"), "");
    let notices = watch.update(&rows_reporting(&[("%1", "error", &asked)], "on"), "");
    assert_eq!(notices[0].body, "work · main (%1)");
}

/// A result (`unread`) is cleared by the client that shows the pane, within
/// the moment it appears there. So it is news only once it has outlasted a
/// read, and then once.
#[test]
fn a_result_nobody_has_seen_by_the_next_read_is_one_notice() {
    const DONE: &str = "state=done:app=make";
    let mut watch = Watch::default();
    watch.update(&rows(&[("%1", "working"), ("%2", "working")], "on"), "");

    let both = [("%1", "unread", DONE), ("%2", "unread", DONE)];
    let entered = watch.update(&rows_reporting(&both, "on"), "");
    assert!(entered.is_empty(), "a client may be showing either pane");

    let one = [("%1", "unread", DONE), ("%2", "", DONE)];
    let waited = watch.update(&rows_reporting(&one, "on"), "host");
    assert_eq!(
        waited,
        vec![Notice {
            title: "make finished".into(),
            body: "host · work · main (%1)".into(),
            tag: "tmuxy-%1-unread".into(),
            url: "/?session=work".into(),
            pane_id: "%1".into(),
        }],
        "%2 was seen and cleared in between"
    );
    assert!(watch
        .update(&rows_reporting(&[("%1", "unread", DONE)], "on"), "")
        .is_empty());

    watch.update(&rows(&[("%1", "working")], "off"), "");
    watch.update(&rows_reporting(&[("%1", "unread", DONE)], "off"), "");
    assert!(watch
        .update(&rows_reporting(&[("%1", "unread", DONE)], "off"), "")
        .is_empty());
}

/// `unread` is also what a send leaves on the pane it typed into, and what a
/// state outlived by its text looks like. Nothing finished there.
#[test]
fn an_unread_that_no_report_is_behind_is_no_notice() {
    for status in ["", "state=working:progress=40"] {
        let sent = [("%1", "unread", status)];
        let mut watch = Watch::default();
        watch.update(&rows(&[("%1", "")], "on"), "");
        assert!(watch.update(&rows_reporting(&sent, "on"), "").is_empty());
        assert!(
            watch.update(&rows_reporting(&sent, "on"), "").is_empty(),
            "with {status:?}"
        );
    }
}
