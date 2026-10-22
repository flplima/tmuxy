//! The monitor loop both hosts run.
//!
//! Connect, serve, reconnect with backoff, give up after too many failures in
//! a row; a snapshot restored before a session is created, an autosave for as
//! long as the connection lives. The web server and the desktop app differ in
//! what sits AROUND that loop — who may stop it, how a session is brought into
//! being, where the command channel is kept, what giving up means — and
//! [`Host`] is that difference, so the loop itself is written once.
//!
//! A connect that succeeds and then dies at once is NOT a success, and the
//! counters here are what stop it becoming a hot loop. Resetting the backoff
//! on `connect` alone meant a session tmux could not hold was recreated about
//! eight times a second forever: every iteration reset the backoff before the
//! run that was about to fail. Only a run that lived `min_healthy_run` resets
//! them. On macOS a Finder-launched app has seen exactly this: `connect()`
//! reads the first `%end`, tmux exits ~50 ms later, and `run()` returns.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::control_mode::{
    LogSink, MonitorCommandSender, MonitorConfig, StateEmitter, TmuxMonitor,
};
use crate::session_snapshot::{self as snapshot, SnapshotKeeper};
use crate::TmuxError;

/// The pause before the next attempt after a failure: doubled each time from
/// the first to the cap, back to the first after a healthy run.
pub const FIRST_BACKOFF: Duration = Duration::from_millis(100);
pub const MAX_BACKOFF: Duration = Duration::from_secs(10);
/// How many failures in a row make the loop give up.
pub const MAX_CONSECUTIVE_FAILURES: u32 = 5;

/// What the host says before an attempt.
pub enum Attempt {
    /// Connect with this config.
    Connect(MonitorConfig),
    /// Not now — look again after this long. Not a failure: nothing was tried.
    Wait(Duration),
    /// The loop is over.
    Stop,
}

/// What the host says once a connection has ended.
pub enum Ended {
    /// Judge the run by how long it lived, and go round again.
    Judge,
    /// The host ended it on purpose — a detach, a switch of servers. Neither
    /// a failure nor a wait: straight round to `before_attempt`.
    Deliberate,
    /// The loop is over.
    Stop,
}

/// What the host says when the loop has given up.
pub enum GaveUp {
    /// The loop is over.
    Stop,
    /// Keep looping; the host's `before_attempt` holds it until there is a
    /// reason to try again.
    Park,
}

/// A task the host runs for the loop, the way it runs its own.
pub type Task = Pin<Box<dyn Future<Output = ()> + Send>>;

/// What differs between the hosts around the monitor loop.
pub trait Host: Send {
    /// Before each attempt: the config to connect with, a pause, or the end.
    /// `ever_ran` says whether a connection has ever lived a healthy while.
    fn before_attempt(&mut self, ever_ran: bool) -> impl Future<Output = Attempt> + Send;

    /// Whether the session exists, asked before the host's own connection
    /// is attached — a subprocess, which is safe for a read.
    fn session_exists(&self, session: &str) -> impl Future<Output = bool> + Send;

    /// A session that does not exist is about to be created, with the first
    /// window the restore plan asked for in `config`. A host that would rather
    /// bring it into being another way does so here and clears
    /// `config.create_session`.
    fn create_session(&mut self, _config: &mut MonitorConfig) -> impl Future<Output = ()> + Send {
        async {}
    }

    /// The connection is up: keep the channel and the keeper where the host's
    /// command handlers find them. `false` ends the loop (the host no longer
    /// wants this session).
    fn connected(
        &mut self,
        tx: MonitorCommandSender,
        keeper: Arc<SnapshotKeeper>,
    ) -> impl Future<Output = bool> + Send;

    /// The connection ended: forget the channel, and say how to go on.
    fn ended(&mut self) -> impl Future<Output = Ended> + Send;

    /// A connect attempt failed. `Some` overrides the failure count — a wait
    /// or a stop the host decides from the error; `None` counts it.
    fn connect_failed(
        &mut self,
        _error: &TmuxError,
        _ever_ran: bool,
    ) -> impl Future<Output = Option<Attempt>> + Send {
        async { None }
    }

    /// The loop has given up; `message` says why, for the user.
    fn gave_up(&mut self, message: String) -> impl Future<Output = GaveUp> + Send;

    /// Run a task of the loop's — the restore of a snapshot — however the
    /// host runs its background work.
    fn spawn(&self, task: Task) -> impl Future<Output = ()> + Send;

    /// Wait, the host's way: one that is shutting down returns early.
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + Send;
}

