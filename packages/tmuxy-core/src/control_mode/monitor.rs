//! TmuxMonitor - High-level API with adapter pattern
//!
//! This module provides the main interface for tmux control mode monitoring.
//! It uses an adapter pattern (like the frontend) to support different backends:
//! - SSE (tmuxy-server)
//! - Tauri events (tauri-app)

mod commands;
mod event_loop;
mod resize;
mod run_shell;
mod sync;

use super::{parser, state};

use super::connection::{ControlModeConnection, INITIAL_PTY_COLS, INITIAL_PTY_ROWS};
use super::parser::ControlModeEvent;
use super::state::{window_relist_commands, ChangeType, SideEffect, StateAggregator};
use crate::constants::tmux_formats;
use crate::error::TmuxError;
use crate::{PaneId, StateUpdate, WindowId};
#[cfg(test)]
use commands::*;
use event_loop::*;
use resize::*;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, instrument, trace, warn};

/// What a `RunCommandWithReply` command printed, and how it failed if it did.
#[derive(Debug, Clone)]
pub struct CommandReply {
    pub output: String,
    /// tmux's message when a block of the command was a `%error`. tmux stops
    /// a command list at its first failure, so `output` is then partial.
    pub error: Option<String>,
}

impl CommandReply {
    /// The output, or tmux's message as a [`crate::CommandError`] of kind
    /// `tmux`.
    pub fn into_result(self) -> Result<String, crate::CommandError> {
        match self.error {
            None => Ok(self.output),
            Some(error) => Err(crate::CommandError::tmux(error)),
        }
    }
}

/// Who is waiting on a reply-wrapped command.
enum ReplyWaiter {
    /// A `RunCommandWithReply` caller: gets the whole reply, success or not.
    Caller(oneshot::Sender<CommandReply>),
    /// A fire-and-forget `RunCommand`: nobody wants the output, but a
    /// `%error` is reported to the emitter so the user learns why nothing
    /// happened.
    ReportFailure,
    /// A fire-and-forget `run-shell`, relayed through the server option it
    /// names (`run_shell`): what it printed is shown, and a failure reported.
    RunShell(String),
}

/// Commands that can be sent to the monitor from external code
#[derive(Debug)]
pub enum MonitorCommand {
    /// Resize all windows in the session to the given dimensions
    ResizeWindow { cols: u32, rows: u32 },
    /// Run an arbitrary tmux command through control mode, fire-and-forget.
    /// The command's own `%begin/%end` block is not attributed to anyone.
    RunCommand { command: String },
    /// Run a tmux command through control mode and get its output back.
    ///
    /// The one way to *read* from tmux while a control-mode client is
    /// attached: the command is bracketed by marker lines
    /// (`reply_wrapped_lines`) so its blocks can be told apart from the
    /// monitor's own polls, and the reply resolves when the closing marker's
    /// block arrives. A reply that does not arrive within
    /// `REPLY_TIMEOUT` fails; a receiver that has gone away is ignored.
    RunCommandWithReply {
        command: String,
        reply: oneshot::Sender<CommandReply>,
    },
    /// The aggregator's current picture of the session, for a client's
    /// initial state.
    ///
    /// This is the same state the monitor's `StateUpdate::Full` carries,
    /// and it is what makes a client that connects after that broadcast
    /// whole: a delta only carries what changed since the last emission, so
    /// anything the client's baseline got wrong stays wrong until it happens
    /// to change. Answered once no capture-pane refill is in flight, so the
    /// pane contents are settled; a receiver that has gone away is ignored.
    GetState {
        reply: oneshot::Sender<crate::TmuxState>,
    },

    /// Gracefully shutdown the monitor
    /// Sends detach-client and waits for the connection to close cleanly
    Shutdown,
}

/// Trait for emitting state changes (adapter pattern).
///
/// Implement this trait in tmuxy-server (SseEmitter) and tauri-app (TauriEmitter)
/// to receive state updates from the monitor.
///
/// `StateEmitter: LogSink` — emitters may also override [`LogSink::log`] to
/// surface connection-time command/output progress to the UI.
pub trait StateEmitter: super::log::LogSink {
    /// Called when tmux state changes (full or delta update)
    fn emit_state(&self, update: StateUpdate);

    /// Called when an error occurs
    fn emit_error(&self, error: String);

    /// Called when the control-mode connection ended, with tmux's own reason
    /// (`%exit [reason]`) when it gave one — `detached` for a client that was
    /// detached deliberately.
    ///
    /// This is what lets a client tell "you detached" from "the link died".
    /// Without it both arrive as `emit_error` and the UI has to treat an
    /// intentional detach as a failure to retry, which is the single
    /// most-complained-about behaviour in comparable terminal clients.
    ///
    /// Defaulted so emitters that do not care (the test doubles) are
    /// unaffected, exactly as `store_images` is.
    fn emit_disconnected(&self, _reason: Option<String>) {}

