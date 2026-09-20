//! A client's baseline reports the scrollback a pane really has.
//!
//! Copy mode asks the server for `start: -historySize .. height-1`. When the
//! initial state reported `history_size: 0` for every pane — the polling-mode
//! `list-panes` format string omitted `#{history_size}`, and the capture
//! hardcoded it — that range collapsed to the visible band, so scrolling up in
//! a pane with thousands of lines behind it showed nothing until a later
//! control-mode delta happened to deliver the real number.
//!
//! This is a server-side contract, so it is tested here rather than through a
//! browser: the state the monitor answers `GetState` with, which is what every
//! fresh client's `get_initial_state` returns.
//!
//! Needs a `tmux` binary; the socket name is unique per process.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::control_mode::{LogSink, MonitorCommand, MonitorConfig, StateEmitter, TmuxMonitor};
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

#[tokio::test]
async fn the_initial_state_reports_the_scrollback_a_pane_already_has() {
    let socket = format!("tmuxy-initial-history-{}", std::process::id());
    std::env::set_var("TMUX_SOCKET", &socket);

    // Far more lines than any window is tall, so tmux has real history to
    // report, and the pane stays alive afterwards.
    executor::execute_tmux_command(&[
        "new-session",
        "-d",
        "-s",
        "app",
        "i=1; while [ $i -le 400 ]; do echo HISTMARK_$i; i=$((i+1)); done; sleep 60",
    ])
    .unwrap();

    // Let the loop finish writing before the monitor reads list-panes.
    tokio::time::sleep(Duration::from_secs(2)).await;

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

    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::GetState { reply }).await.unwrap();
    let state = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .unwrap_or_else(|_| {
            panic!(
                "the initial state arrives; errors: {:?}",
                recorder.errors.lock().unwrap()
            )
        })
        .expect("the monitor answered");

    assert_eq!(state.panes.len(), 1, "one pane: {:?}", state.panes);
    let pane = &state.panes[0];
    assert!(
        pane.history_size > 0,
        "the baseline carries the pane's scrollback, not a hardcoded 0 (history_size = {}, pane height = {})",
        pane.history_size,
        pane.height
    );
    // 400 lines into a window far shorter than that: most of them are history.
    assert!(
        pane.history_size >= u64::from(pane.height),
        "history_size {} is at least a screenful behind the {}-row viewport",
        pane.history_size,
        pane.height
    );

    tx.send(MonitorCommand::Shutdown).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), runner).await;
    let _ = executor::execute_tmux_command(&["kill-server"]);
}
