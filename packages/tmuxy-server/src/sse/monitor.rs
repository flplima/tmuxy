use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::control_mode::{MonitorCommandSender, MonitorConfig};
use tmuxy_core::session_snapshot::SnapshotKeeper;
use tmuxy_core::transport::{self, Attempt, Ended, GaveUp, Host, Task};
use tmuxy_core::{executor, TmuxError};
use tracing::{debug, error, info, warn};

use super::clients::{monitor_config, session_exists};
use super::emitter::{encode_event, SseEmitter, SseEvent};
use crate::state::{AppState, SessionBroadcast};

// ============================================
// Monitoring (Control Mode)
// ============================================

/// A connection that lived this long worked; a shorter one is a startup crash
/// to count against the session.
const MIN_HEALTHY_RUN: Duration = Duration::from_secs(2);

/// Run the session's monitor until its last client leaves, its session is
/// destroyed, the server shuts down, or tmux refuses it too many times
/// (`tmuxy_core::transport::supervise`).
pub async fn start_monitoring(
    broadcast: Arc<SessionBroadcast>,
    session: String,
    state: Arc<AppState>,
) {
    let keeper = Arc::new(SnapshotKeeper::new());
    let emitter = Arc::new(SseEmitter::new(
        broadcast.clone(),
        Arc::clone(&state),
        session.clone(),
        keeper.clone(),
    ));
    let host = ServerHost {
        config: monitor_config(&session),
        broadcast,
        session,
        state,
        first_connect: true,
    };
    transport::supervise(host, emitter, keeper, MIN_HEALTHY_RUN).await;
}

/// What the web server does around the monitor loop: a session's monitor
/// lives while clients watch it.
struct ServerHost {
    config: MonitorConfig,
    broadcast: Arc<SessionBroadcast>,
    session: String,
    state: Arc<AppState>,
    first_connect: bool,
}

impl ServerHost {
    async fn forget_session(&self) {
        let mut sessions = self.state.sessions.write().await;
        sessions.remove(&self.session);
    }

    async fn has_clients(&self) -> bool {
        let sessions = self.state.sessions.read().await;
        sessions
            .get(&self.session)
            .is_some_and(|conns| !conns.connections.is_empty())
    }

    /// Tell every client the monitor has given up, and forget the session so
    /// a fresh monitor can start next time.
    async fn fatal(&self, message: &str) {
        if let Some(encoded) = encode_event(&SseEvent::Fatal {
            message: message.to_string(),
        }) {
            self.broadcast.broadcast(encoded);
        }
        error!(session = %self.session, msg = %message, "monitor FATAL");
        self.forget_session().await;
    }
}

impl Host for ServerHost {
    async fn before_attempt(&mut self, ever_ran: bool) -> Attempt {
        let session = &self.session;
        // Server shutdown signalled — exit promptly instead of reconnecting.
        if self.state.shutdown.is_cancelled() {
            info!(%session, "shutdown signalled, stopping monitor loop");
            self.forget_session().await;
            return Attempt::Stop;
        }

        if !self.has_clients().await {
            info!(%session, "no clients, stopping monitor loop");
            self.forget_session().await;
            return Attempt::Stop;
        }

        // On reconnect (not first connect), check if the tmux session still
        // exists. If it was intentionally destroyed (by test cleanup or user)
        // AND we had a successful run before, stop the monitor loop. If the
        // session died before ever running successfully (crash on startup),
        // retry with create_session=true to recreate it.
        let mut config = self.config.clone();
        if !self.first_connect {
            if session_exists(session).await {
                config.create_session = false;
            } else if ever_ran {
                info!(%session, "tmux session no longer exists, stopping monitor loop");
                return Attempt::Stop;
            } else {
                warn!(%session, "tmux session died before running, will recreate");
                config.create_session = true;
            }
        }
        self.first_connect = false;
        Attempt::Connect(config)
    }

    async fn session_exists(&self, session: &str) -> bool {
        session_exists(session).await
    }

