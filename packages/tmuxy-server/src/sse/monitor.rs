use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::control_mode::{MonitorCommandSender, MonitorConfig};
use tmuxy_core::host::{self, Attempt, Ended, GaveUp, Host, HostEvent, SessionRuntime, Task};
use tmuxy_core::{executor, TmuxError};
use tracing::{debug, error, info, warn};

use crate::state::AppState;

/// Run the session's monitor until its last client leaves, its session is
/// destroyed, the server shuts down, or tmux refuses it too many times
/// (`tmuxy_core::host::supervise`).
pub async fn start_monitoring(
    runtime: Arc<SessionRuntime>,
    session: String,
    state: Arc<AppState>,
    create_session: bool,
) {
    let host = ServerHost {
        config: host::monitor_config(&session, create_session),
        runtime: Arc::clone(&runtime),
        session,
        state,
        first_connect: true,
    };
    host::supervise(host, runtime).await;
}

/// What the web server does around the monitor loop: a session's monitor
/// lives while clients watch it.
pub(super) struct ServerHost {
    pub(super) config: MonitorConfig,
    pub(super) runtime: Arc<SessionRuntime>,
    pub(super) session: String,
    pub(super) state: Arc<AppState>,
    pub(super) first_connect: bool,
}

impl ServerHost {
    async fn forget_session(&self) {
        let mut sessions = self.state.sessions.write().await;
        sessions.remove(&self.session);
    }

    /// Forget the session if no client is watching it, under one lock, so a
    /// client registering between the check and the removal is not left on
    /// an orphaned broadcast with no monitor.
    async fn stop_if_idle(&self) -> bool {
        let mut sessions = self.state.sessions.write().await;
        let watched = sessions
            .get(&self.session)
            .is_some_and(|conns| !conns.connections.is_empty());
        if !watched {
            sessions.remove(&self.session);
        }
        !watched
    }

    /// Tell every client the monitor has given up, and forget the session so
    /// a fresh monitor can start next time.
    async fn fatal(&self, message: &str) {
        self.runtime.emit(HostEvent::Fatal {
            message: message.to_string(),
        });
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

        if !self.first_connect && self.stop_if_idle().await {
            info!(%session, "no clients, stopping monitor loop");
            return Attempt::Stop;
        }

        // On reconnect (not first connect), check if the tmux session still
        // exists. If it was intentionally destroyed (by test cleanup or user)
        // AND we had a successful run before, stop the monitor loop. If the
        // session died before ever running successfully (crash on startup)
        // and this monitor was started to create it, retry with
        // create_session=true to recreate it.
        let mut config = self.config.clone();
        if !self.first_connect {
            if host::session_exists(session).await {
                config.create_session = false;
            } else if ever_ran || !self.config.create_session {
                // A monitor started for a session that existed (`GET /events`)
                // never creates it: only `ensure_session` does, under its cap.
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
                        .runtime
                        .tx_now()
                        .map(|tx| (name.clone(), tx, conns.connections.len()))
                })
                .collect()
        };
        let mut courier = None;
        for (name, tx, viewers) in candidates {
            if host::session_exists(&name).await {
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
        if tx
            .send(tmuxy_core::control_mode::MonitorCommand::RunCommand {
                command: create_cmd,
            })
            .await
            .is_err()
        {
            warn!(%session, %via_session, "the courier's monitor is gone, creating directly");
            return;
        }
        // Wait for the session to actually exist before attaching CC. The
        // RunCommand is async — it goes through the monitor's event loop and
        // then tmux processes it. Poll has-session to confirm.
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if host::session_exists(session).await {
                info!(%session, "session created successfully via CC");
                // Session exists, just attach (no creation needed).
                config.create_session = false;
                return;
            }
        }
        warn!(%session, "session creation via CC timed out, falling back to direct creation");
    }

    /// The session may have been cleaned up between the connect and now.
    async fn connected(&mut self) -> bool {
        let watched = self.state.sessions.read().await.contains_key(&self.session);
        if !watched {
            warn!(session = %self.session, "session gone before the monitor attached, stopping");
        }
        watched
    }

    async fn ended(&mut self) -> Ended {
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
