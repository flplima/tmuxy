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

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tmuxy_core::control_mode::{
    CommandReply, LogSink, MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor,
};
use tmuxy_core::{executor, Ctx, StateUpdate};

/// Keeps every emitted state so the test can look at the last full snapshot.
#[derive(Default)]
struct Recorder {
    updates: Mutex<Vec<StateUpdate>>,
    errors: Mutex<Vec<String>>,
}

impl LogSink for Recorder {}

impl StateEmitter for Recorder {
    fn emit_state(&self, update: StateUpdate) {
        self.updates.lock().unwrap().push(update);
    }
    fn emit_error(&self, error: String) {
        self.errors.lock().unwrap().push(error);
    }
}

/// Pane count of the newest full snapshot the monitor emitted.
fn panes_in_last_full(recorder: &Recorder) -> Option<usize> {
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

async fn ask(tx: &tokio::sync::mpsc::Sender<MonitorCommand>, command: &str) -> CommandReply {
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::RunCommandWithReply {
        command: command.to_string(),
        reply,
    })
    .await
    .expect("monitor accepts commands");
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .expect("a reply arrives within the deadline")
        .expect("the monitor answers rather than dropping the request")
}

#[tokio::test]
async fn replies_come_back_from_a_live_control_mode_connection() {
    let socket = format!("tmuxy-reply-test-{}", std::process::id());
    // The whole crate resolves its socket from this; one test per binary, so
    // there is nothing to race.
    std::env::set_var("TMUX_SOCKET", &socket);

    let session = "app";
    let config = MonitorConfig {
        session: session.to_string(),
        create_session: true,
        ..Default::default()
    };
    let (mut monitor, tx) = TmuxMonitor::connect(config, None, Ctx::live())
        .await
        .expect("a control-mode connection on the scratch socket");

    // A second session with more panes than ours: the rows a `list-panes -a`
    // query prints for it are the ones that must not leak into our state.
    executor::execute_tmux_command(&["new-session", "-d", "-s", "other"]).unwrap();
    executor::execute_tmux_command(&["split-window", "-t", "other"]).unwrap();
    executor::execute_tmux_command(&["split-window", "-t", "other"]).unwrap();

    let recorder = Arc::new(Recorder::default());
    let runner = {
        let recorder = Arc::clone(&recorder);
        tokio::spawn(async move { monitor.run(&*recorder).await })
    };

    // 1. Output comes back.
    let hello = ask(&tx, "display-message -p HELLO_FROM_TMUX").await;
    assert_eq!(hello.error, None, "a plain display-message succeeds");
    assert_eq!(hello.output.trim(), "HELLO_FROM_TMUX");

    // 2. A failure is reported, not waited on: the list aborts at the bad
    //    command, and the END marker on its own line still closes the reply.
    let failed = ask(
        &tx,
        "display-message -p FIRST \\; kill-window -t @999 \\; display-message -p NEVER",
    )
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
    let all = ask(&tx, "list-panes -a -F '#{pane_id},#{session_name}'").await;
    assert_eq!(all.error, None);
    let other_rows = all.output.lines().filter(|l| l.ends_with(",other")).count();
    assert_eq!(
        other_rows, 3,
        "the query saw the other session's panes: {}",
        all.output
    );

    // Sequence a state emission behind the query, then look at what the
    // monitor believes this session has.
    let _ = ask(&tx, "display-message -p SYNC").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        panes_in_last_full(&recorder),
        Some(1),
        "the other session's rows must not have become panes of this one"
    );
    assert!(
        recorder.errors.lock().unwrap().is_empty(),
        "no errors were emitted: {:?}",
        recorder.errors.lock().unwrap()
    );

    // 4. A fire-and-forget mutation that tmux rejects is reported through the
    //    emitter — the only way a user learns why a split did nothing — while
    //    a rejected keystroke is not (a vanished pane is already visible).
    tx.send(MonitorCommand::RunCommand {
        command: "send-keys -t %999 -l x".to_string(),
    })
    .await
    .unwrap();
    tx.send(MonitorCommand::RunCommand {
        command: "kill-window -t @999".to_string(),
    })
    .await
    .unwrap();
    let _ = ask(&tx, "display-message -p SYNC").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        *recorder.errors.lock().unwrap(),
        vec!["can't find window: @999".to_string()],
        "the rejected mutation is reported, the rejected keystroke is not"
    );

    tx.send(MonitorCommand::Shutdown).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), runner).await;
    let _ = executor::execute_tmux_command(&["kill-server"]);
}
