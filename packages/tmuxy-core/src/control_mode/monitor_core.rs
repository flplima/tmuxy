//! The sans-IO core of a control-mode client: everything the native monitor
//! and the in-browser guest do between the bytes tmux sends and the commands
//! that go back, with no I/O and no clock of its own.
//!
//! A host feeds it events (`step`), the commands a client sends (`command`),
//! the client's viewport (`set_client_size`) and the time (`tick`, at
//! `next_deadline`), and runs the [`Action`]s it hands back in order: write
//! lines to tmux, emit the state, show a notice, answer a caller, end. The
//! tokio monitor (`control_mode::monitor`) and tmuxy-wasm are two such hosts.
//!
//! ```text
//!   events ──► step ───────┐
//!   command ─► command ────┤               ┌─ Send(lines)   → tmux
//!   viewport ► set_client ─┼─► MonitorCore ┼─ Emit(class)   → host's policy
//!   time ────► tick ───────┘   (aggregator)├─ Notify(..)    → the person
//!                                          ├─ Answer(w, ..) → a caller
//!                                          └─ Ended(reason) → stop
//! ```

mod attach;
mod reads;
mod replies;
pub(crate) mod run_shell;
mod sizing;

use super::parser::ControlModeEvent;
use super::state::{Batch, ChangeType, Instant, Notice, SideEffect, StateAggregator};
use crate::WindowId;
use replies::Waiter;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tracing::debug;

pub use attach::AttachConfig;
pub use reads::ReadPacing;
pub use replies::command_reports_failure;

/// How often the client polls a pane in copy mode: its cursor needs
/// sub-100ms updates, and tmux announces none of them.
pub const COPY_MODE_SYNC_INTERVAL: Duration = Duration::from_millis(50);
pub const IDLE_THRESHOLD: Duration = Duration::from_secs(10);
/// The idle heartbeat re-lists everything, to catch what changed out of band.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
/// How long after output or a window change the metadata re-list runs: a
/// pane's command, title and history size, and the window indices a close
/// renumbers, change with no notification.
pub const METADATA_SYNC_DELAY: Duration = Duration::from_millis(500);
/// How long a reply-wrapped command waits for its closing marker before it
/// fails: long enough for any tmux round trip on the supported targets,
/// short enough that a wedged command does not hold up the client that asked.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
const FIRST_SYNC_DELAY: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone)]
pub struct CommandReply {
    pub output: String,
    /// tmux's message when a block of the command was a `%error`. tmux stops
    /// a command list at its first failure, so `output` is then partial.
    pub error: Option<String>,
}

impl CommandReply {
    pub fn into_result(self) -> Result<String, crate::CommandError> {
        match self.error {
            None => Ok(self.output),
            Some(error) => Err(crate::CommandError::tmux(error)),
        }
    }

    fn failed(error: impl Into<String>) -> Self {
        CommandReply {
            output: String::new(),
            error: Some(error.into()),
        }
    }
}

/// What the host does next, in the order the core hands them over. `W` is
/// the host's handle on a caller waiting for a reply (a oneshot sender, a
/// request id).
#[derive(Debug)]
pub enum Action<W> {
    /// Control-mode lines to write, in order, in one flush.
    Send(Vec<String>),
    /// A state emission is due; the class picks throttle, debounce or now.
    Emit(ChangeType),
    Notify(Notice),
    Answer(W, CommandReply),
    /// tmux ended the connection (`%exit`), with its reason when it gave one
    /// — `detached` for a client detached on purpose.
    Ended(Option<String>),
}

/// A command a client sent, as it goes to tmux: the lines that run it, and
/// the re-lists that go right behind it once they are written.
#[derive(Debug)]
pub struct Outgoing {
    pub lines: Vec<String>,
    pub relists: Vec<String>,
    reply_id: Option<u64>,
    settles: bool,
}

impl Outgoing {
    pub fn reply_id(&self) -> Option<u64> {
        self.reply_id
    }
}

pub struct MonitorCore<W> {
    aggregator: StateAggregator,
    session: String,
    shell_line: String,
    replies: HashMap<u64, (Waiter<W>, Instant)>,
    /// Monotonic for the life of the core, so a late block from an expired
    /// reply can never be matched to a newer one (M8).
    next_reply_id: u64,
    /// In cells.
    client_size: Option<(u32, u32)>,
    /// The size each window was last asked for, how many times running, and
    /// which `list-panes` report was current then (`sizing::needs_resize`).
    resize_attempts: HashMap<WindowId, ((u32, u32), u8, u64)>,
    resize_given_up: HashSet<WindowId>,
    last_event_at: Instant,
    next_sync_at: Instant,
    metadata_sync_at: Option<Instant>,
    read_pacing: ReadPacing,
    reads: reads::ReadGate,
}