    /// Called when new images are decoded from terminal output.
    /// Default implementation discards images (for emitters that don't need them).
    fn store_images(&self, _pane_id: &PaneId, _images: Vec<(u32, super::images::StoredImage)>) {}

    /// Called when an OSC 52 clipboard request is decoded from terminal output.
    /// `text` is the UTF-8 string the application asked to place on the system
    /// clipboard; `pane_id` is the pane that asked, `None` for a paste-buffer
    /// yank. Default implementation discards the request.
    fn write_clipboard(&self, _pane_id: Option<&PaneId>, _text: String) {}

    /// Called when tmux shows this client a message (`display-message`, or
    /// tmux's own notices), already cleaned by the parser. Default
    /// implementation discards it.
    fn show_message(&self, _text: String) {}

    /// Called after initial state sync completes (config sourced, settings enforced).
    /// Default implementation does nothing.
    fn on_initial_sync_complete(&self) {}
}

/// Configuration for TmuxMonitor
#[derive(Debug, Clone)]
pub struct MonitorConfig {
    /// Session name to connect to
    pub session: String,

    /// Whether to create the session if it doesn't exist
    pub create_session: bool,

    /// On the create path, the session whose *group* this session joins
    /// (`new-session -t <base>`): the two share every window and pane while
    /// keeping their own current window. `None` for an ordinary session.
    pub group_target: Option<String>,

    /// Minimum interval between throttled state emissions.
    /// Used when high-frequency output is detected.
    /// Recommended: 16ms (60fps) for smooth updates during bulk output.
    pub throttle_interval: Duration,

    /// Working directory for the tmux control mode process.
    /// run-shell commands resolve relative paths from this directory.
    pub working_dir: Option<std::path::PathBuf>,

    /// Name and directory for the first window when the session is created —
    /// a session about to be rebuilt from a snapshot asks for its first window
    /// up front, so the rebuild runs onto it after attach. Ignored when the
    /// session exists (`session_snapshot`).
    pub first_window: Option<(String, String)>,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            session: String::new(),
            create_session: false,
            group_target: None,
            throttle_interval: Duration::from_millis(32), // ~30fps during high throughput
            first_window: None,
            working_dir: None,
        }
    }
}

/// Handle for sending commands to a running TmuxMonitor
pub type MonitorCommandSender = mpsc::Sender<MonitorCommand>;

/// "Effectively infinite" sleep used by `tokio::select!` branches that need a
/// `sleep_until` ceiling for branches gated behind an `Option<Instant>`. The
/// real deadline is the `if` guard on the branch; this constant only exists
/// so the future has *some* await point when the guard is false.
const LONG_SLEEP: Duration = Duration::from_secs(3600);

/// How long a `RunCommandWithReply` waits for its closing marker before it
/// fails: long enough for any tmux round trip on the supported targets, short
/// enough that a wedged command does not hold up the client that asked.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

/// The main tmux control mode monitor.
///
/// This struct handles:
/// - Connecting to tmux in control mode
/// - Processing events and aggregating state
/// - Emitting state changes via the StateEmitter trait
pub struct TmuxMonitor<C: ControlLink = ControlModeConnection> {
    /// Connection to tmux control mode
    connection: C,

    /// State aggregator
    aggregator: StateAggregator,

    /// Configuration
    config: MonitorConfig,

    /// Channel for receiving commands from external code
    command_rx: mpsc::Receiver<MonitorCommand>,

    /// Whether this connection has logged adopting untagged windows (tagging
    /// floats/sidebars by name, giving tabs their border row). Every batch is
    /// still sent; this only keeps the log line to one per connect.
    logged_adoption: bool,

    /// Last viewport size the client asked for, in cells.
    ///
    /// A client's first resize routinely arrives before the initial
    /// `list-windows` response has been aggregated, so there are no window ids
    /// to target yet and only the current window can be sized. Remembering the
    /// request lets `apply_client_size` re-apply it to every window as soon as
    /// they are known — otherwise every non-current window keeps whatever size
    /// the previous client left it at, for the life of the session.
    client_size: Option<(u32, u32)>,

