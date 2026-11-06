//! The monitor loop both hosts run. The web server and the desktop app
//! differ in what sits AROUND it (who may stop it, how a session is brought
//! into being, what giving up means), and [`Host`] is that difference.
//!
//! A connect that succeeds and then dies at once is NOT a success. Resetting
//! the backoff on `connect` alone recreated a session tmux could not hold
//! about eight times a second forever; only a run that lived
//! [`MIN_HEALTHY_RUN`] resets the counters.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use super::{HostEvent, SessionRuntime};
use crate::control_mode::{LogSink, MonitorCommandSender, MonitorConfig, TmuxMonitor};
use crate::session_snapshot::{self as snapshot, RestoreOptions, Snapshot, SnapshotKeeper};
use crate::TmuxError;

/// The pause before the next attempt after a failure: doubled each time from
/// the first to the cap, back to the first after a healthy run.
pub const FIRST_BACKOFF: Duration = Duration::from_millis(100);
pub const MAX_BACKOFF: Duration = Duration::from_secs(10);
pub const MAX_CONSECUTIVE_FAILURES: u32 = 5;

/// A connection that lived this long worked; a shorter one is a startup crash
/// to count against the session. The crash is tmux exiting about 50 ms after
/// the first `%end` (seen from a Finder-launched app on macOS); a longer bar
/// would take a session killed in its first seconds for a startup crash and
/// create it again.
pub const MIN_HEALTHY_RUN: Duration = Duration::from_secs(2);

pub enum Attempt {
    Connect(MonitorConfig),
    /// Not now: look again after this long. Not a failure, nothing was tried.
    Wait(Duration),
    Stop,
}

pub enum Ended {
    /// Judge the run by how long it lived, and go round again.
    Judge,
    /// The host ended it on purpose (a switch of servers). Neither a failure
    /// nor a wait: straight round to `before_attempt`.
    Deliberate,
    /// The host ended it on purpose and holds the loop in `before_attempt`
    /// until there is a reason to connect again (a detach). Commands are
    /// refused meanwhile rather than kept waiting.
    Parked,
    Stop,
}

pub enum GaveUp {
    Stop,
    /// Keep looping; the host's `before_attempt` holds it until there is a
    /// reason to try again.
    Park,
}

pub type Task = Pin<Box<dyn Future<Output = ()> + Send>>;

pub trait Host: Send {
    /// `ever_ran`: whether a connection has ever lived [`MIN_HEALTHY_RUN`].
    fn before_attempt(&mut self, ever_ran: bool) -> impl Future<Output = Attempt> + Send;

    fn session_exists(&self, session: &str) -> impl Future<Output = bool> + Send {
        super::session_exists(session)
    }

    /// A session that does not exist is about to be created, with the first
    /// window the restore plan asked for in `config`. A host that would rather
    /// bring it into being another way does so here and clears
    /// `config.create_session`.
    fn create_session(&mut self, _config: &mut MonitorConfig) -> impl Future<Output = ()> + Send {
        async {}
    }

    /// The connection is up and its channel published. `false` ends the loop
    /// (the host no longer wants this session).
    fn connected(&mut self) -> impl Future<Output = bool> + Send {
        async { true }
    }

    fn ended(&mut self) -> impl Future<Output = Ended> + Send;

    /// A connect attempt failed. `Some` overrides the failure count (a wait
    /// or a stop the host decides from the error); `None` counts it.
    fn connect_failed(
        &mut self,
        _error: &TmuxError,
        _ever_ran: bool,
    ) -> impl Future<Output = Option<Attempt>> + Send {
        async { None }
    }

    /// The loop has given up; `message` says why, for the user.
    fn gave_up(&mut self, message: String) -> impl Future<Output = GaveUp> + Send;

    /// Run a task of the loop's (the restore of a snapshot) however the host
    /// runs its background work.
    fn spawn(&self, task: Task) -> impl Future<Output = ()> + Send;

    /// A host that is shutting down returns early.
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + Send;
}

/// A session about to be CREATED may have a snapshot to come back from.
/// Decided before the connect, so however the host brings the session into
/// being its first window is the one the snapshot wants; the rebuild runs
/// onto it after attach ([`restore_after_attach`]), over control mode, never
/// with a clientless server.
fn restore_plan(dir: &Path, config: &mut MonitorConfig) -> Option<Snapshot> {
    let found = snapshot::restorable(dir, &config.session)?;
    config.first_window = found.first_window_hint(&snapshot::fallback_cwd());
    Some(found)
}

/// The rebuild onto the window `new-session` just made, for the caller to
/// spawn once the monitor is in its loop: it must run after the initial sync.
///
/// The keeper is held from HERE, not from inside the task: the first delta of
/// the fresh session must not race the task's start into a save of the
/// placeholder window. It is released however the rebuild ends; what stands
/// then is the shape worth keeping.
fn restore_after_attach(
    snapshot: Snapshot,
    keeper: Arc<SnapshotKeeper>,
    tx: MonitorCommandSender,
) -> impl Future<Output = Result<(), TmuxError>> + Send {
    keeper.restore_started();
    async move {
        let options = RestoreOptions {
            run: false,
            fallback_cwd: snapshot::fallback_cwd(),
            onto_existing_window: true,
            existing_window_index: None,
        };
        let outcome = snapshot::restore_via_monitor(&snapshot, &options, &tx).await;
        keeper.restore_finished();
        outcome
    }
}