impl<W> MonitorCore<W> {
    /// `shell_line` is how a `run-shell` job reaches this server
    /// (`session::tmux_shell_line` for a native host, plain `tmux` in a guest).
    pub fn new(session: &str, shell_line: impl Into<String>, now: Instant) -> Self {
        Self {
            aggregator: StateAggregator::with_session_name(session),
            session: session.to_string(),
            shell_line: shell_line.into(),
            replies: HashMap::new(),
            next_reply_id: 0,
            client_size: None,
            resize_attempts: HashMap::new(),
            resize_given_up: HashSet::new(),
            last_event_at: now,
            next_sync_at: now + FIRST_SYNC_DELAY,
            metadata_sync_at: None,
            read_pacing: ReadPacing::default(),
            reads: reads::ReadGate::default(),
        }
    }

    pub fn aggregator(&self) -> &StateAggregator {
        &self.aggregator
    }

    pub fn aggregator_mut(&mut self) -> &mut StateAggregator {
        &mut self.aggregator
    }

    /// Follow `session` from now on: the client is about to switch to it.
    pub fn expect_session(&mut self, session: &str) {
        self.session = session.to_string();
        self.aggregator = StateAggregator::with_session_name(session);
        self.resize_attempts.clear();
        self.resize_given_up.clear();
    }

    /// `Ended` is the last action a connection gets; a `%message` goes to the
    /// person and never touches the tree.
    pub fn step(&mut self, event: ControlModeEvent, now: Instant) -> Vec<Action<W>> {
        self.last_event_at = now;
        if let ControlModeEvent::Exit { reason } = event {
            return vec![Action::Ended(reason)];
        }
        let step = self.aggregator.step_at(event, now);
        let mut actions = Vec::with_capacity(step.effects.len() + 1);
        for effect in step.effects {
            match effect {
                SideEffect::Send {
                    batch: Batch::WindowRelist | Batch::PaneRefresh,
                    commands,
                } => self.read(commands, &mut actions),
                SideEffect::Send { commands, .. } => actions.push(Action::Send(commands)),
                SideEffect::Emit(change) => {
                    if matches!(change, ChangeType::Output | ChangeType::Window) {
                        self.metadata_sync_at
                            .get_or_insert(now + METADATA_SYNC_DELAY);
                    }
                    actions.push(Action::Emit(change));
                }
                SideEffect::Notify(notice) => actions.push(Action::Notify(notice)),
                SideEffect::Reply { id, output, error } => {
                    actions.extend(self.on_reply(id, output, error));
                }
            }
        }
        // After the step's own effects (M5): ahead of them, the sizing jumps
        // this step's emission, and the window payload that carries
        // @tmuxy-window-type gets dropped.
        if let Some(sizing) = self.size_windows() {
            actions.push(sizing);
        }
        actions.extend(self.flush_reads(now));
        actions
    }

    pub fn tick(&mut self, now: Instant) -> Vec<Action<W>> {
        let mut actions = Vec::new();
        if let Some(change) = self.aggregator.tick(now) {
            actions.push(Action::Emit(change));
        }
        if self
            .aggregator
            .status_deadline()
            .is_some_and(|at| now >= at)
        {
            let held = self.aggregator.held_status_commands(now);
            if !held.is_empty() {
                actions.push(Action::Send(held));
            }
        }
        if self.metadata_sync_at.is_some_and(|at| now >= at) {
            self.metadata_sync_at = None;
            let relist = self.aggregator.markers().window_relist_commands().to_vec();
            self.read(relist, &mut actions);
        }
        if now >= self.next_sync_at {
            let idle_for = now.saturating_duration_since(self.last_event_at);
            if self.aggregator.has_pane_in_copy_mode() {
                let poll = self.aggregator.copy_mode_poll_commands();
                self.read(poll, &mut actions);
                self.next_sync_at = now + COPY_MODE_SYNC_INTERVAL;
            } else if idle_for >= IDLE_THRESHOLD {
                let relist = self.aggregator.markers().window_relist_commands().to_vec();
                self.read(relist, &mut actions);
                self.next_sync_at = now + HEARTBEAT_INTERVAL;
            } else {
                self.next_sync_at = now + (IDLE_THRESHOLD - idle_for);
            }
        }
        actions.extend(self.expire_replies(now));
        actions.extend(self.flush_reads(now));
        actions
    }

    /// When `tick` next has something to do.
    pub fn next_deadline(&self) -> Instant {
        let reply_deadline = self
            .replies
            .values()
            .map(|(_, sent_at)| *sent_at + REPLY_TIMEOUT)
            .min();
        [
            Some(self.next_sync_at),
            self.metadata_sync_at,
            self.aggregator.settling_deadline(),
            self.aggregator.status_deadline(),
            reply_deadline,
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(self.next_sync_at)
    }

    /// The viewport the client shows, in cells: every window is sized to it
    /// (a sidebar to its own column) as soon as it is known.
    pub fn set_client_size(&mut self, cols: u32, rows: u32) -> Vec<Action<W>> {
        self.client_size = Some((cols, rows));
        if self.aggregator.window_ids().is_empty() {
            // Before the window list arrives, the current window is sized so
            // the visible pane is right at once.
            return vec![Action::Send(vec![format!("resizew -x {cols} -y {rows}")])];
        }
        self.size_windows().into_iter().collect()
    }

    fn fresh_reply_id(&mut self) -> u64 {
        self.next_reply_id += 1;
        self.next_reply_id
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_reads;
