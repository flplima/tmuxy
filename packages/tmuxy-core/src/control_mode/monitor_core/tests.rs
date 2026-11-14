use super::attach::enforced_settings;
use super::sizing::{needs_resize, resize_command, MAX_RESIZE_ATTEMPTS};
use super::*;
use crate::constants::tmux_formats::{RowBuilder, TmuxList, WindowColumn};
use crate::control_mode::state::{
    CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER, LIST_BEGIN_MARKER, LIST_END_MARKER,
    REPLY_BEGIN_MARKER, REPLY_END_MARKER,
};

pub(super) type Core = MonitorCore<&'static str>;

pub(super) fn core(session: &str) -> (Core, Instant) {
    let now = Instant::now();
    (MonitorCore::new(session, "tmux", now), now)
}

fn initial_resize(session: &str) -> String {
    let (core, _) = core(session);
    core.attach_commands((200, 50), AttachConfig::default())
        .into_iter()
        .find(|c| c.starts_with("resizew"))
        .expect("the attach sizes the session")
}

pub(super) fn response(output: &str) -> ControlModeEvent {
    ControlModeEvent::CommandResponse {
        output: output.to_string(),
        success: true,
    }
}

pub(super) fn marked(core: &Core, name: &str, arg: &str) -> ControlModeEvent {
    response(format!("{} {arg}", core.aggregator().markers().tag(name)).trim_end())
}

pub(super) fn sent<W>(actions: &[Action<W>]) -> Vec<&str> {
    actions
        .iter()
        .filter_map(|a| match a {
            Action::Send(lines) => Some(lines.iter().map(String::as_str)),
            _ => None,
        })
        .flatten()
        .collect()
}

