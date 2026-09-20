//! The settings the frontend cannot work without are enforced on connect.
//!
//! `enforce_settings` (in `control_mode/monitor.rs`) sets a handful of tmux
//! options on the attached session every time a monitor connects, whatever the
//! user's `tmux.conf` says. They are invariants, not preferences: without
//! `pane-border-status top` a pane at y=0 loses a row of content to the header
//! tmuxy draws over the border row; without `mouse on` clicking a pane does not
//! focus it; without `allow-passthrough` hyperlinks and images never reach the
//! client. A config that turns any of them off used to win, and the UI came up
//! subtly broken with nothing to point at.
//!
//! The options are read back through the monitor's own reply channel — the only
//! way to read from tmux while a control-mode client is attached.
//!
//! Needs a `tmux` binary; the socket name is unique per process.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::control_mode::{
    CommandReply, LogSink, MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor,
};
use tmuxy_core::{executor, Ctx, StateUpdate};

/// Keeps what the monitor reports so a failure can say what went wrong.
#[derive(Default)]
struct Recorder {
    errors: std::sync::Mutex<Vec<String>>,
}
impl LogSink for Recorder {}
impl StateEmitter for Recorder {
    fn emit_state(&self, _update: StateUpdate) {}
    fn emit_error(&self, error: String) {
        self.errors.lock().unwrap().push(error);
    }
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

/// Value of a session option as tmux reports it for the session under test.
async fn option(tx: &tokio::sync::mpsc::Sender<MonitorCommand>, name: &str) -> String {
    let reply = ask(tx, &format!("show-options -t app -v {name}")).await;
    assert_eq!(reply.error, None, "show-options {name} succeeded");
    reply.output.trim_end_matches('\n').to_string()
}

#[tokio::test]
async fn connecting_enforces_the_settings_the_layout_depends_on() {
    let socket = format!("tmuxy-enforced-settings-{}", std::process::id());
    std::env::set_var("TMUX_SOCKET", &socket);

    executor::execute_tmux_command(&["new-session", "-d", "-s", "app", "sleep", "60"]).unwrap();

    // A session configured exactly the wrong way round, the way a user's
    // tmux.conf leaves it. Every one of these must be overridden on connect.
    for (key, value) in [
        ("pane-border-status", "off"),
        ("mouse", "off"),
        ("focus-events", "off"),
        ("allow-passthrough", "off"),
        ("allow-rename", "off"),
        ("set-titles", "off"),
    ] {
        executor::execute_tmux_command(&["set-option", "-t", "app", key, value]).unwrap();
    }
    executor::execute_tmux_command(&["set-window-option", "-t", "app", "aggressive-resize", "on"])
        .unwrap();

    let config = MonitorConfig {
        session: "app".to_string(),
        create_session: false,
        ..Default::default()
    };
    let (mut monitor, tx) = TmuxMonitor::connect(config, None, Ctx::live())
        .await
        .expect("control-mode connection on the scratch socket");
    let recorder = std::sync::Arc::new(Recorder::default());
    let runner = {
        let recorder = std::sync::Arc::clone(&recorder);
        tokio::spawn(async move { monitor.run(&*recorder).await })
    };

    // The load-bearing one: PaneLayout reserves the border row for its header,
    // so a pane at y=0 renders one row short when this is not `top`.
    assert_eq!(option(&tx, "pane-border-status").await, "top");

    // The border row is blank so nothing of tmux's own shows through the header.
    assert!(
        option(&tx, "pane-border-format").await.trim().is_empty(),
        "the border row is drawn empty"
    );

    for key in [
        "mouse",
        "focus-events",
        "allow-passthrough",
        "allow-rename",
        "set-titles",
    ] {
        assert_eq!(option(&tx, key).await, "on", "{key} is enforced on");
    }

    let aggressive = ask(&tx, "show-window-options -t app -v aggressive-resize").await;
    assert_eq!(aggressive.error, None);
    assert_eq!(
        aggressive.output.trim(),
        "off",
        "tmuxy manages sizing itself"
    );

    assert!(
        recorder.errors.lock().unwrap().is_empty(),
        "no setting was rejected: {:?}",
        recorder.errors.lock().unwrap()
    );

    tx.send(MonitorCommand::Shutdown).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), runner).await;
    let _ = executor::execute_tmux_command(&["kill-server"]);
}
