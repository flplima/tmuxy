//! State aggregator for tmux control mode
//!
//! Aggregates control mode events into coherent state using vt100 terminal emulation.

use super::parser::ControlModeEvent;
use super::{images, osc};
use crate::{PaneId, WindowId};
use std::collections::{HashMap, HashSet};
use tracing::{debug, warn};

// The settling debounce uses a monotonic clock. `std::time::Instant::now()`
// panics on wasm32; web-time backs it with performance.now() in the browser.
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
#[cfg(target_arch = "wasm32")]
use web_time::Instant;

/// Type of change that occurred
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ChangeType {
    /// No change
    #[default]
    None,
    /// Pane output changed (high frequency, may be debounced)
    PaneOutput { pane_id: PaneId },
    /// Pane layout/position changed
    PaneLayout,
    /// Window-related change (add, close, rename, focus)
    Window,
    /// Pane focus changed within window
    PaneFocus,
    /// Session-related change
    Session,
    /// Full state refresh needed
    Full,
    /// Flow control: pane paused
    FlowPause { pane_id: PaneId },
    /// Flow control: pane resumed
    FlowContinue { pane_id: PaneId },
}

/// Is this "title" a graphics escape tmux mistook for one?
///
/// tmux reads a lone APC string as a pane title (`input_exit_apc`), so a
/// program that probes for Kitty graphics support without wrapping the escape
/// in tmux's DCS passthrough names the pane after its own query — the pane
/// running Antigravity's CLI was titled `Ga=q,f=32,s=1,v=1,i=31;AAAAAA==`
/// while it drew. The payload is protocol, never something a user asked to
/// read, so the pane falls back to its process name as if no title were set.
///
/// Matched strictly — `G` then Kitty's `key=value` pairs, then an optional
/// `;payload` — so a program whose real title merely starts with a G keeps it.
/// See docs/RICH-RENDERING.md for why wrapping the escape is the fix on the
/// sending side.
pub(super) fn is_graphics_payload(title: &str) -> bool {
    let Some(rest) = title.strip_prefix('G') else {
        return false;
    };
    let keys = rest.split(';').next().unwrap_or("");
    if keys.is_empty() {
        return false;
    }
    keys.split(',').all(|pair| {
        let mut halves = pair.splitn(2, '=');
        let key = halves.next().unwrap_or("");
        let value = halves.next().unwrap_or("");
        key.len() == 1
            && key.chars().all(|c| c.is_ascii_alphabetic())
            && !value.is_empty()
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '+' | '.' | '_'))
    })
}

/// Result of processing a control mode event
#[derive(Debug, Default)]
pub(crate) struct ProcessEventResult {
    /// Whether state changed in a way that should trigger a UI update
    pub state_changed: bool,
    /// Pane IDs that need their content refreshed via capture-pane
    pub panes_needing_refresh: Vec<PaneId>,
    /// Type of change that occurred (for smart update strategies)
    pub change_type: ChangeType,
    /// Newly decoded images: (pane_id, vec of (image_id, StoredImage))
    pub new_images: Vec<(PaneId, Vec<(u32, super::images::StoredImage)>)>,
    /// OSC 52 clipboard write requests from the terminal application.
    /// Each entry is (pane_id, decoded text); no pane for a paste-buffer yank. Forwarded to the emitter so
    /// the frontend can mirror the request into the system clipboard.
    pub clipboard_writes: Vec<(Option<PaneId>, String)>,
    /// tmux commands the runtime must send back over the control connection
    /// (beyond the dedicated refresh/capture fields above). Used by the
    /// push-based (wasm) path, e.g. reading a paste buffer after
    /// %paste-buffer-changed.
    pub commands: Vec<String>,
    /// Completed reply-wrapped commands: (reply id, everything the command
    /// printed, whether every block succeeded). See `reply_wrapped_lines`.
    pub command_replies: Vec<(u64, String, Option<String>)>,
}