/// `GET /events?session=` lets a client pick the name, and an unquoted one
/// carrying `;` was parsed by control mode as a second command:
/// `?session=x ; run-shell "id>/tmp/p" ; resizew` ran the `run-shell`.
#[test]
fn a_session_name_carrying_a_semicolon_stays_one_command() {
    let cmd = initial_resize(r#"x ; run-shell "id>/tmp/p" ; resizew"#);
    assert_eq!(
        cmd,
        r#"resizew -t 'x ; run-shell "id>/tmp/p" ; resizew' -x 200 -y 50"#
    );
}

#[test]
fn a_session_name_carrying_a_quote_is_escaped_not_terminated() {
    assert!(initial_resize("it's").starts_with(r"resizew -t 'it'\''s' "));
}

#[test]
fn a_window_is_resized_by_its_id() {
    assert_eq!(
        resize_command(&WindowId::from_number(3), (41, 29)),
        "resizew -t @3 -x 41 -y 29"
    );
}

#[test]
fn a_window_tmux_did_not_resize_is_asked_again() {
    // Asked once at report 3, and the report after it (4) still shows
    // the old grid: ask again.
    assert!(needs_resize(
        Some((200, 50)),
        (41, 29),
        Some(((41, 29), 1, 3)),
        4
    ));
}

#[test]
fn a_window_is_not_asked_again_until_tmux_has_reported_since() {
    // Asked at report 3, still at report 3: nothing to judge yet.
    assert!(!needs_resize(None, (41, 29), Some(((41, 29), 1, 3)), 3));
    assert!(!needs_resize(
        Some((200, 50)),
        (41, 29),
        Some(((41, 29), 1, 3)),
        3
    ));
}

#[test]
fn a_window_tmux_did_resize_is_left_alone() {
    assert!(!needs_resize(
        Some((41, 29),),
        (41, 29),
        Some(((41, 29), 3, 3)),
        4
    ));
    assert!(!needs_resize(
        Some((41, 29)),
        (41, 29),
        Some(((41, 29), 9, 3)),
        4
    ));
}

#[test]
fn a_size_tmux_keeps_refusing_stops_being_asked() {
    assert!(needs_resize(
        Some((200, 50)),
        (41, 29),
        Some(((41, 29), 2, 3)),
        4
    ));
    assert!(!needs_resize(
        Some((200, 50)),
        (41, 29),
        Some(((41, 29), MAX_RESIZE_ATTEMPTS, 3)),
        4
    ));
}

#[test]
fn a_new_size_starts_its_own_attempts() {
    assert!(needs_resize(
        Some((200, 50)),
        (80, 24),
        Some(((41, 29), MAX_RESIZE_ATTEMPTS, 3)),
        3
    ));
}

#[test]
fn a_window_with_no_panes_yet_is_still_asked() {
    assert!(needs_resize(None, (41, 29), None, 0));
}

#[test]
fn only_keystrokes_skip_failure_reporting() {
    let reports_failure = replies::command_reports_failure;
    assert!(!reports_failure("send-keys -t %1 -l x"));
    assert!(!reports_failure("send -t %1 x"));
    assert!(!reports_failure(
        "send-keys -t %1 -l -- 'a'\nsend-keys -t %1 Enter"
    ));
    assert!(!reports_failure(
        "select-window -t @1 ; select-pane -t %1 ; send-keys Enter"
    ));
    assert!(!reports_failure(
        "select-window -t @1 \\; select-pane -t %1 \\; send-keys Enter"
    ));
    assert!(reports_failure("split-window -h"));
    assert!(reports_failure(
        "select-window -t @1 ; select-pane -t %1 ; kill-pane"
    ));
    assert!(reports_failure("run-shell 'tmuxy pane float'"));
    assert!(reports_failure("select-window -t @2"));
    assert!(reports_failure("refresh-client -C 80x24"));
}

/// A pane `%0` in window `@0` the core knows, as an initial sync leaves it.
pub(super) fn with_a_pane(core: &mut Core, now: Instant) {
    let window = RowBuilder::<WindowColumn>::new()
        .set(WindowColumn::WindowId, "@0")
        .set(WindowColumn::Index, 0)
        .set(WindowColumn::Active, 1)
        .set(WindowColumn::WindowType, "tab")
        .set(WindowColumn::Zoomed, 0)
        .set(WindowColumn::Name, "shell")
        .build();
    let events = [
        marked(core, LIST_BEGIN_MARKER, TmuxList::Panes.name()),
        response("%0,0,0,0,80,24,0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,,,"),
        marked(core, LIST_END_MARKER, ""),
        marked(core, LIST_BEGIN_MARKER, TmuxList::Windows.name()),
        response(&window),
        marked(core, LIST_END_MARKER, ""),
        marked(core, CAPTURE_BEGIN_MARKER, "0"),
        response("$ "),
        marked(core, CAPTURE_END_MARKER, ""),
    ];
    for event in events {
        core.step(event, now);
    }
    assert!(core.aggregator().initial_state_ready());
}

/// M2, M11. Every host attaches with this one list: a guest's own copy once
/// lost `set-clipboard off`, and with tmux's clipboard on, a background
/// pane's OSC 52 reached every client through the server's paste buffer.
#[test]
fn an_attach_enforces_the_settings_after_the_config_and_lists_panes_first() {
    let (core, _) = core("app");
    let cmds = core.attach_commands(
        (80, 24),
        AttachConfig {
            config: vec!["source-file x".to_string()],
            host: vec!["setenv -g X 1".to_string()],
        },
    );
    let at = |wanted: &str| {
        cmds.iter()
            .position(|c| c == wanted)
            .unwrap_or_else(|| panic!("{wanted:?} not in {cmds:?}"))
    };
    let relist = core.aggregator().markers().window_relist_commands();
    let order = [
        at("set window-size manual"),
        at("resizew -t 'app' -x 80 -y 24"),
        at("source-file x"),
        at("set set-clipboard 'off'"),
        at("setenv -g X 1"),
        at("refresh-client -f pause-after=5"),
        at(&core.aggregator().markers().version_read_command()),
        at(&relist[0]),
        at(&relist[1]),
        at(&relist[2]),
    ];
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{cmds:?}");
    for setting in enforced_settings() {
        assert!(at(&setting) < at("setenv -g X 1"));
    }
    assert!(cmds
        .last()
        .is_some_and(|c| c.starts_with("refresh-client -B")));
}

/// M2. The re-list is due a beat after the first output, and later output
/// does not push it back.
#[test]
fn a_pane_that_keeps_printing_does_not_starve_the_metadata_sync() {
    let (mut core, start) = core("app");
    with_a_pane(&mut core, start);
    for tick in 0..10u64 {
        let now = start + Duration::from_millis(40 * tick);
        let actions = core.step(
            ControlModeEvent::Output {
                pane_id: "%0".parse().unwrap(),
                content: b"x".to_vec(),
            },
            now,
        );
        assert!(actions
            .iter()
            .any(|a| matches!(a, Action::Emit(ChangeType::Output))));
    }
    assert_eq!(core.next_deadline(), start + METADATA_SYNC_DELAY);
    let actions = core.tick(start + METADATA_SYNC_DELAY);
    let relist = core.aggregator().markers().window_relist_commands();
    assert_eq!(
        sent(&actions),
        relist.iter().map(String::as_str).collect::<Vec<_>>()
    );
}

/// A status write held back for coming too soon has a deadline of its own:
/// a program whose last word is followed by no output, and by no listing,
/// still ends on it.
#[test]
fn a_held_status_write_goes_out_when_its_interval_is_over() {
    use crate::control_mode::program_status::MIN_WRITE_INTERVAL;
    let (mut core, start) = core("app");
    with_a_pane(&mut core, start);
    let print = |core: &mut Core, bytes: &[u8]| {
        core.step(
            ControlModeEvent::Output {
                pane_id: "%0".parse().unwrap(),
                content: bytes.to_vec(),
            },
            start,
        )
    };
    let told = print(&mut core, b"\x1b]7501;state=working\x07");
    assert!(sent(&told).contains(&"set-option -p -t %0 @tmuxy-pane-state working"));
    let held = print(&mut core, b"\x1b]7501;state=done\x07");
    assert!(!sent(&held).iter().any(|c| c.contains("unread")));

    let wake = core.next_deadline();
    assert!(
        wake <= Instant::now() + MIN_WRITE_INTERVAL,
        "the monitor wakes for the held write, not for the next heartbeat"
    );
    assert_eq!(
        sent(&core.tick(wake)),
        [
            "set-option -p -t %0 @tmuxy-pane-status 'state=done'",
            "set-option -p -t %0 @tmuxy-pane-state unread",
        ]
    );
    assert!(
        core.next_deadline() > wake + MIN_WRITE_INTERVAL,
        "and has nothing more to wake for"
    );
}

/// M2.
#[test]
fn the_idle_heartbeat_lists_panes_before_windows() {
    let (mut core, start) = core("app");
    let actions = core.tick(start + IDLE_THRESHOLD);
    let relist = core.aggregator().markers().window_relist_commands();
    assert_eq!(
        sent(&actions),
        relist.iter().map(String::as_str).collect::<Vec<_>>()
    );
    assert_eq!(
        core.next_deadline(),
        start + IDLE_THRESHOLD + HEARTBEAT_INTERVAL
    );
}

/// M7.
#[test]
fn a_callers_command_is_answered_by_its_reply_or_its_timeout() {
    let (mut core, now) = core("app");
    let asked = core.command("display -p hi", Some("first"), now);
    let id = asked
        .reply_id()
        .expect("a caller's command is wrapped")
        .to_string();
    assert_eq!(asked.lines[1], "display -p hi");
    let mut answers = Vec::new();
    for event in [
        marked(&core, REPLY_BEGIN_MARKER, &id),
        response("hi"),
        marked(&core, REPLY_END_MARKER, &id),
    ] {
        answers.extend(core.step(event, now));
    }
    assert!(matches!(
        answers.as_slice(),
        [Action::Answer("first", reply)] if reply.output == "hi" && reply.error.is_none()
    ));

    core.command("display -p late", Some("second"), now);
    let expired = core.tick(now + REPLY_TIMEOUT);
    assert!(expired.iter().any(|a| matches!(
        a,
        Action::Answer("second", reply) if reply.error.as_deref() == Some("tmux did not answer in time")
    )));

    let lost = core.command("display -p lost", Some("third"), now);
    let failed = core.not_sent(&lost, "broken pipe");
    assert!(matches!(
        failed.as_slice(),
        [Action::Answer("third", reply), Action::Notify(Notice::Error(_))]
            if reply.error.as_deref() == Some("broken pipe")
    ));
}

#[test]
fn a_keystroke_goes_out_bare_and_a_refused_command_is_reported() {
    let (mut core, now) = core("app");
    let key = core.command("send-keys -t %1 x", None, now);
    assert_eq!(key.reply_id(), None);
    assert_eq!(key.lines, ["send-keys -t %1 x"]);

    let split = core.command("splitw -h", None, now);
    let id = split.reply_id().expect("a mutation is wrapped").to_string();
    let mut actions = Vec::new();
    for event in [
        marked(&core, REPLY_BEGIN_MARKER, &id),
        ControlModeEvent::CommandResponse {
            output: "no space for new pane".to_string(),
            success: false,
        },
        marked(&core, REPLY_END_MARKER, &id),
    ] {
        actions.extend(core.step(event, now));
    }
    assert!(matches!(
        actions.as_slice(),
        [Action::Notify(Notice::Error(e))] if e == "no space for new pane"
    ));
}

/// M2.
#[test]
fn a_command_settles_or_relists_as_its_commands_say() {
    let (mut core, now) = core("app");
    core.command(
        "run-shell \"TMUXY_EFFECT=settle bash x/pane-group add\"",
        None,
        now,
    );
    assert!(core.aggregator().is_settling());
    let reorder = core.command("select-window -t @1 ; movew -r", None, now);
    assert_eq!(
        reorder.relists,
        core.aggregator()
            .markers()
            .window_relist_commands()
            .to_vec()
    );
    assert!(core
        .command("send-keys -t %1 x", None, now)
        .relists
        .is_empty());
}

#[test]
fn the_connection_ends_on_exit_and_a_message_goes_to_the_person() {
    let (mut core, now) = core("app");
    let ended = core.step(
        ControlModeEvent::Exit {
            reason: Some("detached".to_string()),
        },
        now,
    );
    assert!(matches!(ended.as_slice(), [Action::Ended(Some(r))] if r == "detached"));
    let message = core.step(
        ControlModeEvent::Message {
            text: "build done".to_string(),
        },
        now,
    );
    assert!(
        matches!(message.as_slice(), [Action::Notify(Notice::Message(m))] if m == "build done")
    );
    let empty = core.step(
        ControlModeEvent::Message {
            text: String::new(),
        },
        now,
    );
    assert!(empty.is_empty());
}

/// M9. Creating a session anywhere fires `%session-changed` on every
/// control client.
#[test]
fn a_session_event_about_another_session_changes_nothing() {
    let (mut core, now) = core("app");
    let changed = |name: &str, id: &str| ControlModeEvent::SessionChanged {
        session_id: id.to_string(),
        session_name: name.to_string(),
    };
    let emits = |actions: &[Action<&str>]| actions.iter().any(|a| matches!(a, Action::Emit(_)));
    assert!(!emits(&core.step(changed("other", "$1"), now)));
    assert!(emits(&core.step(changed("app", "$0"), now)));
    let renamed = |id: &str, name: &str| ControlModeEvent::SessionRenamed {
        session_id: id.to_string(),
        name: name.to_string(),
    };
    assert!(!emits(&core.step(renamed("$1", "elsewhere"), now)));
    assert!(emits(&core.step(renamed("$0", "app2"), now)));
    assert!(!emits(&core.step(changed("other", "$1"), now)));
    assert_eq!(core.aggregator_mut().to_tmux_state().session_name, "app2");
}

#[test]
fn a_client_size_reaches_the_current_window_then_every_window() {
    let (mut early, now) = core("app");
    assert_eq!(
        sent(&early.set_client_size(41, 29)),
        ["resizew -x 41 -y 29"]
    );
    let (mut listed, _) = core("app");
    with_a_pane(&mut listed, now);
    assert_eq!(
        sent(&listed.set_client_size(41, 29)),
        ["resizew -t @0 -x 41 -y 29"]
    );
}
