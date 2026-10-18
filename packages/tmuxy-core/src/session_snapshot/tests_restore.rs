use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use super::tests_capture::{fixture, joined, window_line};
use super::*;
use crate::ids::test_ids::{gid, pid};

#[test]
fn a_restore_never_uses_new_window_and_applies_each_layout_after_its_splits() {
    let steps = plan(
        &fixture(),
        &RestoreOptions {
            run: false,
            fallback_cwd: "/home/x".into(),
            ..Default::default()
        },
    );
    let lines = joined(&steps);
    assert!(
        lines.iter().all(|l| !l.contains("new-window")),
        "{lines:#?}"
    );
    assert_eq!(lines[0], "run: new-session -d -s work -n main -c /tmp");
    // The float is split off window 0 and broken out at its index, by id.
    let i_split = lines
        .iter()
        .position(|l| l.starts_with("ask: split-window -d -t work:0 -c /tmp -P -F"))
        .unwrap();
    assert_eq!(
        lines[i_split + 1],
        "run: break-pane -d -s #PANE_W2# -t work:2 -n notes"
    );
    // Window 0's second pane, then its layout.
    let i_pane = lines
        .iter()
        .position(|l| l == "run: split-window -d -t work:0 -c /home/x")
        .unwrap();
    let i_layout = lines
        .iter()
        .position(|l| l.starts_with("run: select-layout -t work:0 "))
        .unwrap();
    assert!(i_pane < i_layout);
    // A one-pane window gets no layout.
    assert!(!lines
        .iter()
        .any(|l| l.starts_with("run: select-layout -t work:2")));
}

#[test]
fn a_vanished_directory_falls_back_without_failing_the_restore() {
    let steps = plan(
        &fixture(),
        &RestoreOptions {
            run: false,
            fallback_cwd: "/home/x".into(),
            ..Default::default()
        },
    );
    let lines = joined(&steps);
    assert!(lines.contains(&"run: split-window -d -t work:0 -c /home/x".to_string()));
}

#[test]
fn tags_come_back_and_the_float_parent_is_looked_up_by_index() {
    let lines = joined(&plan(&fixture(), &RestoreOptions::default()));
    assert!(lines.contains(&"run: set-option -w -t work:2 @tmuxy-window-type float".to_string()));
    assert!(lines.contains(&"run: set-option -w -t work:2 @tmuxy-float-width 100".to_string()));
    assert!(lines.contains(&"run: set-option -p -t work:0.0 @tmuxy-group-id g1".to_string()));
    let i_ask = lines
        .iter()
        .position(|l| l == "ask: display-message -p -t work:0 #{window_id}")
        .unwrap();
    assert_eq!(
        lines[i_ask + 1],
        "run: set-option -w -t work:2 @tmuxy-float-parent #WIN0#"
    );
}

/// A command is offered, not typed: hung on the pane as an `offer`
/// question for the client's banner, so nothing reaches a shell that is
/// still starting. `--run` types and runs it.
#[test]
fn commands_are_offered_not_typed_unless_asked() {
    let offered = joined(&plan(&fixture(), &RestoreOptions::default()));
    let vim = offer_payload("restore-0-1", "vim a");
    assert!(offered.contains(&format!("run: set-option -p -t work:0.1 @tmuxy-ask {vim}")));
    let browser = offer_payload("restore-2-0", "tmuxy browser");
    assert!(
        offered.contains(&format!(
            "run: set-option -p -t work:2.0 @tmuxy-ask {browser}"
        )),
        "the restore tag wins"
    );
    assert!(!offered.iter().any(|l| l.contains("send-keys -t work:0.1")));
    assert!(!offered.iter().any(|l| l.ends_with(" Enter")));
    let run = joined(&plan(
        &fixture(),
        &RestoreOptions {
            run: true,
            ..Default::default()
        },
    ));
    assert!(run.contains(&"run: send-keys -t work:0.1 -l vim a".to_string()));
    assert!(run.contains(&"run: send-keys -t work:0.1 Enter".to_string()));
    assert!(!run.iter().any(|l| l.contains("@tmuxy-ask")));
}