    /// The size each window was last ASKED for, and how many times running.
    ///
    /// A count of sized windows is not enough: `%window-add` announces a window
    /// before its `@tmuxy-window-type` is readable, so a freshly broken-out
    /// sidebar is first sized as an ordinary window — and with a count, "all
    /// windows sized" then hides the type arriving a moment later on
    /// `list-windows`, leaving the dock stuck at the viewport width.
    ///
    /// The ATTEMPT COUNT is what stops this being a claim that the window has
    /// that size. `resizew` goes out fire-and-forget and can be dropped; this
    /// map used to record the send as the truth, so one lost command left the
    /// client asking for 41 columns while tmux sat at 200 for the life of the
    /// session — the phone layout's `targetCols: 41, totalWidth: 200`. The
    /// authority is now `window_extent`, what tmux itself reports, and this
    /// only bounds the retries so a size tmux genuinely refuses cannot spin.
    resize_attempts: HashMap<WindowId, ((u32, u32), u8, u64)>,
    /// Windows already reported as ones tmux will not size, so the warning is
    /// said once rather than on every sync.
    resize_given_up: HashSet<WindowId>,

    /// Replies still waiting for their closing marker, by reply id, with the
    /// instant each was sent — the loop fails any that outlive REPLY_TIMEOUT.
    pending_replies: HashMap<u64, (ReplyWaiter, tokio::time::Instant)>,
    /// Source of reply ids. Monotonic for the life of the monitor, so a late
    /// block from an expired reply can never be matched to a newer one.
    next_reply_id: u64,
    /// `GetState` requests waiting for the aggregator to settle.
    pending_state_requests: Vec<oneshot::Sender<crate::TmuxState>>,
}

/// The control-mode link the monitor drives: the `tmux -CC` PTY, or a
/// scripted one in a test, so the order the dispatcher sends commands in
/// (M1 in `docs/INVARIANTS.md`) can be read back without a tmux.
pub trait ControlLink: Send {
    fn send_command(&mut self, cmd: &str) -> impl Future<Output = Result<(), TmuxError>> + Send;
    fn send_commands_batch(
        &mut self,
        commands: &[String],
    ) -> impl Future<Output = Result<(), TmuxError>> + Send;
    /// The next control-mode event; `None` once the link is closed.
    fn recv(&mut self) -> impl Future<Output = Option<ControlModeEvent>> + Send;
    fn graceful_close(&mut self) -> impl Future<Output = ()> + Send;
}

impl ControlLink for ControlModeConnection {
    async fn send_command(&mut self, cmd: &str) -> Result<(), TmuxError> {
        ControlModeConnection::send_command(self, cmd).await
    }
    async fn send_commands_batch(&mut self, commands: &[String]) -> Result<(), TmuxError> {
        ControlModeConnection::send_commands_batch(self, commands).await
    }
    async fn recv(&mut self) -> Option<ControlModeEvent> {
        ControlModeConnection::recv(self).await
    }
    async fn graceful_close(&mut self) {
        ControlModeConnection::graceful_close(self).await
    }
}

impl TmuxMonitor<ControlModeConnection> {
    /// Connect to a tmux session in control mode.
    /// Returns the monitor and a sender for sending commands to it.
    ///
    /// `log` receives streaming progress entries (each tmux invocation, its
    /// output, and any retry decisions). Pass `None` if the caller doesn't
    /// surface these to a UI.
    #[instrument(skip(log), fields(session = %config.session))]
    pub async fn connect(
        config: MonitorConfig,
        log: Option<&std::sync::Arc<dyn super::log::LogSink>>,
    ) -> Result<(Self, MonitorCommandSender), TmuxError> {
        // Serialize control mode attachment to prevent concurrent operations
        // that crash tmux 3.5a (multiple CC clients racing to attach).
        // `tmux -CC new-session -A` (when create_session is true) handles
        // both create and attach atomically — no clientless gap for the
        // macOS launchd reaper to hit.
        let connection = {
            let _lock = super::connection::session_creation_lock().await;
            ControlModeConnection::connect(
                &config.session,
                config.working_dir.as_deref(),
                log,
                config.create_session,
                config.group_target.as_deref(),
                config.first_window.as_ref(),
            )
            .await?
        };

        let (command_tx, command_rx) = mpsc::channel(32);
        Ok((Self::over(connection, config, command_rx), command_tx))
    }
}

impl<C: ControlLink> TmuxMonitor<C> {
    /// A monitor over an already open link.
    fn over(
        connection: C,
        config: MonitorConfig,
        command_rx: mpsc::Receiver<MonitorCommand>,
    ) -> Self {
        Self {
            connection,
            aggregator: StateAggregator::new(),
            config,
            command_rx,
            logged_adoption: false,
            client_size: None,
            resize_attempts: HashMap::new(),
            resize_given_up: HashSet::new(),
            pending_replies: HashMap::new(),
            next_reply_id: 0,
            pending_state_requests: Vec::new(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_unit;
