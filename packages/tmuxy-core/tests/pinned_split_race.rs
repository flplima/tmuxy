//! A pinned command keeps its pin under a concurrent `select-window`.
//!
//! The frontend pins every command to the tab the user is looking at:
//! `select-window -t @B ; select-pane -t %b ; split-window -h`. The desktop
//! transport used to run that list as an external subprocess and inject
//! `-t <session>` into the untargeted `split-window`. A session target is
//! resolved late, against the session's *current* window, so any other
//! client's `select-window` landing between the pin and the split moved the
//! split to the wrong tab — which tmuxy's own monitor does constantly.
//!
//! Sent byte-identical down the control-mode connection, the untargeted
//! `split-window` inherits the queue's current target from the pin and holds
//! it even while another client switches windows mid-list. This test forces
//! the race (a `run-shell sleep` inside the pinned list, an external
//! `select-window` during it) and expects the pin to hold. It fails against
//! the old path, which is the point.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Mutex;
use std::time::Duration;

use tmuxy_core::control_mode::{
    CommandReply, LogSink, MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor,
};
use tmuxy_core::{executor, Ctx, StateUpdate};

#[derive(Default)]
struct Quiet {
    errors: Mutex<Vec<String>>,
}
impl LogSink for Quiet {}
impl StateEmitter for Quiet {
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
    .unwrap();
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .expect("reply within the deadline")
        .expect("monitor answered")
}

async fn panes_in(tx: &tokio::sync::mpsc::Sender<MonitorCommand>, window: &str) -> usize {
    ask(tx, &format!("list-panes -t {window} -F '#{{pane_id}}'"))
        .await
        .output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count()
}

#[tokio::test]
async fn a_pinned_split_survives_a_concurrent_select_window() {
    let socket = format!("tmuxy-pin-race-{}", std::process::id());
    std::env::set_var("TMUX_SOCKET", &socket);

    let config = MonitorConfig {
        session: "app".to_string(),
        create_session: true,
        ..Default::default()
    };
    let (mut monitor, tx) = TmuxMonitor::connect(config, None, Ctx::live())
        .await
        .expect("control-mode connection on the scratch socket");
    let runner = tokio::spawn(async move {
        let emitter = Quiet::default();
        monitor.run(&emitter).await;
    });

    // Two windows. tmux's current window is the first; the pin names the second.
    ask(&tx, "new-window -d").await;
    let listing = ask(&tx, "list-windows -F '#{window_id} #{pane_id}'").await;
    let rows: Vec<Vec<&str>> = listing
        .output
        .lines()
        .map(|l| l.split_whitespace().collect())
        .collect();
    assert_eq!(rows.len(), 2, "two windows: {}", listing.output);
    let (first_window, second_window, second_pane) = (rows[0][0], rows[1][0], rows[1][1]);
    ask(&tx, &format!("select-window -t {first_window}")).await;
    assert_eq!(panes_in(&tx, second_window).await, 1);

    // The pinned split, stalled between its pin and its split so the other
    // client is certain to land in between.
    let pinned = format!(
        "select-window -t {second_window} \\; select-pane -t {second_pane} \\; run-shell 'sleep 1' \\; split-window -h"
    );
    tx.send(MonitorCommand::RunCommand { command: pinned })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Another client — the way tmuxy's own monitor, or a user switching tabs,
    // does all the time — moves the session's current window.
    executor::execute_tmux_command(&["select-window", "-t", first_window]).unwrap();

    // Let the stalled list finish.
    tokio::time::sleep(Duration::from_millis(1500)).await;

    assert_eq!(
        panes_in(&tx, second_window).await,
        2,
        "the split must land on the PINNED window"
    );
    assert_eq!(
        panes_in(&tx, first_window).await,
        1,
        "and never on the window tmux happened to be on"
    );

    tx.send(MonitorCommand::Shutdown).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), runner).await;
    let _ = executor::execute_tmux_command(&["kill-server"]);
}