enum Outcome {
    /// Go round again after the backoff.
    Retry,
    /// Go round again now.
    Again,
    Stop,
}

/// Run the monitor loop for `host` until it says stop. The runtime's command
/// channel is published while a connection is up; once the loop ends,
/// commands are refused.
pub async fn supervise<H: Host>(host: H, runtime: Arc<SessionRuntime>) {
    run_loop(host, &runtime).await;
    runtime.set_down();
}

struct Failures {
    count: u32,
    backoff: Duration,
}

impl Failures {
    fn reset(&mut self) {
        self.count = 0;
        self.backoff = FIRST_BACKOFF;
    }

    async fn count<H: Host>(
        &mut self,
        host: &mut H,
        runtime: &SessionRuntime,
        message: String,
        giving_up: impl FnOnce() -> String,
    ) -> Outcome {
        self.count += 1;
        runtime.emit(HostEvent::Reconnecting {
            message: format!(
                "{message} (attempt {} of {MAX_CONSECUTIVE_FAILURES})",
                self.count
            ),
        });
        if self.count < MAX_CONSECUTIVE_FAILURES {
            return Outcome::Retry;
        }
        match host.gave_up(giving_up()).await {
            GaveUp::Stop => Outcome::Stop,
            GaveUp::Park => {
                runtime.set_down();
                self.reset();
                Outcome::Again
            }
        }
    }
}

async fn run_loop<H: Host>(mut host: H, runtime: &Arc<SessionRuntime>) {
    let snapshot_dir = snapshot::default_dir();
    let log_sink: Arc<dyn LogSink> = runtime.clone();
    let keeper = runtime.keeper().clone();

    let mut failures = Failures {
        count: 0,
        backoff: FIRST_BACKOFF,
    };
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
        runtime.set_connecting();
        let session = config.session.clone();

        let mut restore = None;
        if config.create_session && !host.session_exists(&session).await {
            if runtime.restores() {
                restore = restore_plan(&snapshot_dir, &mut config);
            }
            if let Some(found) = &restore {
                tracing::info!(%session, saved_at = found.saved_at, "restoring session from snapshot");
            }
            host.create_session(&mut config).await;
        }

        let outcome = match TmuxMonitor::connect(config, Some(&log_sink)).await {
            Ok((mut monitor, tx)) => {
                runtime.connected(tx.clone()).await;
                if !host.connected().await {
                    return;
                }
                if let Some(found) = restore.take() {
                    let rebuild = restore_after_attach(found, keeper.clone(), tx.clone());
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
                    monitor.run(runtime).await;
                } else {
                    tokio::select! {
                        _ = monitor.run(runtime) => {}
                        _ = keeper.run(session.clone(), snapshot_dir.clone(), tx.clone()) => {}
                    }
                }
                let lived = started.elapsed();
                tracing::info!(%session, ?lived, failures = failures.count, "monitor run() returned");
                runtime.disconnected();

                match host.ended().await {
                    Ended::Stop => return,
                    Ended::Deliberate => Outcome::Again,
                    Ended::Parked => {
                        runtime.set_down();
                        Outcome::Again
                    }
                    Ended::Judge if lived >= MIN_HEALTHY_RUN => {
                        ever_ran = true;
                        failures.reset();
                        runtime.emit(HostEvent::Reconnecting {
                            message: "the tmux connection ended; reconnecting".to_string(),
                        });
                        Outcome::Retry
                    }
                    Ended::Judge => {
                        failures
                            .count(
                                &mut host,
                                runtime,
                                format!("tmux connection died after {lived:?}"),
                                || format!(
                                    "tmux session {session} disconnects right after connecting; giving up after {MAX_CONSECUTIVE_FAILURES} attempts (the last lived {lived:?})"
                                ),
                            )
                            .await
                    }
                }
            }
            Err(e) => match host.connect_failed(&e, ever_ran).await {
                Some(Attempt::Wait(pause)) => {
                    host.sleep(pause).await;
                    Outcome::Again
                }
                Some(Attempt::Stop) => return,
                Some(Attempt::Connect(_)) | None => {
                    failures
                        .count(
                            &mut host,
                            runtime,
                            format!("Failed to connect to control mode: {e}"),
                            || format!(
                                "Unable to connect to tmux after {MAX_CONSECUTIVE_FAILURES} attempts; giving up. Last error: {e}"
                            ),
                        )
                        .await
                }
            },
        };

        match outcome {
            Outcome::Stop => return,
            Outcome::Again => continue,
            Outcome::Retry => {}
        }
        host.sleep(failures.backoff).await;
        failures.backoff = std::cmp::min(failures.backoff * 2, MAX_BACKOFF);
    }
}