    /// Route the `new-session -d` through an existing monitor's CC connection
    /// when there is one. Running external `tmux new-session -d` while a CC
    /// client is attached crashes tmux 3.5a; routing through CC avoids this.
    async fn create_session(&mut self, config: &mut MonitorConfig) {
        let session = &self.session;
        // Only a peer whose tmux session actually EXISTS can run the command:
        // the map also holds sessions that are themselves still being created,
        // and two of those pick each other as courier and both wait out the
        // full poll below, every round, forever.
        //
        // Nor a peer nobody is watching: its last client left and it is in the
        // grace period before its monitor detaches, and a session made through
        // it is born to a connection that closes a second later. With no
        // watched peer, the direct `-CC new-session` is the path. (A
        // courier-made session's shell has printed before our monitor
        // attaches, so its content arrives in the very first states — which
        // is what exposed the client's initial-state race, `adoptInitialState`
        // in tmuxy-ui's deltaProtocol.ts.)
        let candidates: Vec<(String, MonitorCommandSender, usize)> = {
            let sessions = self.state.sessions.read().await;
            sessions
                .iter()
                .filter(|(name, _)| *name != session)
                .filter(|(_, conns)| !conns.connections.is_empty())
                .filter_map(|(name, conns)| {
                    conns
                        .monitor_command_tx
                        .clone()
                        .map(|tx| (name.clone(), tx, conns.connections.len()))
                })
                .collect()
        };
        let mut courier = None;
        for (name, tx, viewers) in candidates {
            if session_exists(&name).await {
                courier = Some((name, tx, viewers));
                break;
            }
        }
        // Which way a session is born is one of the few things that differs
        // between one that comes up and one whose pane stays blank, so the
        // trace keeps it (docs/TRACING.md, pane lifecycle).
        let Some((via_session, tx, viewers)) = courier else {
            debug!(%session, via = "direct", viewers = 0usize, "session creation path");
            return;
        };
        debug!(%session, via = "courier", viewers, "session creation path");

        let working_dir = config
            .working_dir
            .as_ref()
            .map(|d| format!(" -c {}", executor::tmux_quote(&d.display().to_string())))
            .unwrap_or_default();
        let first_window = config
            .first_window
            .as_ref()
            .map(|(name, cwd)| {
                format!(
                    " -n {} -c {}",
                    executor::tmux_quote(name),
                    executor::tmux_quote(cwd)
                )
            })
            .unwrap_or_default();
        let create_cmd = format!(
            "new-session -d -s {} -x {} -y {}{}{}",
            executor::tmux_quote(session),
            tmuxy_core::control_mode::INITIAL_PTY_COLS,
            tmuxy_core::control_mode::INITIAL_PTY_ROWS,
            working_dir,
            first_window
        );
        info!(%session, %via_session, "creating session via existing CC client");
        let _ = tx
            .send(tmuxy_core::control_mode::MonitorCommand::RunCommand {
                command: create_cmd,
            })
            .await;
        // Wait for the session to actually exist before attaching CC. The
        // RunCommand is async — it goes through the monitor's event loop and
        // then tmux processes it. Poll has-session to confirm.
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if session_exists(session).await {
                info!(%session, "session created successfully via CC");
                // Session exists, just attach (no creation needed).
                config.create_session = false;
                return;
            }
        }
        warn!(%session, "session creation via CC timed out, falling back to direct creation");
    }

    async fn connected(&mut self, tx: MonitorCommandSender, keeper: Arc<SnapshotKeeper>) -> bool {
        // Store command_tx so cleanup_connection can send Shutdown.
        let mut sessions = self.state.sessions.write().await;
        let Some(conns) = sessions.get_mut(&self.session) else {
            // Session was cleaned up between connect and now.
            warn!(session = %self.session, "session gone before storing command_tx, stopping");
            return false;
        };
        debug!(session = %self.session, "storing command_tx");
        conns.monitor_command_tx = Some(tx);
        conns.snapshot_keeper = Some(keeper);
        true
    }

    async fn ended(&mut self) -> Ended {
        let mut sessions = self.state.sessions.write().await;
        if let Some(conns) = sessions.get_mut(&self.session) {
            conns.monitor_command_tx = None;
        }
        Ended::Judge
    }

    /// `SessionNotFound` after the session was already destroyed (an external
    /// `tmux kill-session`) means the user intentionally tore it down: stop
    /// instead of looping forever trying to attach. Everything else is counted
    /// and retried.
    async fn connect_failed(&mut self, error: &TmuxError, ever_ran: bool) -> Option<Attempt> {
        if !matches!(error, TmuxError::SessionNotFound { .. }) {
            return None;
        }
        if ever_ran {
            info!(session = %self.session, %error, "session destroyed externally, stopping monitor loop");
            self.forget_session().await;
            return Some(Attempt::Stop);
        }
        None
    }

    async fn gave_up(&mut self, message: String) -> GaveUp {
        self.fatal(&message).await;
        GaveUp::Stop
    }

    async fn spawn(&self, task: Task) {
        self.state.spawn(task).await;
    }

    /// Cancellable: Ctrl+C during a retry shouldn't have to wait out the full
    /// sleep before the next loop iteration sees the cancellation.
    async fn sleep(&self, duration: Duration) {
        tokio::select! {
            _ = tokio::time::sleep(duration) => {}
            _ = self.state.shutdown.cancelled() => {}
        }
    }
}