/// Run the monitor loop for `host` until it says stop, feeding `emitter`.
/// `keeper` is the snapshot keeper the emitter already notes changes on —
/// the autosave here runs the same one. A connection that lived at least
/// `min_healthy_run` counts as having worked; a shorter one is a failure like
/// a refused connect.
pub async fn supervise<H, E>(
    mut host: H,
    emitter: Arc<E>,
    keeper: Arc<SnapshotKeeper>,
    min_healthy_run: Duration,
) where
    H: Host,
    E: StateEmitter + LogSink + 'static,
{
    let snapshot_dir = snapshot::default_dir();
    let log_sink: Arc<dyn LogSink> = emitter.clone();

    let mut backoff = FIRST_BACKOFF;
    let mut failures: u32 = 0;
    let mut ever_ran = false;

    loop {
        let mut config = match host.before_attempt(ever_ran).await {
            Attempt::Connect(config) => config,
            Attempt::Wait(pause) => {
                host.sleep(pause).await;
                continue;
            }
            Attempt::Stop => return,
        };
        let session = config.session.clone();

        // A session about to be CREATED may have a snapshot to come back
        // from. Decided here, once, so however the host brings it into being
        // the first window is the one the snapshot wants.
        let mut restore = None;
        if config.create_session && !host.session_exists(&session).await {
            restore = super::restore_plan(&snapshot_dir, &mut config);
            if let Some(found) = &restore {
                tracing::info!(%session, saved_at = found.saved_at, "restoring session from snapshot");
            }
            host.create_session(&mut config).await;
        }

        match TmuxMonitor::connect(config, Some(&log_sink)).await {
            Ok((mut monitor, tx)) => {
                if !host.connected(tx.clone(), keeper.clone()).await {
                    return;
                }
                // The rebuild, onto the window `new-session` just made. Queued
                // on the command channel, so it runs once the monitor is in its
                // loop.
                if let Some(found) = restore.take() {
                    let rebuild = super::restore_after_attach(found, keeper.clone(), tx.clone());
                    let name = session.clone();
                    host.spawn(Box::pin(async move {
                        match rebuild.await {
                            Ok(()) => {
                                tracing::info!(session = %name, "session restored from snapshot")
                            }
                            Err(e) => {
                                tracing::warn!(session = %name, %e, "session restore stopped")
                            }
                        }
                    }))
                    .await;
                }

                let started = std::time::Instant::now();
                if snapshot::autosave_disabled() {
                    monitor.run(emitter.as_ref()).await;
                } else {
                    // The autosave lives exactly as long as the connection.
                    tokio::select! {
                        _ = monitor.run(emitter.as_ref()) => {}
                        _ = keeper.run(session.clone(), snapshot_dir.clone(), tx.clone()) => {}
                    }
                }
                let lived = started.elapsed();
                tracing::info!(%session, ?lived, failures, "monitor run() returned");

                match host.ended().await {
                    Ended::Stop => return,
                    Ended::Deliberate => continue,
                    Ended::Judge => {}
                }
                if lived >= min_healthy_run {
                    ever_ran = true;
                    failures = 0;
                    backoff = FIRST_BACKOFF;
                } else {
                    failures += 1;
                    emitter.emit_error(format!(
                        "tmux connection died after {lived:?} (attempt {failures} of {MAX_CONSECUTIVE_FAILURES})"
                    ));
                    if failures >= MAX_CONSECUTIVE_FAILURES {
                        let message = format!(
                            "tmux session {session} disconnects right after connecting; giving up after {MAX_CONSECUTIVE_FAILURES} attempts (the last lived {lived:?})"
                        );
                        match host.gave_up(message).await {
                            GaveUp::Stop => return,
                            GaveUp::Park => {
                                failures = 0;
                                backoff = FIRST_BACKOFF;
                                continue;
                            }
                        }
                    }
                }
            }
            Err(e) => {
                match host.connect_failed(&e, ever_ran).await {
                    Some(Attempt::Wait(pause)) => {
                        host.sleep(pause).await;
                        continue;
                    }
                    Some(Attempt::Stop) => return,
                    Some(Attempt::Connect(_)) | None => {}
                }
                failures += 1;
                emitter.emit_error(format!(
                    "Failed to connect to control mode (attempt {failures} of {MAX_CONSECUTIVE_FAILURES}): {e}"
                ));
                if failures >= MAX_CONSECUTIVE_FAILURES {
                    let message = format!(
                        "Unable to connect to tmux after {MAX_CONSECUTIVE_FAILURES} attempts; giving up. Last error: {e}"
                    );
                    match host.gave_up(message).await {
                        GaveUp::Stop => return,
                        GaveUp::Park => {
                            failures = 0;
                            backoff = FIRST_BACKOFF;
                            continue;
                        }
                    }
                }
            }
        }

        host.sleep(backoff).await;
        backoff = std::cmp::min(backoff * 2, MAX_BACKOFF);
    }
}
