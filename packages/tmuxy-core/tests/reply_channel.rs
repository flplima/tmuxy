//! The control-mode reply channel against a real tmux.
//!
//! `RunCommandWithReply` is the one way tmuxy reads from tmux while its
//! control-mode client is attached. This drives a live `tmux -CC` monitor on a
//! scratch socket and checks the three things the design rests on: a reply
//! comes back with the command's output; a failing command comes back as a
//! failure rather than hanging (tmux stops a command list at the first error,
//! which is why the closing marker is its own line); and a `list-panes -a`
//! query — whose rows look exactly like the aggregator's own poll — reaches the
//! caller without conjuring another session's panes into this one.
//!
//! Needs a `tmux` binary, like the rest of the workspace's tests on CI. The
//! socket name is unique per process so it cannot touch a real session.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::control_mode::MonitorCommand;
use tmuxy_core::StateUpdate;

mod common;

/// Pane count of the newest full snapshot the monitor emitted.
fn panes_in_last_full(recorder: &common::Recorder) -> Option<usize> {
    recorder
        .updates
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find_map(|u| match u {
            StateUpdate::Full { state } => Some(state.panes.len()),
            StateUpdate::Delta { .. } => None,
        })
}

#[tokio::test]
async fn replies_come_back_from_a_live_control_mode_connection() {
    let server = common::ScratchServer::process_wide("reply-test");
    let monitor = server.attach("app", true).await;

    // A second session with more panes than ours: the rows a `list-panes -a`
    // query prints for it are the ones that must not leak into our state.
    common::tmux(&["new-session", "-d", "-s", "other"]).unwrap();
    common::tmux(&["split-window", "-t", "other"]).unwrap();
    common::tmux(&["split-window", "-t", "other"]).unwrap();

    // 1. Output comes back.
    let hello = monitor.ask("display-message -p HELLO_FROM_TMUX").await;
    assert_eq!(hello.error, None, "a plain display-message succeeds");
    assert_eq!(hello.output.trim(), "HELLO_FROM_TMUX");

    // 2. A failure is reported, not waited on: the list aborts at the bad
    //    command, and the END marker on its own line still closes the reply.
    let failed = monitor
        .ask("display-message -p FIRST ; kill-window -t @999 ; display-message -p NEVER")
        .await;
    assert_eq!(
        failed.error.as_deref(),
        Some("can't find window: @999"),
        "an errored block fails the reply with tmux's message"
    );
    assert!(
        failed.output.contains("FIRST"),
        "output before the failure is kept"
    );
    assert!(
        !failed.output.contains("NEVER"),
        "tmux stopped the list at the error"
    );

    // 3. A query shaped like the aggregator's own poll reaches the caller
    //    whole, and none of it becomes state.
    let all = monitor
        .ask("list-panes -a -F '#{pane_id},#{session_name}'")
        .await;
    assert_eq!(all.error, None);
    let other_rows = all.output.lines().filter(|l| l.ends_with(",other")).count();
    assert_eq!(
        other_rows, 3,
        "the query saw the other session's panes: {}",
        all.output
    );

    // Sequence a state emission behind the query, then look at what the
    // monitor believes this session has.
    let _ = monitor.ask("display-message -p SYNC").await;
    common::wait_until("a full snapshot", Duration::from_secs(10), || async {
        panes_in_last_full(&monitor.recorder).is_some()
    })
    .await;
    assert_eq!(
        panes_in_last_full(&monitor.recorder),
        Some(1),
        "the other session's rows must not have become panes of this one"
    );
    assert_eq!(
        monitor.errors(),
        Vec::<String>::new(),
        "no errors were emitted"
    );

    // 4. A fire-and-forget mutation that tmux rejects is reported through the
    //    emitter — the only way a user learns why a split did nothing — while
    //    a rejected keystroke is not (a vanished pane is already visible).
    monitor
        .send(MonitorCommand::RunCommand {
            command: "send-keys -t %999 -l x".to_string(),
        })
        .await;
    monitor
        .send(MonitorCommand::RunCommand {
            command: "kill-window -t @999".to_string(),
        })
        .await;
    let _ = monitor.ask("display-message -p SYNC").await;
    // The keystroke went first, so its error — had there been one — would be
    // in the list ahead of the window's by the time that one has arrived.
    common::wait_until(
        "the rejected mutation to be reported",
        Duration::from_secs(10),
        || async { !monitor.errors().is_empty() },
    )
    .await;
    assert_eq!(
        monitor.errors(),
        vec!["can't find window: @999".to_string()],
        "the rejected mutation is reported, the rejected keystroke is not"
    );
}