#[test]
fn an_offer_round_trips_through_its_payload() {
    let payload = offer_payload("restore-0-1", "claude --resume a, b");
    assert!(!payload.contains(','), "base64 rides a comma-split record");
    assert_eq!(
        offered_by(&payload).as_deref(),
        Some("claude --resume a, b")
    );
    // A send waiting on the user is a question, not an offer.
    use base64::Engine;
    let send = base64::engine::general_purpose::STANDARD
        .encode(r#"{"token":"t","caller":"claude","keys":["ls"]}"#);
    assert_eq!(offered_by(&send), None);
    assert_eq!(offered_by(""), None);
    assert_eq!(offered_by("not base64!"), None);
}

/// The second restart: a pane restored with an offer nobody answered is
/// at its shell, so `ps` finds nothing. The save still records the offer,
/// and the next restore offers it again.
#[test]
fn an_unanswered_offer_survives_the_next_save_and_restore() {
    let offer = offer_payload("restore-0-1", "htop -d 5");
    let windows = parse_windows("@1,0,1,,,,,,,,,,,,9c3a%2C80x24%2C0%2C0%2C5,main");
    let panes = parse_panes(&format!("%5,@1,0,1,100,/dev/ttys001,/tmp,,,,{offer}"));
    assert_eq!(panes[0].offer.as_deref(), Some("htop -d 5"));
    let snap = assemble("work", 1, windows, panes, &HashMap::new());
    let pane = &snap.windows[0].panes[0];
    assert_eq!(pane.offered_command().as_deref(), Some("htop -d 5"));
    let lines = joined(&plan(&snap, &RestoreOptions::default()));
    let again = offer_payload("restore-0-0", "htop -d 5");
    assert!(lines.contains(&format!(
        "run: set-option -p -t work:0.0 @tmuxy-ask {again}"
    )));
    // What is found running still wins over an old offer.
    let mut running = HashMap::new();
    running.insert(pid("%5"), vec!["vim".to_string()]);
    let panes = parse_panes(&format!("%5,@1,0,1,100,/dev/ttys001,/tmp,,,,{offer}"));
    let windows = parse_windows("@1,0,1,,,,,,,,,,,,9c3a%2C80x24%2C0%2C0%2C5,main");
    let snap = assemble("work", 1, windows, panes, &running);
    assert_eq!(
        snap.windows[0].panes[0].offered_command().as_deref(),
        Some("vim")
    );
    assert_eq!(
        snap.windows[0].panes[0].offer, None,
        "nothing stale is kept"
    );
}

/// A program's own word is offered AND written back as the pane's tag, so
/// a save after the restore still carries it; a sidebar's widget is run,
/// not offered, because it is tmuxy's own window.
#[test]
fn a_restore_keeps_the_programs_word_and_runs_the_chrome() {
    let mut snapshot = fixture();
    snapshot.windows.push(WindowSnapshot {
        index: 3,
        name: "__sidebar-left".into(),
        active: false,
        layout: "bd23,30x27,0,0,6".into(),
        window_type: Some("sidebar-left".into()),
        float_parent_index: None,
        options: BTreeMap::new(),
        panes: vec![PaneSnapshot {
            index: 0,
            active: true,
            cwd: "/tmp".into(),
            command: None,
            restore_command: Some(LEFT_SIDEBAR_WIDGET.into()),
            options: BTreeMap::new(),
            scrollback: None,
            offer: None,
        }],
    });
    let lines = joined(&plan(&snapshot, &RestoreOptions::default()));
    let i_tag = lines
        .iter()
        .position(|l| l == "run: set-option -p -t work:2.0 @tmuxy-pane-restore tmuxy browser")
        .expect("the browser pane's word is written back");
    assert_eq!(
        lines[i_tag + 1],
        format!(
            "run: set-option -p -t work:2.0 @tmuxy-ask {}",
            offer_payload("restore-2-0", "tmuxy browser")
        )
    );
    assert!(!lines.contains(&"run: send-keys -t work:2.0 Enter".to_string()));
    // A discovered command is not a tag: nothing is written for vim.
    assert!(!lines
        .iter()
        .any(|l| l.contains("-t work:0.1 @tmuxy-pane-restore")));
    // The sidebar's widget runs, and is not tagged.
    let i_widget = lines
        .iter()
        .position(|l| l == "run: send-keys -t work:3.0 -l tmuxy widget tree")
        .unwrap();
    assert_eq!(lines[i_widget + 1], "run: send-keys -t work:3.0 Enter");
    assert!(!lines
        .iter()
        .any(|l| l.contains("-t work:3.0 @tmuxy-pane-restore")));
}

/// A sidebar's pane says what the client runs there, never what `ps` saw
/// the widget sleeping in.
#[test]
fn a_sidebar_comes_back_as_its_widget_not_the_helper_it_sleeps_in() {
    let windows = parse_windows(&format!(
        "{}\n{}",
        window_line("@1", 0, true, "", "", "a1b2%2C80x24%2C0%2C0%2C5", "main"),
        window_line(
            "@2",
            1,
            false,
            "sidebar-left",
            "",
            "bd23%2C30x27%2C0%2C0%2C6",
            "__sidebar-left"
        )
    ));
    let panes =
        parse_panes("%5,@1,0,1,100,/dev/ttys001,/tmp,,,,\n%6,@2,0,1,200,/dev/ttys002,/tmp,,,,");
    let mut commands = HashMap::new();
    commands.insert(pid("%5"), vec!["vim".to_string()]);
    commands.insert(pid("%6"), vec!["sleep".to_string(), "3600".to_string()]);
    let snapshot = assemble("s", 1, windows, panes, &commands);
    assert_eq!(
        snapshot.windows[0].panes[0].command,
        Some(vec!["vim".to_string()])
    );
    let sidebar = &snapshot.windows[1].panes[0];
    assert_eq!(sidebar.command, None);
    assert_eq!(
        sidebar.restore_command.as_deref(),
        Some(LEFT_SIDEBAR_WIDGET)
    );
}

/// A restore holds the autosave, and its end is itself a change to save.
#[test]
fn a_restore_in_flight_holds_the_autosave_and_its_end_asks_for_one() {
    let keeper = SnapshotKeeper::new();
    let mut rx = keeper.dirty.subscribe();
    assert!(!keeper.restoring());
    keeper.restore_started();
    assert!(keeper.restoring());
    assert!(!rx.has_changed().unwrap());
    keeper.restore_finished();
    assert!(!keeper.restoring());
    assert!(rx.has_changed().unwrap(), "the restored shape is saved");
    rx.mark_unchanged();
}

/// A hidden member is parked beside its group's visible member, after the
/// group tag is on it, and gets its program offered like any pane.
#[test]
fn a_hidden_group_member_is_parked_beside_its_visible_member() {
    let lines = joined(&plan(
        &fixture(),
        &RestoreOptions {
            fallback_cwd: "/home/x".into(),
            ..Default::default()
        },
    ));
    let i_tag = lines
        .iter()
        .position(|l| l == "run: set-option -p -t work:0.0 @tmuxy-group-id g1")
        .unwrap();
    let i_park = lines
        .iter()
        .position(|l| l.starts_with("run: run-shell ") && l.contains("pane-group-park"))
        .expect("the member is parked");
    assert!(i_tag < i_park, "{lines:#?}");
    // `/srv` is the member's directory; where it is gone, the fallback.
    let dir = if Path::new("/srv").is_dir() {
        "/srv"
    } else {
        "/home/x"
    };
    // The park prints the new pane's id into a server option, not through
    // run-shell (which tmux 3.4 shows in view-mode); it is read back as
    // the answer and cleared.
    assert!(
        lines[i_park].contains(&format!(
            "set-option -g @tmuxy-restore-answer \"$(bash {} work:0.0 g1 {dir} 2>&1)\"; true",
            park_script()
        )),
        "{}",
        lines[i_park]
    );
    assert_eq!(
        lines[i_park + 1],
        "ask: show-options -gv @tmuxy-restore-answer"
    );
    assert_eq!(
        lines[i_park + 2],
        "run: set-option -gu @tmuxy-restore-answer"
    );
    assert_eq!(
        lines[i_park + 3],
        format!(
            "run: set-option -p -t #HID0# @tmuxy-ask {}",
            offer_payload("restore-HID0", "htop")
        )
    );
    // Window 0 gets its layout back after the park.
    assert!(lines[i_park + 4..]
        .iter()
        .any(|l| l.starts_with("run: select-layout -t work:0 ")));
}

/// A reordered group comes back in its order: the visible member's place
/// as a pane option, a parked member's as the park step's last argument.
#[test]
fn a_reordered_group_is_restored_in_its_order() {
    let mut snap = fixture();
    for w in &mut snap.windows {
        for p in &mut w.panes {
            if p.options.contains_key("@tmuxy-group-id") {
                p.options
                    .insert("@tmuxy-group-pos".to_string(), "1".to_string());
            }
        }
    }
    for h in &mut snap.hidden {
        h.position = Some(0);
    }
    let lines = joined(&plan(
        &snap,
        &RestoreOptions {
            fallback_cwd: "/home/x".into(),
            ..Default::default()
        },
    ));
    assert!(
        lines
            .iter()
            .any(|l| l == "run: set-option -p -t work:0.0 @tmuxy-group-pos 1"),
        "{lines:#?}"
    );
    let park = lines
        .iter()
        .find(|l| l.contains("pane-group-park"))
        .expect("the member is parked");
    assert!(park.contains(" 0 2>&1)"), "{park}");
}

/// Only this session's groups: a stash pane of another session's group,
/// or the stash's own placeholder, is not this session's member.
#[test]
fn only_members_of_this_sessions_groups_are_recorded_hidden() {
    let snap = fixture();
    let stash = parse_panes(
        "%9,@20,0,1,900,/dev/ttys009,/srv,,g1,,\n\
         %3,@21,0,1,300,/dev/ttys003,/opt,claude --resume x,g1,,\n\
         %7,@22,0,1,700,/dev/ttys007,/x,,g8,,\n\
         %1,@1,0,1,100,/dev/ttys001,/,,,,",
    );
    let mut commands = HashMap::new();
    commands.insert(pid("%9"), vec!["htop".to_string()]);
    let hidden = hidden_members(&snap, &stash, &commands);
    assert_eq!(
        hidden,
        vec![
            HiddenMember {
                group_id: gid("g1"),
                position: None,
                cwd: "/opt".into(),
                command: None,
                restore_command: Some("claude --resume x".into()),
                offer: None,
            },
            HiddenMember {
                group_id: gid("g1"),
                position: None,
                cwd: "/srv".into(),
                command: Some(vec!["htop".into()]),
                restore_command: None,
                offer: None,
            },
        ],
        "pane-id order, other groups and the placeholder left out"
    );
}
