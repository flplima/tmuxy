use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::control_mode::{LogSink, StateEmitter, TmuxMonitor};
use tmuxy_core::{executor, transport};
use tracing::{debug, error, info, warn};

use super::clients::{monitor_config, session_exists, VIEWER_ATTACH_RETRY};
use super::emitter::{encode_event, SseEmitter, SseEvent};
use crate::state::AppState;

// ============================================
// Monitoring (Control Mode)
// ============================================

pub async fn start_monitoring(
    broadcast: Arc<crate::state::SessionBroadcast>,
    session: String,
    state: Arc<AppState>,
) {
    let keeper = Arc::new(tmuxy_core::session_snapshot::SnapshotKeeper::new());
    let emitter = Arc::new(SseEmitter::new(
        broadcast.clone(),
        Arc::clone(&state),
        session.clone(),
        keeper.clone(),
    ));
    let snapshot_dir = tmuxy_core::session_snapshot::default_dir();
    let log_sink: Arc<dyn LogSink> = emitter.clone();

    let config = monitor_config(&session, &state);

    let mut backoff = Duration::from_millis(100);
    const MAX_BACKOFF: Duration = Duration::from_secs(10);
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    let mut is_first_connect = true;
    // Track whether monitor.run() ever processed events successfully.
    // If the connection dies before processing any events, we should retry
    // with create_session=true since the session may need to be recreated.
    let mut ever_ran_successfully = false;
    // Bound consecutive connect failures so we don't hammer a broken tmux
    // forever. Reset on successful long-running monitor.run().
    let mut consecutive_failures: u32 = 0;
    let shutdown = state.shutdown.clone();

    loop {
        // Server shutdown signalled — exit promptly instead of reconnecting.
        if shutdown.is_cancelled() {
            info!(%session, "shutdown signalled, stopping monitor loop");
            let mut sessions = state.sessions.write().await;
            sessions.remove(&session);
            break;
        }

        // A viewer's monitor lives as long as the server and attaches to the
        // session whenever it exists: absent at start, killed and re-made
        // later, it is watched or waited for, never created. Clients do not
        // enter into it — there is one monitor whether none or many are
        // watching.
        if state.read_only {
            if !session_exists(&session).await {
                debug!(%session, "session not present; looking again shortly");
                tokio::select! {
                    _ = tokio::time::sleep(VIEWER_ATTACH_RETRY) => {}
                    _ = shutdown.cancelled() => {}
                }
                is_first_connect = false;
                continue;
            }
        } else {
            // Stop reconnecting if session was cleaned up (no more clients)
            let has_clients = {
                let sessions = state.sessions.read().await;
                if let Some(session_conns) = sessions.get(&session) {
                    !session_conns.connections.is_empty()
                } else {
                    false
                }
            };
            if !has_clients {
                info!(%session, "no clients, stopping monitor loop");
                // Clean up the session entry so a fresh monitor can start next time
                let mut sessions = state.sessions.write().await;
                sessions.remove(&session);
                break;
            }
        }

        // On reconnect (not first connect), check if the tmux session still exists.
        // If it was intentionally destroyed (by test cleanup or user) AND we had
        // a successful run before, stop the monitor loop. If the session died
        // before ever running successfully (crash on startup), retry with
        // create_session=true to recreate it.
        let mut connect_config = config.clone();
        if !is_first_connect && !state.read_only {
            let exists = session_exists(&session).await;

            if !exists {
                if ever_ran_successfully {
                    // Session was intentionally destroyed (e.g., kill-session
                    // from test cleanup).
                    info!(%session, "tmux session no longer exists, stopping monitor loop");
                    break;
                }
                // Session died before ever running — recreate it
                warn!(%session, "tmux session died before running, will recreate");
                connect_config.create_session = true;
            } else {
                // Session exists, just attach
                connect_config.create_session = false;
            }
        }

        // If this session doesn't exist and needs creation, try to route the
        // `new-session -d` through an existing monitor's CC connection. Running
        // external `tmux new-session -d` while a CC client is attached crashes
        // tmux 3.5a. Routing through CC avoids this.
        // A session that is about to be CREATED may have a snapshot to come
        // back from. Decided here, once, so both ways of creating it (below)
        // make the first window the snapshot wants.
        let mut restore =
            if connect_config.create_session && !state.read_only && !session_exists(&session).await
            {
                transport::restore_plan(&snapshot_dir, &mut connect_config)
            } else {
                None
            };
        if let Some(snapshot) = &restore {
            info!(%session, saved_at = snapshot.saved_at, "restoring session from snapshot");
        }
        if connect_config.create_session && !session_exists(&session).await {
            // Find an existing running monitor to route through
            // Only a peer whose tmux session actually EXISTS can run the
            // command: the map also holds sessions that are themselves still
            // being created, and two of those pick each other as courier and
            // both wait out the full poll below, every round, forever.
            //
            // Nor a peer nobody is watching: its last client left and it is in
            // the grace period before its monitor detaches, and a session made
            // through it is born to a connection that closes a second later.
            // With no watched peer, the direct `-CC new-session` below is the
            // path. (A courier-made session's shell has printed before our
            // monitor attaches, so its content arrives in the very first
            // states — which is what exposed the client's initial-state race,
            // `adoptInitialState` in tmuxy-ui's deltaProtocol.ts.)
            let candidates: Vec<(String, _, usize)> = {
                let sessions = state.sessions.read().await;
                sessions
                    .iter()
                    .filter(|(name, _)| *name != &session)
                    .filter(|(_, conns)| !conns.connections.is_empty())
                    .filter_map(|(name, conns)| {
                        conns
                            .monitor_command_tx
                            .clone()
                            .map(|tx| (name.clone(), tx, conns.connections.len()))
                    })
                    .collect()
            };
            let mut existing_tx = None;
            for (name, tx, viewers) in candidates {
                if session_exists(&name).await {
                    existing_tx = Some((name, tx, viewers));
                    break;
                }
            }
            // Which way a session is born is one of the few things that differs
            // between one that comes up and one whose pane stays blank, so the
            // trace keeps it (docs/TRACING.md, pane lifecycle).
            match &existing_tx {
                Some((_, _, viewers)) => {
                    debug!(%session, via = "courier", viewers = *viewers, "session creation path")
                }
                None => debug!(%session, via = "direct", viewers = 0usize, "session creation path"),
            }

            if let Some((via_session, tx, _)) = existing_tx {
                let working_dir = connect_config
                    .working_dir
                    .as_ref()
                    .map(|d| format!(" -c {}", executor::tmux_quote(&d.display().to_string())))
                    .unwrap_or_default();
                let first_window = connect_config
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
                    executor::tmux_quote(&session),
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
                // Wait for the session to actually exist before attaching CC.
                // The RunCommand is async — it goes through the monitor's event
                // loop and then tmux processes it. Poll has-session to confirm.
                let mut created = false;
                for _ in 0..50 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if session_exists(&session).await {
                        created = true;
                        info!(%session, "session created successfully via CC");
                        break;
                    }
                }
                if created {
                    // Session exists, just attach (no creation needed)
                    connect_config.create_session = false;
                } else {
                    warn!(%session, "session creation via CC timed out, falling back to direct creation");
                    // Fall through with create_session still true
                }
            }
        }

        match TmuxMonitor::connect(connect_config, Some(&log_sink)).await {
            Ok((mut monitor, command_tx)) => {
                // Store command_tx so cleanup_connection can send Shutdown
                let stored = {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session_conns) = sessions.get_mut(&session) {
                        debug!(%session, "storing command_tx");
                        session_conns.monitor_command_tx = Some(command_tx.clone());
                        session_conns.snapshot_keeper = Some(keeper.clone());
                        true
                    } else {
                        // Session was cleaned up between connect and now
                        warn!(%session, "session gone before storing command_tx, stopping");
                        false
                    }
                };

                if !stored {
                    break;
                }

                // The autosave, for as long as this connection lives.
                if !tmuxy_core::session_snapshot::autosave_disabled() {
                    let keeper = keeper.clone();
                    let tx = command_tx.clone();
                    let dir = snapshot_dir.clone();
                    let name = session.clone();
                    let shutdown = state.shutdown.clone();
                    state
                        .spawn(async move {
                            tokio::select! {
                                _ = keeper.run(name, dir, tx) => {}
                                _ = shutdown.cancelled() => {}
                            }
                        })
                        .await;
                }

                // The rebuild, onto the window `new-session` just made. Queued
                // on the command channel, so it runs once the monitor is in its
                // loop.
                if let Some(snapshot) = restore.take() {
                    let rebuild = transport::restore_after_attach(
                        snapshot,
                        keeper.clone(),
                        command_tx.clone(),
                    );
                    let name = session.clone();
                    state
                        .spawn(async move {
                            match rebuild.await {
                                Ok(()) => info!(session = %name, "session restored from snapshot"),
                                Err(e) => warn!(session = %name, %e, "session restore stopped"),
                            }
                        })
                        .await;
                }

                let run_start = std::time::Instant::now();
                monitor.run(emitter.as_ref()).await;
                // If the monitor ran for more than 2 seconds, consider it a successful run.
                // Short-lived runs indicate startup crashes that should retry with create_session.
                //
                // A connect that succeeds and then dies at once is NOT a success, and the
                // two counters below are what stop it becoming a hot loop. Resetting the
                // backoff on `connect` alone meant a session tmux could not hold was
                // recreated about eight times a second forever: every iteration reset the
                // backoff to 100ms before the run that was about to fail, so it never grew
                // past one step. Counting the short run as a failure also gives this path
                // the `MAX_CONSECUTIVE_FAILURES` ceiling the `Err` arm already has —
                // without it the loop could never give up and tell the user.
                if run_start.elapsed() > Duration::from_secs(2) {
                    ever_ran_successfully = true;
                    consecutive_failures = 0;
                    backoff = Duration::from_millis(100);
                } else {
                    consecutive_failures += 1;
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        let final_msg = format!(
                            "tmux session {} could not be started after {} attempts; giving up.",
                            session, MAX_CONSECUTIVE_FAILURES
                        );
                        let event = SseEvent::Fatal {
                            message: final_msg.clone(),
                        };
                        if let Some(s) = encode_event(&event) {
                            broadcast.broadcast(s);
                        }
                        error!(%session, msg = %final_msg, "monitor FATAL");
                        let mut sessions = state.sessions.write().await;
                        sessions.remove(&session);
                        return;
                    }
                }

                {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session_conns) = sessions.get_mut(&session) {
                        session_conns.monitor_command_tx = None;
                    }
                }
            }
            Err(e) => {
                // Variant-aware recovery:
                // - `SessionNotFound` after the session was already destroyed (e.g. external
                //   `tmux kill-session`) means the user intentionally tore it down. Surface
                //   and exit instead of looping forever trying to attach.
                // - Everything else (`Timeout`, `ProcessExited`, `Io`, generic `ControlMode`)
                //   is retried with exponential backoff up to `MAX_CONSECUTIVE_FAILURES`.
                if matches!(e, tmuxy_core::TmuxError::SessionNotFound { .. }) {
                    if state.read_only {
                        // Gone between the check above and the attach: the
                        // loop's own wait handles absence, and this is not
                        // a failure of tmux.
                        is_first_connect = false;
                        continue;
                    }
                    if ever_ran_successfully {
                        info!(%session, error = %e, "session destroyed externally, stopping monitor loop");
                        let mut sessions = state.sessions.write().await;
                        sessions.remove(&session);
                        return;
                    }
                }

                consecutive_failures += 1;
                emitter.emit_error(format!(
                    "Failed to connect to control mode (attempt {} of {}): {}",
                    consecutive_failures, MAX_CONSECUTIVE_FAILURES, e
                ));

                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    let final_msg = format!(
                        "Unable to connect to tmux after {} attempts; giving up. Last error: {}",
                        MAX_CONSECUTIVE_FAILURES, e
                    );
                    let event = SseEvent::Fatal {
                        message: final_msg.clone(),
                    };
                    if let Some(s) = encode_event(&event) {
                        broadcast.broadcast(s);
                    }
                    error!(%session, msg = %final_msg, "monitor FATAL");
                    let mut sessions = state.sessions.write().await;
                    sessions.remove(&session);
                    return;
                }
            }
        }

        is_first_connect = false;
        // Cancellable backoff — Ctrl+C during retry shouldn't have to wait out
        // the full sleep before the next loop iteration sees the cancellation.
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = shutdown.cancelled() => {}
        }
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}