/// Outcome of a single `StateAggregator::step` call.
///
/// Effects describe the I/O the runtime must perform. `change_type` is also
/// returned out-of-band because the monitor's settling state machine needs to
/// see *every* change (including suppressed ones), not just the ones that
/// flowed through into an `EmitState` effect. Without this, the settling
/// timer wouldn't extend during compound commands while window emissions are
/// suppressed.
#[derive(Debug, Clone, Default)]
pub struct StepResult {
    pub effects: Vec<SideEffect>,
    pub change_type: ChangeType,
}

/// Typed side effect emitted by the sans-IO state machine.
///
/// The aggregator never performs I/O itself — it only describes what the
/// runtime (currently `TmuxMonitor`) must do. This makes the state machine
/// fully testable without tokio: drive it with synthetic events and assert
/// on the returned `Vec<SideEffect>`.
#[derive(Debug, Clone)]
pub enum SideEffect {
    /// Send a tmux command through control mode. The runtime is expected to
    /// dispatch this via `ControlModeConnection::send_command(s)`.
    SendTmuxCommand(String),
    /// Capture-pane is needed for these pane ids — emit list-panes first,
    /// then capture each. Surfaced as its own variant so the monitor can
    /// preserve the ordering invariant documented in `refresh_panes`.
    RefreshPanes { pane_ids: Vec<PaneId> },
    /// After a window-add event, refresh both list-panes and list-windows.
    /// Order is load-bearing (see `refresh_after_window_add`).
    RefreshAfterWindowAdd,
    /// Auto-adopt every untagged window with the supplied `set-option`
    /// commands. Idempotent — `collect_window_tag_commands` skips already
    /// tagged windows.
    AdoptUntaggedWindows(Vec<String>),
    /// Indicate the runtime should emit a state update if the aggregator has
    /// one queued. The variant carries the `ChangeType` so the runtime can
    /// pick the right emission strategy (throttle, debounce, immediate).
    EmitState { change: ChangeType },
    /// Resume a paused pane (flow control).
    ResumePane(PaneId),
    /// Forward a freshly-decoded image set to the emitter.
    StoreImages {
        pane_id: PaneId,
        images: Vec<(u32, super::images::StoredImage)>,
    },
    /// Forward an OSC 52 clipboard write to the system clipboard.
    /// `pane_id` is the writer, or `None` for a paste-buffer yank.
    WriteClipboard {
        pane_id: Option<PaneId>,
        text: String,
    },
    /// A command sent with `reply_wrapped_lines` has finished: hand its output
    /// back to whoever asked. `error` is tmux's message when a block of the
    /// command was an `%error` — tmux stops a command list at the first
    /// failure, so `output` is then what the commands before it printed.
    CommandReply {
        id: u64,
        output: String,
        error: Option<String>,
    },
}

/// Aggregates control mode events into coherent state
/// A sidebar window with its column width and, when the client set it, the
/// rows its column holds (`tmux_options::SIDEBAR_ROWS`).
pub type SidebarSizing = (WindowId, u32, Option<u32>);

pub struct StateAggregator {
    /// How many `list-panes` reports have been applied. A monitor sizing a
    /// window judges each `resizew` by the report that FOLLOWS it, so this is
    /// what tells one report from the next (see `monitor::needs_resize`).
    pub pane_reports: u64,
    /// Windows whose `@tmuxy-collapsible` just dropped: their first-level rows
    /// are evened out on the next step (see `collapsible_layout_commands`).
    even_out_pending: Vec<WindowId>,
    /// Session name (e.g., "tmuxy")
    session_name: String,
    /// The attached session's id (`$0`), from `%session-changed`: tmux tells
    /// every control client of every session's rename, so this is what picks
    /// out ours. Unknown on a core started after the attach.
    session_id: Option<String>,

    /// Pane states indexed by pane ID
    panes: HashMap<PaneId, PaneState>,

    /// Rows of history each pane keeps. Raised to
    /// `constants::VIEWER_SCROLLBACK_ROWS` on an observer's aggregator, whose
    /// clients are viewers and must be served scrollback without touching
    /// tmux; the reflow minimum otherwise.
    scrollback_rows: usize,

    /// Window states indexed by window ID
    windows: HashMap<WindowId, WindowState>,

    /// Active window ID
    active_window_id: Option<WindowId>,

    /// Pane IDs with a capture-pane command in flight. Used for de-duplication
    /// (don't send a second capture while one is pending) and to preserve the
    /// previous content of a resized pane until its capture lands (see
    /// `to_state_update`). Response ROUTING does not use this — every capture
    /// is bracketed by `TMUXY_CAP_BEGIN <pane>` / `TMUXY_CAP_END` marker
    /// responses (see `capture_command`), so a capture block is attributed to
    /// its pane exactly, never by arrival order or output-shape guessing.
    pending_captures: std::collections::VecDeque<PaneId>,
    /// Whether a list-panes / list-windows response has been parsed since
    /// this aggregator was created — the first ones are the initial sync.
    panes_synced: bool,
    windows_synced: bool,
    /// Pane the response between a `TMUXY_CAP_BEGIN <pane>` marker and its
    /// `TMUXY_CAP_END` belongs to (each command in a control-mode command
    /// list gets its own %begin/%end block, so the trio arrives consecutively).
    capture_armed: Option<PaneId>,
    /// Buffer names for pending marker-wrapped `show-buffer` reads (FIFO),
    /// issued in response to %paste-buffer-changed (copy-mode yank mirror).
    pending_buffer_reads: std::collections::VecDeque<String>,
    /// True between the TMUXY_BUF_BEGIN marker response and the buffer-content
    /// response that immediately follows it (each command in a control-mode
    /// command list gets its own %begin/%end block).
    buffer_read_armed: bool,
    /// The reply-wrapped command whose output is being collected: everything
    /// between its `TMUXY_RPY_BEGIN <id>` and `TMUXY_RPY_END <id>` marker
    /// blocks. See `reply_wrapped_lines`.
    reply_in_flight: Option<ReplyInFlight>,

    /// Latest value of the session-scoped `@tmuxy-focus-request` option, read
    /// as a column of the `list-windows` poll. A one-shot request from a shell
    /// helper (`bin/tmuxy/nav`) for the client to move keyboard focus somewhere
    /// no tmux command could — see `tmux_options::FOCUS_REQUEST`. The client
    /// that acts on it unsets the option, which clears this on the next poll.
    focus_request: Option<String>,

    // Delta state tracking
    /// Previous state snapshot for delta computation
    prev_state: Option<crate::TmuxState>,

    /// Sequence number for delta updates
    delta_seq: u64,

    /// When true, window/layout change events update internal state but
    /// return `state_changed: false` to suppress emission. Pane output
    /// events still emit immediately. Used during command-aware settling
    /// to batch intermediate states from compound commands (e.g., splitw ; breakp).
    suppress_window_emissions: bool,

    /// Panes whose VT100 was reset because they moved between windows
    /// (e.g., break-pane). %output events are suppressed for these panes
    /// until a capture-pane response arrives, preventing stale content from
    /// the old window from accumulating in the reset buffer.
    panes_moved_window: std::collections::HashSet<PaneId>,

    /// Buffered %output for panes not yet created in state.
    /// When tmux splits a pane, %output for the new pane can arrive before
    /// %layout-change creates the pane. This buffer holds that early output
    /// so parse_layout() can replay it when the pane is created.
    early_output: HashMap<PaneId, Vec<u8>>,

    /// HIDDEN pane-group members parked in the stash session, keyed by pane id.
    /// These are not real panes in this session's plane — they carry only what a
    /// group tab strip needs (window id, group id, command, title). Rebuilt from
    /// each `LIST_STASH_PANES_CMD` response and emitted as lightweight
    /// `TmuxPane` stubs (see `to_tmux_state`). The frontend tells a stub from the
    /// visible member by its window id (a stash window is never the active one).
    stash_members: HashMap<PaneId, StashMember>,

    /// Window ids that have had `pane-border-status top` enforced. Tabs no
    /// longer carry a `@tmuxy-window-type` marker (untagged ⇒ tab, derived at
    /// emit), so there's no per-window tmux flag to make the enforcement
    /// idempotent — this in-memory set does, applying the border settings once
    /// per window per connection.
    border_enforced: std::collections::HashSet<WindowId>,
    /// Sidebar windows whose pane border has been switched off. `pane-border-status
    /// top` is a GLOBAL window option (every new window inherits it), so a sidebar
    /// needs it turned off explicitly whether or not it was first adopted as a tab.
    sidebar_border_cleared: std::collections::HashSet<WindowId>,

    /// Compound-command settling state. When armed (`settling_until.is_some()`),
    /// window/layout emissions are suppressed and the aggregator's `tick(now)`
    /// is responsible for firing the consolidated state emit when the deadline
    /// expires.
    settling_until: Option<Instant>,
    settling_started: Option<Instant>,
    settling_awaiting_first_event: bool,
}

impl StateAggregator {
    pub fn new() -> Self {
        Self::with_session_name(crate::DEFAULT_SESSION_NAME)
    }

    /// Keep `rows` of history per pane instead of the reflow minimum.
    ///
    /// Set by an observer's monitor at construction, before any pane exists,
    /// so every pane this aggregator creates can answer a viewer's scrollback
    /// request from memory.
    pub fn set_scrollback_rows(&mut self, rows: usize) {
        self.scrollback_rows = rows;
    }

    /// A pane's history as rendered rows, from `start` to `end` inclusive
    /// (row `0` is the top of the screen, negative rows are history), plus
    /// its width and how many rows of history it holds.
    ///
    /// `None` when this aggregator has no such pane — which is also the
    /// membership check a viewer's request needs, since an aggregator only
    /// ever holds the session it monitors.
    pub fn pane_scrollback(
        &mut self,
        pane_id: &PaneId,
        start: i64,
        end: i64,
    ) -> Option<(crate::PaneContent, usize, u32)> {
        let pane = self.panes.get_mut(pane_id)?;
        let width = pane.width;
        let (rows, depth) = pane.scrollback_cells(start, end);
        Some((rows, depth, width))
    }

    /// Create with a specific session name
    pub fn with_session_name(session_name: &str) -> Self {
        Self {
            session_name: session_name.to_string(),
            session_id: None,
            pane_reports: 0,
            panes: HashMap::new(),
            scrollback_rows: crate::constants::REFLOW_SCROLLBACK_ROWS,
            windows: HashMap::new(),
            active_window_id: None,
            pending_captures: std::collections::VecDeque::new(),
            panes_synced: false,
            windows_synced: false,
            capture_armed: None,
            pending_buffer_reads: std::collections::VecDeque::new(),
            buffer_read_armed: false,
            reply_in_flight: None,

            focus_request: None,
            even_out_pending: Vec::new(),
            prev_state: None,
            delta_seq: 0,
            suppress_window_emissions: false,
            panes_moved_window: std::collections::HashSet::new(),
            early_output: HashMap::new(),
            stash_members: HashMap::new(),
            border_enforced: std::collections::HashSet::new(),
            sidebar_border_cleared: std::collections::HashSet::new(),
            settling_until: None,
            settling_started: None,
            settling_awaiting_first_event: false,
        }
    }
}

impl Default for StateAggregator {
    fn default() -> Self {
        Self::new()
    }
}

mod command_response;
mod delta_emit;
mod events;
mod pane_output;
mod pane_state;
mod parsing;
mod stash_and_helpers;
mod step_and_output;
mod window_state;

use command_response::ReplyInFlight;
pub use command_response::{
    capture_command, capture_command_range, pane_refresh_commands, reply_wrapped_lines,
    window_relist_commands,
};
#[cfg(test)]
pub use command_response::{CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER};
pub use pane_state::PaneState;
pub use stash_and_helpers::{
    accepted_clipboard_write, normalize_capture_bytes, MAX_CLIPBOARD_BYTES,
    MAX_STORED_IMAGES_PER_PANE, MIN_CLIPBOARD_INTERVAL,
};
use stash_and_helpers::{
    is_list_panes_line, is_stash_member_line, normalize_pane_command, StashMember,
};
use window_state::parse_layout_panes;
pub use window_state::WindowState;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_capture;
#[cfg(test)]
mod tests_hyperlinks;
#[cfg(test)]
mod tests_panes;
#[cfg(test)]
mod tests_sidebar_and_delta;
#[cfg(test)]
mod tests_windows_and_stash;
