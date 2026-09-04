//! State aggregator for tmux control mode
//!
//! Aggregates control mode events into coherent state using vt100 terminal emulation.

use super::parser::ControlModeEvent;
use crate::{
    extract_cells_from_screen, extract_cells_with_urls, PaneContent, TmuxPane, TmuxState,
    TmuxWindow, WindowType,
};
use std::collections::HashMap;
use tracing::warn;

// The settling debounce uses a monotonic clock. `std::time::Instant::now()`
// panics on wasm32; web-time backs it with performance.now() in the browser.
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
#[cfg(target_arch = "wasm32")]
use web_time::Instant;

/// Safe wrapper around vt100::Parser::process that catches panics from
/// internal vt100 bugs (e.g., subtract overflow in grid.rs col_wrap).
/// Split bytes into whole UTF-8 characters, so a hyperlinked run can be fed to
/// vt100 one character at a time without tearing a multi-byte sequence. Any
/// byte that is not a continuation byte (`10xxxxxx`) starts a new chunk, which
/// also keeps a stray escape inside a link on its own chunk.
fn utf8_chunks(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts: Vec<usize> = (0..data.len())
        .filter(|&i| data[i] & 0xC0 != 0x80)
        .collect();
    starts.push(data.len());
    (0..starts.len().saturating_sub(1)).map(move |i| &data[starts[i]..starts[i + 1]])
}

fn safe_process(terminal: &mut vt100::Parser, data: &[u8]) {
    let terminal_ptr = terminal as *mut vt100::Parser;
    // SAFETY: We have exclusive access to the parser (&mut self in callers).
    // catch_unwind requires FnOnce: UnwindSafe, which &mut vt100::Parser isn't.
    // We use AssertUnwindSafe because after a panic the parser state may be
    // inconsistent, but the caller will recreate it on next capture-pane refresh.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        unsafe { &mut *terminal_ptr }.process(data);
    }));
    if result.is_err() {
        warn!("vt100 caught panic during process(), terminal state may be stale");
    }
}

/// Extract DECSCUSR (Set Cursor Style) from raw terminal output.
/// Format: ESC [ Ps SP q  where Ps is 0-6.
/// Updates `shape` with the last DECSCUSR value found in the data.
fn extract_cursor_shape(data: &[u8], shape: &mut u8) {
    // Scan for pattern: 0x1b '[' <digits> ' ' 'q'
    let len = data.len();
    let mut i = 0;
    while i < len {
        if data[i] == 0x1b && i + 1 < len && data[i + 1] == b'[' {
            // Start of CSI sequence
            let mut j = i + 2;
            // Parse digits
            let digit_start = j;
            while j < len && data[j].is_ascii_digit() {
                j += 1;
            }
            // Check for SP q suffix
            if j + 1 < len && data[j] == b' ' && data[j + 1] == b'q' && j > digit_start {
                if let Ok(ps) = std::str::from_utf8(&data[digit_start..j])
                    .unwrap_or("")
                    .parse::<u8>()
                {
                    if ps <= 6 {
                        *shape = ps;
                    }
                }
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
}

/// Type of change that occurred
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ChangeType {
    /// No change
    #[default]
    None,
    /// Pane output changed (high frequency, may be debounced)
    PaneOutput { pane_id: String },
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
    FlowPause { pane_id: String },
    /// Flow control: pane resumed
    FlowContinue { pane_id: String },
}

/// Result of processing a control mode event
#[derive(Debug, Default)]
pub struct ProcessEventResult {
    /// Whether state changed in a way that should trigger a UI update
    pub state_changed: bool,
    /// Pane IDs that need their content refreshed via capture-pane
    pub panes_needing_refresh: Vec<String>,
    /// Type of change that occurred (for smart update strategies)
    pub change_type: ChangeType,
    /// Newly decoded images: (pane_id, vec of (image_id, StoredImage))
    pub new_images: Vec<(String, Vec<(u32, super::images::StoredImage)>)>,
    /// OSC 52 clipboard write requests from the terminal application.
    /// Each entry is (pane_id, decoded text). Forwarded to the emitter so
    /// the frontend can mirror the request into the system clipboard.
    pub clipboard_writes: Vec<(String, String)>,
    /// tmux commands the runtime must send back over the control connection
    /// (beyond the dedicated refresh/capture fields above). Used by the
    /// push-based (wasm) path, e.g. reading a paste buffer after
    /// %paste-buffer-changed.
    pub commands: Vec<String>,
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
    RefreshPanes { pane_ids: Vec<String> },
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
    ResumePane(String),
    /// Forward a freshly-decoded image set to the emitter.
    StoreImages {
        pane_id: String,
        images: Vec<(u32, super::images::StoredImage)>,
    },
    /// Forward an OSC 52 clipboard write to the system clipboard.
    WriteClipboard { pane_id: String, text: String },
}

/// State of a single pane with terminal emulation
pub struct PaneState {
    /// Pane ID (e.g., "%0")
    pub id: String,

    /// Pane index (tmux pane_index)
    pub index: u32,

    /// Window ID this pane belongs to (e.g., "@0")
    pub window_id: String,

    /// Terminal emulator for this pane
    pub terminal: vt100::Parser,

    /// OSC sequence parser for hyperlinks and clipboard
    pub osc_parser: super::osc::OscParser,

    /// Last `vt100::Screen::scroll_delta` this pane observed. The difference
    /// against the current value is how far the visible grid moved, which is
    /// what keeps the OSC 8 cell->URL marks on the lines they were written on.
    ///
    /// The counter belongs to one grid, so it MUST be re-based whenever the
    /// grid underneath it is replaced — a capture refresh builds a fresh
    /// parser, and the alternate screen is a different grid with its own
    /// counter. Comparing across either yields a nonsense delta that shifts
    /// every mark off the screen.
    last_scroll_delta: i64,

    /// Which grid `last_scroll_delta` was read from: the alternate screen has
    /// its own counter and its own text.
    scroll_baseline_alt: bool,

    /// Image protocol parser (iTerm2, Sixel)
    pub image_parser: super::images::ImageParser,

    /// Stored images keyed by image ID (for HTTP retrieval)
    pub image_store: HashMap<u32, super::images::StoredImage>,

    /// Position in window (from layout)
    pub x: u32,
    pub y: u32,

    /// Dimensions
    pub width: u32,
    pub height: u32,

    /// Whether this pane is active
    pub active: bool,

    /// Running command
    pub command: String,

    /// Pane title (set by shell/application)
    pub title: String,

    /// Evaluated pane-border-format from tmux config
    pub border_title: String,

    /// Pane-group identity from `@tmuxy-group-id` (e.g. `g5`), or `None`.
    pub group_id: Option<String>,

    /// In copy mode
    pub in_mode: bool,

    /// Copy mode cursor position
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,

    /// Copy mode scroll position (number of lines scrolled from bottom)
    pub scroll_position: u32,

    /// Tmux-reported cursor position (authoritative)
    pub tmux_cursor_x: u32,
    pub tmux_cursor_y: u32,

    /// Whether application is in alternate screen mode (vim, less, htop)
    pub alternate_on: bool,

    /// Whether application wants mouse events (mouse tracking enabled)
    pub mouse_any_flag: bool,

    /// tmux's marked pane (`select-pane -m`, `#{pane_marked}`). At most one
    /// pane per server carries it; `swap-pane`/`join-pane` without a source
    /// use it.
    pub marked: bool,

    /// Whether this pane's output is paused due to flow control
    pub paused: bool,

    /// Whether a selection is active in copy mode
    pub selection_present: bool,

    /// Selection start X (column) - absolute, from tmux
    pub selection_start_x: u32,

    /// Selection start Y (row) - absolute history coordinate
    pub selection_start_y: u64,

    /// History size (number of lines scrolled off the top)
    pub history_size: u64,

    /// Content captured during copy mode (separate from main terminal to avoid corruption)
    pub copy_mode_content: Option<std::sync::Arc<PaneContent>>,

    /// Cursor shape set by DECSCUSR escape sequence
    /// 0=block, 1=block_blink, 2=block, 3=underline_blink, 4=underline, 5=bar_blink, 6=bar
    pub cursor_shape: u8,

    /// Whether the cursor is hidden (DECTCEM mode 25 off / ESC[?25l)
    pub cursor_hidden: bool,

    /// Whether terminal content has changed since last extraction
    content_dirty: bool,

    /// Cached extracted content (avoids re-extracting when content hasn't changed).
    /// `Arc`-shared with every snapshot that includes it, so handing it out is a
    /// refcount bump, not a per-cell deep copy.
    cached_content: Option<std::sync::Arc<PaneContent>>,
}

impl PaneState {
    pub fn new(id: &str, width: u32, height: u32) -> Self {
        // Guard: vt100 panics on zero dimensions
        let w = (width as u16).max(1);
        let h = (height as u16).max(1);
        let mut osc_parser = super::osc::OscParser::new();
        osc_parser.set_viewport_height(height);
        Self {
            id: id.to_string(),
            index: 0,
            window_id: String::new(),
            terminal: vt100::Parser::new(h, w, crate::constants::REFLOW_SCROLLBACK_ROWS),
            osc_parser,
            last_scroll_delta: 0,
            scroll_baseline_alt: false,
            image_parser: super::images::ImageParser::new(),
            image_store: HashMap::new(),
            x: 0,
            y: 0,
            width,
            height,
            active: false,
            command: String::new(),
            title: String::new(),
            border_title: String::new(),
            group_id: None,
            in_mode: false,
            copy_cursor_x: 0,
            copy_cursor_y: 0,
            scroll_position: 0,
            tmux_cursor_x: 0,
            tmux_cursor_y: 0,
            alternate_on: false,
            mouse_any_flag: false,
            marked: false,
            paused: false,
            selection_present: false,
            selection_start_x: 0,
            selection_start_y: 0,
            history_size: 0,
            copy_mode_content: None,
            cursor_shape: 0,
            cursor_hidden: false,
            content_dirty: true,
            cached_content: None,
        }
    }

    /// Feed vt100 the OSC-stripped bytes, recording which cells a hyperlink
    /// covers as they are written.
    ///
    /// Output with no hyperlink in it takes one bulk `process()` call, exactly
    /// as before. Only the bytes *inside* an OSC 8 pair take the slow path:
    /// they go in one character at a time and vt100 is asked where the cursor
    /// sat before and after each one, so the mark lands on the cell the
    /// character actually occupies. That is the whole point — the parser used
    /// to derive those coordinates from its own newline counting, which is
    /// blind to CSI cursor movement and drifted the map onto unrelated text.
    fn feed_terminal(&mut self, osc: super::osc::OscOutput) {
        if osc.links.is_empty() {
            safe_process(&mut self.terminal, &osc.bytes);
            self.sync_url_scroll();
            return;
        }

        let mut at = 0usize;
        for (start, end, url) in &osc.links {
            if *start > at {
                safe_process(&mut self.terminal, &osc.bytes[at..*start]);
                self.sync_url_scroll();
            }
            self.feed_linked(&osc.bytes[*start..*end], url);
            at = *end;
        }
        if at < osc.bytes.len() {
            safe_process(&mut self.terminal, &osc.bytes[at..]);
            self.sync_url_scroll();
        }
    }

    /// Write one hyperlinked run, marking every cell it paints.
    fn feed_linked(&mut self, bytes: &[u8], url: &str) {
        for chunk in utf8_chunks(bytes) {
            let (row, col) = self.terminal.screen().cursor_position();
            safe_process(&mut self.terminal, chunk);
            // Shift the marks already on screen BEFORE adding this one, so the
            // cell we are about to record isn't shifted by its own scroll.
            let scrolled = self.sync_url_scroll();
            let (row2, col2) = self.terminal.screen().cursor_position();

            // Where the pre-write line sits now, after any scroll this write
            // caused. Equal to `row2` when the character stayed on its line.
            let row_before = i64::from(row) - scrolled;
            let (mark_row, from, to) = if i64::from(row2) == row_before {
                (row2, col, col2)
            } else {
                // Wrapped onto a new line: the character is at its start.
                (row2, 0, col2)
            };
            for c in from..to {
                self.osc_parser
                    .mark_cell(u32::from(mark_row), u32::from(c), url);
            }
        }
    }

    /// Take the current grid's scroll counter as the new zero point, without
    /// shifting anything. Called after the grid is replaced or reflowed, when
    /// the marks have just been cleared and no delta is meaningful.
    fn rebaseline_scroll(&mut self) {
        let screen = self.terminal.screen();
        self.scroll_baseline_alt = screen.alternate_screen();
        self.last_scroll_delta = screen.scroll_delta();
    }

    /// Shift recorded URL marks by however far vt100 actually scrolled since
    /// the last check, and return that delta so a caller can re-base a cursor
    /// position it read before the write.
    fn sync_url_scroll(&mut self) -> i64 {
        let screen = self.terminal.screen();
        let alt = screen.alternate_screen();
        let now = screen.scroll_delta();

        if alt != self.scroll_baseline_alt {
            // A different grid entirely: its counter is unrelated to the one
            // the marks were taken against, and the text under them is not on
            // screen. Re-base and drop the marks rather than shift by a
            // meaningless delta — a stale URL landing on the alternate screen's
            // content is the exact failure this whole path exists to prevent.
            self.scroll_baseline_alt = alt;
            self.last_scroll_delta = now;
            self.osc_parser.clear_cells();
            return 0;
        }

        let delta = now - self.last_scroll_delta;
        self.last_scroll_delta = now;
        match delta.cmp(&0) {
            std::cmp::Ordering::Greater => self.osc_parser.shift_rows_up(delta as u32),
            std::cmp::Ordering::Less => {
                self.osc_parser.shift_rows_down(delta.unsigned_abs() as u32)
            }
            std::cmp::Ordering::Equal => {}
        }
        delta
    }

    /// Process new output for this pane (appends to existing buffer)
    pub fn process_output(&mut self, content: &[u8]) {
        self.content_dirty = true;

        // Extract DECSCUSR (Set Cursor Style) before other processing.
        // Format: CSI Ps SP q  (e.g., \x1b[5 q for blinking bar)
        // We scan for the last occurrence since only the final state matters.
        extract_cursor_shape(content, &mut self.cursor_shape);

        // Process through image parser to extract image sequences
        let image_result = self.image_parser.process(content);
        for (id, stored) in image_result.new_images {
            self.image_store.insert(id, stored);
        }

        // Process remaining bytes through OSC parser to extract hyperlinks/clipboard
        // Returns content with OSC sequences stripped for vt100, plus the byte
        // ranges an OSC 8 link was open over.
        let osc = self.osc_parser.process(&image_result.clean_bytes);

        // Process through terminal emulator, recording hyperlink cells as we go
        self.feed_terminal(osc);

        // Derive alternate_on and mouse_any_flag from the vt100 parser state.
        // This is more reliable than polling list-panes, as it updates immediately
        // when the application sends the escape sequence.
        self.alternate_on = self.terminal.screen().alternate_screen();
        self.mouse_any_flag = !matches!(
            self.terminal.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::None
        );
        self.cursor_hidden = self.terminal.screen().hide_cursor();

        // Update image parser cursor position from vt100 state
        let screen = self.terminal.screen();
        let (row, col) = screen.cursor_position();
        self.image_parser.update_cursor(row, col);
    }

    /// Reset terminal and process capture-pane output.
    /// capture-pane returns plain text with ANSI colors but no cursor positioning,
    /// so we need to reset to top-left before processing.
    pub fn reset_and_process_capture(&mut self, content: &[u8]) {
        self.content_dirty = true;
        self.cached_content = None;

        // Create fresh terminal to clear all state
        self.terminal = self.fresh_terminal();
        // Keep image placements: the capture text can't recreate them (tmux
        // strips image escapes from captured history).
        self.image_parser.reset_for_capture();
        // capture-pane output carries no OSC 8 sequences (tmux strips them), so
        // the old cell→URL map can only mis-attach stale URLs to fresh content
        // at the same coordinates. Clear it and let live %output repopulate.
        self.osc_parser.reset();

        let normalized = normalize_capture_bytes(content);
        safe_process(&mut self.terminal, &normalized);
        self.rebaseline_scroll();
    }

    /// A parser for this pane's size, already in the screen mode tmux reports.
    ///
    /// The alternate screen (`?1049h`) is state the application set once,
    /// possibly long before this client attached. A parser rebuilt for a
    /// capture refill (or a window move) never saw that sequence, so it
    /// reported the main screen while list-panes kept reporting the alternate
    /// one — and `alternate_on` flapped between the two on every %output /
    /// list-panes pair, re-rendering the pane a few times a second (the
    /// "blinking" pane running Claude Code). Entering the mode up front keeps
    /// the captured screen in the grid tmux drew it on and the two sources in
    /// agreement.
    fn fresh_terminal(&self) -> vt100::Parser {
        let w = (self.width as u16).max(1);
        let h = (self.height as u16).max(1);
        let mut terminal = vt100::Parser::new(h, w, crate::constants::REFLOW_SCROLLBACK_ROWS);
        if self.alternate_on {
            terminal.process(b"\x1b[?1049h");
        }
        terminal
    }

    /// Resize the terminal.
    /// Returns true if the dimensions actually changed.
    pub fn resize(&mut self, width: u32, height: u32) -> bool {
        if self.width != width || self.height != height {
            self.width = width;
            self.height = height;
            self.content_dirty = true;
            self.cached_content = None;
            // Guard: vt100 panics on zero dimensions (subtract overflow in grid.rs)
            let w = (width as u16).max(1);
            let h = (height as u16).max(1);
            // Reflow the existing grid IN PLACE, preserving content and cursor
            // anchoring. The previous approach recreated the parser and replayed
            // the whole accumulated raw %output buffer, which re-scrolled that
            // output through a fresh grid — leaving short content BOTTOM-anchored
            // (blank rows prepended, prompt glued to the last row) after a
            // swap/resize in the fully client-side (v86) path, where there is no
            // authoritative capture-pane pass to correct the replay. vt100's
            // `set_size` rewraps each row to the new width and grows/shrinks the
            // grid from the bottom, so top-anchored content stays where it is and
            // the cursor is clamped — matching what a real terminal does on
            // SIGWINCH. This also subsumes the original %layout-change case the
            // replay was added for (content is reflowed, never lost).
            self.terminal.screen_mut().set_size(h, w);
            self.image_parser.reset();
            // Drop stale hyperlink cell mappings (reflowed coordinates no longer
            // match) and realign the scroll compensation to the new height.
            self.osc_parser.reset();
            self.osc_parser.set_viewport_height(height);
            self.rebaseline_scroll();
            true
        } else {
            false
        }
    }

    /// Get the rendered screen content as structured cells.
    /// Uses cached content when terminal hasn't changed since last extraction.
    /// Returns an `Arc` so a clean cache hit is a refcount bump — repeated
    /// state builds between output events share one extraction.
    pub fn get_content(&mut self) -> std::sync::Arc<PaneContent> {
        if !self.content_dirty {
            if let Some(ref cached) = self.cached_content {
                return std::sync::Arc::clone(cached);
            }
        }
        let content = std::sync::Arc::new(extract_cells_with_urls(
            self.terminal.screen(),
            Some(&self.osc_parser),
        ));
        self.cached_content = Some(std::sync::Arc::clone(&content));
        self.content_dirty = false;
        content
    }

    /// Process capture-pane output during copy mode.
    /// Uses a temporary terminal to avoid corrupting the main terminal state,
    /// since %output events from background processes continue arriving during copy mode.
    pub fn process_copy_mode_capture(&mut self, content: &[u8]) {
        let w = (self.width as u16).max(1);
        let h = (self.height as u16).max(1);
        let mut temp_terminal = vt100::Parser::new(h, w, 0);

        let normalized = normalize_capture_bytes(content);
        safe_process(&mut temp_terminal, &normalized);
        self.copy_mode_content = Some(std::sync::Arc::new(extract_cells_from_screen(
            temp_terminal.screen(),
        )));
    }

    /// Build TmuxPane struct (uses &mut self for content caching)
    pub fn build_tmux_pane(&mut self) -> TmuxPane {
        // Use vt100 emulator cursor for immediate feedback on output events.
        // The vt100 cursor is updated on every %output event, while tmux_cursor_x/y
        // are only updated on periodic list-panes responses (every 500ms).
        let screen = self.terminal.screen();
        let vt100_cursor_x = screen.cursor_position().1 as u32;
        let vt100_cursor_y = screen.cursor_position().0 as u32;

        // Convert absolute selection start Y to visible-area-relative coordinate
        // history_size = lines above the visible area
        // scroll_position = lines scrolled back from the bottom
        // view_start = history_size - scroll_position (absolute line at top of visible area)
        let (sel_start_x, sel_start_y) = if self.selection_present {
            let view_start = self.history_size as i64 - self.scroll_position as i64;
            let visible_y = self.selection_start_y as i64 - view_start;
            (self.selection_start_x, visible_y as i32)
        } else {
            (0, 0)
        };

        TmuxPane {
            id: self.index,
            tmux_id: self.id.clone(),
            window_id: self.window_id.clone(),
            content: if self.in_mode {
                self.copy_mode_content
                    .as_ref()
                    .cloned()
                    .unwrap_or_else(|| self.get_content())
            } else {
                self.get_content()
            },
            cursor_x: vt100_cursor_x,
            cursor_y: vt100_cursor_y,
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
            active: self.active,
            command: self.command.clone(),
            title: self.title.clone(),
            border_title: self.border_title.clone(),
            group_id: self.group_id.clone(),
            in_mode: self.in_mode,
            copy_cursor_x: self.copy_cursor_x,
            copy_cursor_y: self.copy_cursor_y,
            alternate_on: self.alternate_on,
            mouse_any_flag: self.mouse_any_flag,
            marked: self.marked,
            paused: self.paused,
            history_size: self.history_size,
            selection_present: self.selection_present,
            selection_start_x: sel_start_x,
            selection_start_y: sel_start_y,
            images: self.image_parser.placements.clone(),
            cursor_shape: self.cursor_shape,
            cursor_hidden: self.cursor_hidden,
        }
    }
}

/// Window state
pub struct WindowState {
    /// Window ID (e.g., "@0")
    pub id: String,

    /// Window index
    pub index: u32,

    /// Window name
    pub name: String,

    /// Whether this window is active
    pub active: bool,

    /// Layout string
    pub layout: String,

    /// Window type (Tab/Float/FloatBackdrop/Group) sourced from @tmuxy-window-type.
    /// None = foreign window, ignored by the frontend.
    pub window_type: Option<WindowType>,
    /// `@tmuxy-sidebar-cols` — a user-dragged width for a sidebar column.
    pub sidebar_cols: Option<u32>,
    /// `@tmuxy-sidebar-hidden` — the user closed this sidebar column; its
    /// pane stays alive but no client draws it.
    pub sidebar_hidden: bool,

    /// Parent window ID for float / backdrop (@tmuxy-float-parent).
    pub float_parent: Option<String>,

    /// Float width in chars (from @tmuxy-float-width).
    pub float_width: Option<u32>,

    /// Float height in chars (from @tmuxy-float-height).
    pub float_height: Option<u32>,

    /// Drawer-style float direction (@tmuxy-float-drawer).
    pub float_drawer: Option<String>,

    /// Float backdrop style (@tmuxy-float-bg).
    pub float_bg: Option<String>,

    /// True if float hides its header chrome (@tmuxy-float-noheader = 1).
    pub float_noheader: bool,

    /// Active pane ID in this window (tracked from %window-pane-changed events)
    pub active_pane_id: Option<String>,

    /// Whether this window has a zoomed pane (from %layout-change flags containing 'Z')
    pub zoomed: bool,
}

impl WindowState {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            index: id.trim_start_matches('@').parse().unwrap_or(0),
            name: String::new(),
            active: false,
            layout: String::new(),
            window_type: None,
            sidebar_cols: None,
            sidebar_hidden: false,
            float_parent: None,
            float_width: None,
            float_height: None,
            float_drawer: None,
            float_bg: None,
            float_noheader: false,
            active_pane_id: None,
            zoomed: false,
        }
    }

    pub fn to_tmux_window(&self) -> TmuxWindow {
        TmuxWindow {
            id: self.id.clone(),
            index: self.index,
            name: self.name.clone(),
            active: self.active,
            // Untagged windows in the attached session ARE tabs — tabs carry no
            // `@tmuxy-window-type` marker. Only float/float-backdrop/sidebar are
            // tagged; everything else (including foreign `tmux neww` windows)
            // surfaces as a tab.
            window_type: Some(self.window_type.unwrap_or(WindowType::Tab)),
            float_parent: self.float_parent.clone(),
            float_width: self.float_width,
            float_height: self.float_height,
            float_drawer: self.float_drawer.clone(),
            float_bg: self.float_bg.clone(),
            float_noheader: self.float_noheader,
            sidebar_cols: self.sidebar_cols,
            sidebar_hidden: self.sidebar_hidden,
            zoomed: self.zoomed,
        }
    }
}

// ============================================================
// Layout string parser
// ============================================================

/// Pane geometry extracted from a tmux layout string
struct LayoutPane {
    id: String,
    index: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

/// Parse a tmux layout string (after checksum removal) into pane geometries.
///
/// The format is recursive:
/// - Leaf: `WxH,x,y,pane_index`
/// - Vertical split: `WxH,x,y[child,child,...]`
/// - Horizontal split: `WxH,x,y{child,child,...}`
///
/// Positions (x,y) in the layout are absolute (relative to window origin).
fn parse_layout_panes(layout: &str) -> Vec<LayoutPane> {
    let bytes = layout.as_bytes();
    let mut pos = 0;
    let mut panes = Vec::new();
    parse_layout_node(bytes, &mut pos, &mut panes);
    panes
}

fn parse_layout_u32(bytes: &[u8], pos: &mut usize) -> Option<u32> {
    let start = *pos;
    while *pos < bytes.len() && bytes[*pos].is_ascii_digit() {
        *pos += 1;
    }
    if *pos == start {
        return None;
    }
    std::str::from_utf8(&bytes[start..*pos]).ok()?.parse().ok()
}

fn parse_layout_node(bytes: &[u8], pos: &mut usize, panes: &mut Vec<LayoutPane>) {
    // Parse WxH
    let width = match parse_layout_u32(bytes, pos) {
        Some(w) => w,
        None => return,
    };
    if *pos >= bytes.len() || bytes[*pos] != b'x' {
        return;
    }
    *pos += 1; // skip 'x'
    let height = match parse_layout_u32(bytes, pos) {
        Some(h) => h,
        None => return,
    };

    // Skip comma before x
    if *pos < bytes.len() && bytes[*pos] == b',' {
        *pos += 1;
    }
    let x = match parse_layout_u32(bytes, pos) {
        Some(v) => v,
        None => return,
    };

    // Skip comma before y
    if *pos < bytes.len() && bytes[*pos] == b',' {
        *pos += 1;
    }
    let y = match parse_layout_u32(bytes, pos) {
        Some(v) => v,
        None => return,
    };

    // What follows determines node type:
    // '[' or '{' → container with children
    // ','        → leaf with pane index
    if *pos < bytes.len() && (bytes[*pos] == b'[' || bytes[*pos] == b'{') {
        // Container node
        let open = bytes[*pos];
        let close = if open == b'[' { b']' } else { b'}' };
        *pos += 1; // skip open bracket

        loop {
            if *pos >= bytes.len() {
                break;
            }
            if bytes[*pos] == close {
                *pos += 1; // skip close bracket
                break;
            }
            parse_layout_node(bytes, pos, panes);
            // Skip child separator comma
            if *pos < bytes.len() && bytes[*pos] == b',' {
                *pos += 1;
            }
        }
    } else if *pos < bytes.len() && bytes[*pos] == b',' {
        // Leaf node: ,pane_index
        *pos += 1; // skip comma
        if let Some(pane_idx) = parse_layout_u32(bytes, pos) {
            panes.push(LayoutPane {
                id: format!("%{}", pane_idx),
                index: pane_idx,
                x,
                y,
                width,
                height,
            });
        }
    }
    // else: end of input or unexpected char — return gracefully
}

/// Aggregates control mode events into coherent state
pub struct StateAggregator {
    /// Session name (e.g., "tmuxy")
    session_name: String,

    /// Pane states indexed by pane ID
    panes: HashMap<String, PaneState>,

    /// Window states indexed by window ID
    windows: HashMap<String, WindowState>,

    /// Active window ID
    active_window_id: Option<String>,

    /// Pane IDs with a capture-pane command in flight. Used for de-duplication
    /// (don't send a second capture while one is pending) and to preserve the
    /// previous content of a resized pane until its capture lands (see
    /// `to_state_update`). Response ROUTING does not use this — every capture
    /// is bracketed by `TMUXY_CAP_BEGIN <pane>` / `TMUXY_CAP_END` marker
    /// responses (see `capture_command`), so a capture block is attributed to
    /// its pane exactly, never by arrival order or output-shape guessing.
    pending_captures: std::collections::VecDeque<String>,
    /// Pane the response between a `TMUXY_CAP_BEGIN <pane>` marker and its
    /// `TMUXY_CAP_END` belongs to (each command in a control-mode command
    /// list gets its own %begin/%end block, so the trio arrives consecutively).
    capture_armed: Option<String>,
    /// Buffer names for pending marker-wrapped `show-buffer` reads (FIFO),
    /// issued in response to %paste-buffer-changed (copy-mode yank mirror).
    pending_buffer_reads: std::collections::VecDeque<String>,
    /// True between the TMUXY_BUF_BEGIN marker response and the buffer-content
    /// response that immediately follows it (each command in a control-mode
    /// command list gets its own %begin/%end block).
    buffer_read_armed: bool,

    /// Latest value of the session-scoped `@tmuxy-focus-request` option, read
    /// as a column of the `list-windows` poll. A one-shot request from a shell
    /// helper (`bin/tmuxy/nav`) for the client to move keyboard focus somewhere
    /// no tmux command could — see `tmux_options::FOCUS_REQUEST`. The client
    /// that acts on it unsets the option, which clears this on the next poll.
    focus_request: Option<String>,

    /// Cached status line (optimization: only refresh when its inputs change)
    cached_status_line: String,

    /// Whether status line needs refresh
    status_line_dirty: bool,

    /// When the status line was last actually re-read from tmux, for the
    /// `STATUS_LINE_MAX_AGE` fallback.
    status_line_refreshed_at: Option<Instant>,

    /// Hash of everything the status line is rendered from — the session name
    /// and each window's id/index/name/active flag. Refreshing the status line
    /// costs five `tmux display-message` subprocesses plus a shell per `#(…)`
    /// in `status-right`, synchronously, inside `to_state_update`; the
    /// `list-windows` poll fires several times a second and almost never
    /// changes any of those inputs. Comparing the fingerprint turns "we polled"
    /// into "something the user can see actually moved".
    status_line_fingerprint: Option<u64>,

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
    panes_moved_window: std::collections::HashSet<String>,

    /// Buffered %output for panes not yet created in state.
    /// When tmux splits a pane, %output for the new pane can arrive before
    /// %layout-change creates the pane. This buffer holds that early output
    /// so parse_layout() can replay it when the pane is created.
    early_output: HashMap<String, Vec<u8>>,

    /// HIDDEN pane-group members parked in the stash session, keyed by pane id.
    /// These are not real panes in this session's plane — they carry only what a
    /// group tab strip needs (window id, group id, command, title). Rebuilt from
    /// each `LIST_STASH_PANES_CMD` response and emitted as lightweight
    /// `TmuxPane` stubs (see `to_tmux_state`). The frontend tells a stub from the
    /// visible member by its window id (a stash window is never the active one).
    stash_members: HashMap<String, StashMember>,

    /// Window ids that have had `pane-border-status top` enforced. Tabs no
    /// longer carry a `@tmuxy-window-type` marker (untagged ⇒ tab, derived at
    /// emit), so there's no per-window tmux flag to make the enforcement
    /// idempotent — this in-memory set does, applying the border settings once
    /// per window per connection.
    border_enforced: std::collections::HashSet<String>,
    /// Sidebar windows whose pane border has been switched off. `pane-border-status
    /// top` is a GLOBAL window option (every new window inherits it), so a sidebar
    /// needs it turned off explicitly whether or not it was first adopted as a tab.
    sidebar_border_cleared: std::collections::HashSet<String>,

    /// Compound-command settling state. When armed (`settling_until.is_some()`),
    /// window/layout emissions are suppressed and the aggregator's `tick(now)`
    /// is responsible for firing the consolidated state emit when the deadline
    /// expires. Logic that used to live on `monitor::RunState`.
    settling_until: Option<Instant>,
    settling_started: Option<Instant>,
    settling_awaiting_first_event: bool,
}

/// Per-event debounce window during settling.
pub(crate) const SETTLING_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(100);
/// Safety ceiling — settling cannot extend past this from the arm point.
pub(crate) const SETTLING_MAX: std::time::Duration = std::time::Duration::from_millis(500);
/// How long a cached status line may go without a re-read when nothing tmux
/// reports has changed. The fingerprint check catches every change tmuxy can
/// see, but `status-right` can embed `#(command)` whose output moves on its
/// own — a clock, a battery reading — and nothing announces that. Matches
/// tmux's own `status-interval` default, so a dynamic status line updates at
/// the cadence its author already expects.
pub(crate) const STATUS_LINE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(15);

/// Marker printed (via `display-message -p`) immediately BEFORE a self-issued
/// capture-pane command, carrying the target pane id. Routing captures by
/// marker instead of arrival order or output shape is what makes attribution
/// exact: any other command's response (a send-keys ack has EMPTY output,
/// indistinguishable from capturing a blank pane) can otherwise steal a
/// pending capture and shunt one pane's content into another.
/// Prepare capture-pane bytes for vt100: strip the trailing newline (which
/// would push the cursor past the last row and scroll) and expand `\n` to
/// `\r\n` (vt100 treats bare `\n` as move-down without a carriage return).
/// One implementation — this used to be copy-pasted at every capture-feed
/// site, plus once in `lib.rs`.
pub fn normalize_capture_bytes(content: &[u8]) -> Vec<u8> {
    let content = content.strip_suffix(b"\n").unwrap_or(content);
    let mut out = Vec::with_capacity(content.len() + content.len() / 16);
    for &b in content {
        if b == b'\n' {
            out.push(b'\r');
        }
        out.push(b);
    }
    out
}

/// Does this line look like a `list-panes` record (`%<digits>,...`)?
///
/// tmux pane ids are always `%` followed by digits, and `LIST_PANES_CMD` puts
/// `#{pane_id}` first, so a genuine record always starts that way.
fn is_list_panes_line(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix('%') else {
        return false;
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    !digits.is_empty() && rest[digits.len()..].starts_with(',')
}

/// Literal sentinel prefixed on every `LIST_STASH_PANES_CMD` row so a stash
/// response routes to the stash-member handler and never reaches the
/// active-session pane/window parsers (a stash row carries a `@<id>` window id
/// that would otherwise trip the list-windows loop).
const STASH_MEMBER_PREFIX: &str = "stashmember,";

fn is_stash_member_line(line: &str) -> bool {
    line.trim_start().starts_with(STASH_MEMBER_PREFIX)
}

/// A HIDDEN pane-group member living in the stash session — just enough to
/// render its tab in a group strip. Emitted as a lightweight `TmuxPane` stub.
#[derive(Debug, Clone)]
struct StashMember {
    /// The pane's window in the stash session (never the attached session's
    /// active window, so the frontend treats the emitted stub as hidden).
    window_id: String,
    /// `@tmuxy-group-id` value tying it to its group.
    group_id: String,
    command: String,
    title: String,
}

/// Build the wire stub for a hidden group member. It has no rendered content or
/// geometry — the frontend only reads its id, group id, command, and title to
/// draw the member's tab; its content streams in via a real pane once the user
/// swaps it into view.
fn stash_member_stub(pane_id: &str, member: &StashMember) -> TmuxPane {
    TmuxPane {
        id: 0,
        tmux_id: pane_id.to_string(),
        window_id: member.window_id.clone(),
        content: std::sync::Arc::new(PaneContent::default()),
        cursor_x: 0,
        cursor_y: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        active: false,
        command: member.command.clone(),
        title: member.title.clone(),
        border_title: String::new(),
        group_id: Some(member.group_id.clone()),
        in_mode: false,
        copy_cursor_x: 0,
        copy_cursor_y: 0,
        alternate_on: false,
        mouse_any_flag: false,
        marked: false,
        paused: false,
        history_size: 0,
        selection_present: false,
        selection_start_x: 0,
        selection_start_y: 0,
        images: Vec::new(),
        cursor_shape: 0,
        cursor_hidden: false,
    }
}

pub const CAPTURE_BEGIN_MARKER: &str = "TMUXY_CAP_BEGIN";
/// Marker printed immediately AFTER a self-issued capture-pane command.
pub const CAPTURE_END_MARKER: &str = "TMUXY_CAP_END";

/// Build the marker-bracketed capture-pane command for a pane's visible
/// viewport. Each segment of a control-mode command list gets its own
/// %begin/%end block, so the three responses arrive consecutively:
/// BEGIN(pane) -> capture content -> END.
///
/// The pane id is embedded WITHOUT its `%`: `display-message` runs the
/// message through strftime-style expansion, and `%<digits>` is mangled
/// (observed on tmux 3.7: `%69` prints as 67 spaces + `%69`; other versions
/// can swallow it entirely). Bare digits are expansion-proof; the response
/// router re-prefixes the `%`.
pub fn capture_command(pane_id: &str) -> String {
    marker_wrapped_capture(pane_id, "")
}

/// `capture_command` for an explicit scrollback range (copy-mode sync).
pub fn capture_command_range(pane_id: &str, start: i64, end: i64) -> String {
    marker_wrapped_capture(pane_id, &format!(" -S {start} -E {end}"))
}

/// Shared marker-bracket format for both capture commands, so the BEGIN/END
/// bracketing can't drift between the plain and ranged variants.
fn marker_wrapped_capture(pane_id: &str, range: &str) -> String {
    let bare = pane_id.trim_start_matches('%');
    format!(
        "display-message -p '{CAPTURE_BEGIN_MARKER} {bare}' ; capture-pane -t {pane_id} -p -e{range} ; display-message -p '{CAPTURE_END_MARKER}'"
    )
}

impl StateAggregator {
    pub fn new() -> Self {
        Self::with_session_name(crate::DEFAULT_SESSION_NAME)
    }

    /// Create with a specific session name
    pub fn with_session_name(session_name: &str) -> Self {
        Self {
            session_name: session_name.to_string(),
            panes: HashMap::new(),
            windows: HashMap::new(),
            active_window_id: None,
            pending_captures: std::collections::VecDeque::new(),
            capture_armed: None,
            pending_buffer_reads: std::collections::VecDeque::new(),
            buffer_read_armed: false,

            focus_request: None,
            cached_status_line: String::new(),
            status_line_dirty: true, // Fetch on first state request
            status_line_refreshed_at: None,
            status_line_fingerprint: None,
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

    /// Enable or disable window/layout emission suppression.
    /// When suppressed, window/layout events still update internal state
    /// but `process_event()` returns `state_changed: false` for those events.
    pub fn set_suppress_window_emissions(&mut self, suppress: bool) {
        self.suppress_window_emissions = suppress;
    }

    /// Check if window emissions are currently suppressed.
    pub fn is_suppressing_window_emissions(&self) -> bool {
        self.suppress_window_emissions
    }

    /// Get the current number of windows tracked by the aggregator.
    pub fn window_count(&self) -> usize {
        self.windows.len()
    }

    /// Arm settling for a multi-step compound command (e.g. `splitw ; breakp`).
    /// Suppresses window/layout emissions until `tick(now)` fires the
    /// consolidated emit, or until `clear_settling()` is called explicitly.
    /// `now` is sourced from `Ctx::clock` so tests can drive timing.
    pub fn arm_settling(&mut self, now: Instant) {
        self.settling_started = Some(now);
        self.settling_awaiting_first_event = true;
        self.settling_until = Some(now + SETTLING_MAX);
        self.suppress_window_emissions = true;
    }

    /// Current settling deadline, if armed. Callers (the monitor) use this to
    /// compute a wakeup; expiry is processed by `tick(now)`.
    pub fn settling_deadline(&self) -> Option<Instant> {
        self.settling_until
    }

    /// Whether settling is currently armed. Lets the monitor decide if it
    /// should enable the settling-wakeup branch in its select loop.
    pub fn is_settling(&self) -> bool {
        self.settling_until.is_some()
    }

    /// Clear settling without firing an emit. Used by the monitor when a
    /// `RunCommand` send fails so we don't leave the aggregator suppressed.
    pub fn clear_settling(&mut self) {
        self.settling_until = None;
        self.settling_started = None;
        self.settling_awaiting_first_event = false;
        self.suppress_window_emissions = false;
    }

    /// On window/layout events during settling, extend the debounce deadline
    /// but never past the safety ceiling. Called internally from `step`.
    fn maybe_extend_settling(&mut self, change: &ChangeType, now: Instant) {
        if self.settling_until.is_none() {
            return;
        }
        let is_window_event = matches!(
            change,
            ChangeType::Window | ChangeType::PaneLayout | ChangeType::PaneFocus
        );
        if !is_window_event {
            return;
        }
        if self.settling_awaiting_first_event {
            self.settling_awaiting_first_event = false;
            self.settling_started = Some(now);
        }
        let max_deadline = self.settling_started.unwrap_or(now) + SETTLING_MAX;
        let debounced = now + SETTLING_DEBOUNCE;
        self.settling_until = Some(debounced.min(max_deadline));
    }

    /// Mark the status line for refresh, but only if something it is rendered
    /// from actually changed.
    ///
    /// Every caller here is a window event, and a window event is the only
    /// thing that can move the status line — but most window events do not
    /// move it: the `list-windows` poll fires constantly and reports the same
    /// windows, and tmux re-announces the current window for a `select-window`
    /// that switched nothing (which is every pinned keyboard binding). The
    /// refresh those would trigger costs five `tmux display-message`
    /// subprocesses plus a shell per `#(…)` in `status-right`, run
    /// synchronously inside `to_state_update` while the client waits.
    ///
    /// Going through here rather than setting the flag directly also keeps the
    /// stored fingerprint in step, so a real change (a rename, say) refreshes
    /// once instead of again on the next poll.
    fn refresh_status_line_if_inputs_changed(&mut self) {
        let fingerprint = self.status_line_inputs_fingerprint();
        if self.status_line_fingerprint != Some(fingerprint) {
            self.status_line_fingerprint = Some(fingerprint);
            self.status_line_dirty = true;
        }
    }

    /// Hash of everything tmux renders the status line from: the session name
    /// (`status-left`), and each window's id, index, name and active flag (the
    /// `#{W:…}` window list). `status-right` is excluded on purpose — it is a
    /// fixed format string here, and the `#(…)` shell output inside it is
    /// exactly the part that is too expensive to sample for a change.
    fn status_line_inputs_fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        // A fixed-key hasher, not `RandomState`: the value is compared against
        // one stored earlier in this same process, but a seeded hasher would
        // still work — what matters is that it is stable for the process and
        // cheap. `DefaultHasher::new()` is both.
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.session_name.hash(&mut hasher);
        let mut windows: Vec<&WindowState> = self.windows.values().collect();
        windows.sort_by(|a, b| a.index.cmp(&b.index).then_with(|| a.id.cmp(&b.id)));
        for window in windows {
            window.id.hash(&mut hasher);
            window.index.hash(&mut hasher);
            window.name.hash(&mut hasher);
            window.active.hash(&mut hasher);
        }
        hasher.finish()
    }

    /// Refresh status line if dirty or stale, otherwise use cached value.
    /// Width is the total terminal width from pane layout, used for padding.
    fn get_status_line(&mut self, width: usize) -> String {
        let stale = self
            .status_line_refreshed_at
            .is_none_or(|at| at.elapsed() >= STATUS_LINE_MAX_AGE);
        if self.status_line_dirty || stale {
            // Native refreshes the status line via a `capture-pane` on the status
            // window. On wasm there is no tmux to call — the host supplies it via
            // `set_status_line`, so we keep the cached value here.
            #[cfg(feature = "native")]
            {
                // Keep the last good line on failure rather than blanking the
                // status bar: with the staleness fallback below, a transient
                // error would otherwise leave the user staring at an empty bar
                // until the next real window change.
                if let Ok(line) = crate::executor::capture_status_line(&self.session_name, width) {
                    self.cached_status_line = line;
                }
            }
            #[cfg(not(feature = "native"))]
            {
                let _ = width;
            }
            self.status_line_dirty = false;
            self.status_line_refreshed_at = Some(Instant::now());
        }
        self.cached_status_line.clone()
    }

    /// Set the status-line text directly (used by non-native hosts that fetch it
    /// out-of-band, e.g. the wasm/v86 path).
    pub fn set_status_line(&mut self, status: String) {
        self.cached_status_line = status;
        self.status_line_dirty = false;
        self.status_line_refreshed_at = Some(Instant::now());
    }

    /// Register in-flight capture-pane commands and return only pane IDs that
    /// were actually queued (not already pending). The caller must send the
    /// marker-bracketed `capture_command(..)` form for each returned ID —
    /// response routing relies on the markers, not on ordering.
    pub fn queue_captures(&mut self, pane_ids: &[String]) -> Vec<String> {
        let mut queued = Vec::new();
        for pane_id in pane_ids {
            if !self.pending_captures.contains(pane_id) {
                self.pending_captures.push_back(pane_id.clone());
                queued.push(pane_id.clone());
            }
        }
        queued
    }

    /// Get the list of window IDs
    pub fn window_ids(&self) -> Vec<String> {
        self.windows.keys().cloned().collect()
    }

    /// Window IDs split by how the client-size pass must size them. Tabs and
    /// floats take the whole viewport; each sidebar takes its own narrow column
    /// (the two differ in width), so those come back paired with that width.
    /// Returns `(viewport_sized, sidebar_sized_with_cols)`.
    pub fn window_ids_by_sizing(&self) -> (Vec<String>, Vec<(String, u32)>) {
        let mut viewport = Vec::new();
        let mut sidebars = Vec::new();
        for w in self.windows.values() {
            let cols = w
                .window_type
                .and_then(|t| crate::constants::sidebar_dock::cols(t, w.sidebar_cols));
            match cols {
                Some(cols) => sidebars.push((w.id.clone(), cols)),
                None => viewport.push(w.id.clone()),
            }
        }
        (viewport, sidebars)
    }

    /// The session-scoped focus request read off the last `list-windows` poll,
    /// if a shell helper has set one. See `tmux_options::FOCUS_REQUEST`.
    pub fn focus_request(&self) -> Option<&str> {
        self.focus_request.as_deref()
    }

    /// Provisional positional index for a brand-new window: one past the
    /// current highest. tmux window IDs (`@N`, monotonic allocation) and
    /// window indices (positional) are independent, so `WindowState::new`'s
    /// fallback of parsing the index out of the id is wrong the moment they
    /// diverge (any window close/create churn). `%window-add`/`%window-renamed`
    /// carry only the id; a correct index otherwise waits for the follow-up
    /// list-windows. A new window is almost always appended at the end, so
    /// max+1 is right immediately; list-windows corrects the rare
    /// insert-in-the-middle case.
    fn next_window_index(&self) -> u32 {
        self.windows
            .values()
            .map(|w| w.index)
            .max()
            .map_or(0, |m| m + 1)
    }

    /// Set up every untagged window in the attached session. Tabs no longer
    /// carry a marker — an untagged window IS a tab (derived at emit), so a
    /// native `tmux neww` window shows up as a tab with no adoption step. This
    /// returns the per-window `pane-border-status top` enforcement each new tab
    /// needs, plus a defensive re-tag for a float/sidebar window whose
    /// `@tmuxy-window-type` option somehow went missing (they're tagged
    /// atomically on creation, so this normally never fires).
    ///
    /// Name-based inference (defensive):
    /// - `float` or `__float_*` → Float
    /// - `__sidebar-left` / `__sidebar-right` → SidebarLeft / SidebarRight
    /// - anything else → Tab (untagged, no marker written)
    ///
    /// Every Tab window must carry `pane-border-status top` so its topmost pane
    /// sits at y=1, reserving the border row that PaneLayout draws the pane
    /// header into. `enforce_settings`' session-level `set` is NOT inherited by
    /// windows (verified: a fresh window reports `pane-border-status off`), and
    /// `set -g` risks a tmux 3.5a control-mode crash — so it must be applied
    /// per-window. `border_enforced` makes that idempotent now that tabs have no
    /// marker to gate on.
    pub fn collect_window_tag_commands(&mut self) -> Vec<String> {
        // Snapshot the untagged windows first so we don't hold a `self.windows`
        // borrow while touching `self.border_enforced`.
        let untagged: Vec<(String, String)> = self
            .windows
            .values()
            .filter(|w| w.window_type.is_none())
            .map(|w| (w.id.clone(), w.name.clone()))
            .collect();

        let window_type_opt = crate::constants::tmux_options::WINDOW_TYPE;
        let mut cmds = Vec::new();
        for (id, name) in untagged {
            if name == "float" || name.starts_with("__float_") {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.window_type = Some(WindowType::Float);
                }
                cmds.push(format!("set-option -w -t {id} {window_type_opt} float"));
            } else if let Some(side) = name.strip_prefix("__sidebar-") {
                let kind = match side {
                    "left" => WindowType::SidebarLeft,
                    _ => WindowType::SidebarRight,
                };
                if let Some(w) = self.windows.get_mut(&id) {
                    w.window_type = Some(kind);
                }
                cmds.push(format!(
                    "set-option -w -t {id} {window_type_opt} {}",
                    kind.as_str()
                ));
            } else if self.border_enforced.insert(id.clone()) {
                cmds.push(format!("set-option -w -t {id} pane-border-status top"));
                cmds.push(format!("set-option -w -t {id} pane-border-format ' '"));
            }
        }

        // Take the border row OFF every sidebar window, once. A sidebar is
        // drawn headerless and sized without that row, so leaving it on costs
        // the pane a line of content — and it is on by default: the global
        // `pane-border-status top` applies to every new window, whether the
        // window was first adopted as a tab above (the marker lands a beat after
        // `%window-add`) or arrived already typed because `list-windows` was
        // re-run right behind the create command.
        let bordered: Vec<String> = self
            .windows
            .values()
            .filter(|w| {
                w.window_type.is_some_and(WindowType::is_sidebar)
                    && !self.sidebar_border_cleared.contains(&w.id)
            })
            .map(|w| w.id.clone())
            .collect();
        for id in bordered {
            self.border_enforced.remove(&id);
            self.sidebar_border_cleared.insert(id.clone());
            cmds.push(format!("set-option -w -t {id} pane-border-status off"));
        }

        cmds
    }

    /// Check if any pane is currently in copy mode
    pub fn has_pane_in_copy_mode(&self) -> bool {
        self.panes.values().any(|p| p.in_mode)
    }

    /// Get copy mode pane info: (pane_id, scroll_position, height) for building capture-pane commands
    pub fn get_copy_mode_pane_info(&self) -> Vec<(String, u32, u32)> {
        self.panes
            .values()
            .filter(|p| p.in_mode && !p.window_id.is_empty())
            .map(|p| (p.id.clone(), p.scroll_position, p.height))
            .collect()
    }

    /// Sans-IO entry point. Drives the aggregator with one control-mode event
    /// and returns a `StepResult` describing every I/O action the runtime must
    /// perform plus the `change_type` of this step.
    ///
    /// The aggregator does no I/O itself — every command send, state emit,
    /// image store, and clipboard write is described, not performed. This
    /// makes the state machine fully testable without tokio: drive it with
    /// synthetic events and assert on the returned effects.
    ///
    /// `change_type` is always populated (even when `state_changed` is false)
    /// so the monitor's settling state machine can extend its deadline on
    /// window/layout changes that are currently being suppressed.
    pub fn step(&mut self, event: ControlModeEvent) -> StepResult {
        self.step_at(event, Instant::now())
    }

    /// Like `tick`, but sources `now` from the process clock. Used by non-native
    /// hosts (wasm) that drive the settling flush on a timer.
    pub fn tick_now(&mut self) -> Vec<SideEffect> {
        self.tick(Instant::now())
    }

    /// Decoded image bytes for a pane placement (PNG/etc.), for hosts that serve
    /// image bytes themselves (the native server uses `/api/images`; the wasm
    /// host resolves via `window.__tmuxyImageSrc`). Returns `(data, mime_type)`.
    pub fn image_data(&self, pane_id: &str, image_id: u32) -> Option<(Vec<u8>, String)> {
        self.panes
            .get(pane_id)
            .and_then(|p| p.image_store.get(&image_id))
            .map(|img| (img.data.clone(), img.mime_type.clone()))
    }

    /// Like `step`, but accepts an explicit `now` so callers (the monitor)
    /// can drive settling extension from `Ctx::clock` and tests can advance
    /// time deterministically.
    pub fn step_at(&mut self, event: ControlModeEvent, now: Instant) -> StepResult {
        let is_window_add = matches!(
            &event,
            ControlModeEvent::WindowAdd { .. } | ControlModeEvent::UnlinkedWindowAdd { .. }
        );
        let mut result = self.process_event(event);
        let mut effects = Vec::new();

        // Auto-adopt before anything else so emissions reflect tagged state.
        // When we tag windows on a step where process_event reported
        // state_changed=false (e.g. WindowAdd, which intentionally defers its
        // own emit), promote the step to a window-typed state change. Without
        // this, the frontend sees an untagged window until the next
        // state-changing event arrives — which can be 15s+ in CI under tmux
        // 3.4 when the CC stream is busy with sync_initial_state.
        let tag_cmds = self.collect_window_tag_commands();
        let tagged_any = !tag_cmds.is_empty();
        if tagged_any {
            effects.push(SideEffect::AdoptUntaggedWindows(tag_cmds));
            if !result.state_changed {
                result.state_changed = true;
                result.change_type = ChangeType::Window;
            }
        }

        // Image / clipboard side effects fire before list-pane refreshes so
        // that consumers see the same ordering as the legacy monitor path.
        for (pane_id, images) in result.new_images.iter() {
            if !images.is_empty() {
                effects.push(SideEffect::StoreImages {
                    pane_id: pane_id.clone(),
                    images: images.clone(),
                });
            }
        }
        for (pane_id, text) in result.clipboard_writes.iter() {
            effects.push(SideEffect::WriteClipboard {
                pane_id: pane_id.clone(),
                text: text.clone(),
            });
        }
        for cmd in result.commands.iter() {
            effects.push(SideEffect::SendTmuxCommand(cmd.clone()));
        }

        if is_window_add {
            effects.push(SideEffect::RefreshAfterWindowAdd);
        }

        if !result.panes_needing_refresh.is_empty() {
            effects.push(SideEffect::RefreshPanes {
                pane_ids: result.panes_needing_refresh.clone(),
            });
        }

        if let ChangeType::FlowPause { ref pane_id } = result.change_type {
            effects.push(SideEffect::ResumePane(pane_id.clone()));
        }

        if result.state_changed {
            effects.push(SideEffect::EmitState {
                change: result.change_type.clone(),
            });
        }

        // Extend settling AFTER computing effects — extension is driven by the
        // computed `change_type`, including the suppressed `state_changed=false`
        // case where settling still needs to be kept alive.
        self.maybe_extend_settling(&result.change_type, now);

        StepResult {
            effects,
            change_type: result.change_type,
        }
    }

    /// Time-driven transitions. Today this drains the settling deadline: when
    /// `now` is past `settling_until`, the aggregator clears its settling
    /// state, unsuppresses window emissions, and (if any events actually
    /// arrived during the window) yields a consolidated `EmitState`. If the
    /// safety ceiling fires with no events ever observed, the suppression
    /// flag is cleared silently — no emit, no foot-gun for the runtime.
    pub fn tick(&mut self, now: Instant) -> Vec<SideEffect> {
        let Some(deadline) = self.settling_until else {
            return Vec::new();
        };
        if now < deadline {
            return Vec::new();
        }
        let was_awaiting = self.settling_awaiting_first_event;
        self.settling_until = None;
        self.settling_started = None;
        self.settling_awaiting_first_event = false;
        self.suppress_window_emissions = false;
        if was_awaiting {
            // Safety timeout — no events arrived after the compound command.
            // Nothing to emit; just leave the aggregator unsuppressed.
            return Vec::new();
        }
        vec![SideEffect::EmitState {
            change: ChangeType::Full,
        }]
    }

    /// Shared body of the `%output` / `%extended-output` arms.
    fn output_result(&mut self, pane_id: String, content: &[u8]) -> ProcessEventResult {
        let (changed, new_imgs, clipboard) = self.handle_output(&pane_id, content);
        let new_images = if new_imgs.is_empty() {
            Vec::new()
        } else {
            vec![(pane_id.clone(), new_imgs)]
        };
        let clipboard_writes = clipboard
            .map(|text| vec![(pane_id.clone(), text)])
            .unwrap_or_default();
        ProcessEventResult {
            state_changed: changed,
            panes_needing_refresh: Vec::new(),
            change_type: if changed {
                ChangeType::PaneOutput { pane_id }
            } else {
                ChangeType::None
            },
            new_images,
            clipboard_writes,
            commands: Vec::new(),
        }
    }

    /// Process a control mode event.
    /// Returns information about state changes and any panes that need content refresh.
    pub fn process_event(&mut self, event: ControlModeEvent) -> ProcessEventResult {
        match event {
            // %output and %extended-output differ only in the extra metadata
            // the parser already discarded — one handler serves both.
            ControlModeEvent::Output { pane_id, content }
            | ControlModeEvent::ExtendedOutput {
                pane_id, content, ..
            } => self.output_result(pane_id, &content),

            ControlModeEvent::LayoutChange {
                window_id,
                layout,
                visible_layout,
                flags,
            } => {
                // Use full layout for pane existence (includes hidden panes during zoom).
                // Use visible_layout for rendered geometry (zoom adjusts sizes).
                let zoomed = flags.contains('Z');

                // Parse the full layout to track pane existence and membership
                let resized_panes = self.handle_layout_change(&window_id, &layout);

                // When zoomed, also parse visible_layout to update rendered geometry
                if zoomed {
                    // visible_layout shows only the zoomed pane at full window dimensions
                    self.update_pane_geometry_from_layout(&window_id, &visible_layout);
                }

                // Track zoom state on window
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.zoomed = zoomed;
                }

                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    panes_needing_refresh: resized_panes,
                    change_type: ChangeType::PaneLayout,
                    ..Default::default()
                }
            }

            // Unlinked window add: from other sessions — ignore.
            ControlModeEvent::UnlinkedWindowAdd { .. } => ProcessEventResult::default(),

            // Unlinked window close: fires for non-current windows in ANY session.
            // If the window exists in our state, it belongs to our session — remove it.
            // If not, it's from another session — ignore.
            ControlModeEvent::UnlinkedWindowClose { window_id } => {
                if self.windows.contains_key(&window_id) {
                    self.windows.remove(&window_id);
                    self.panes.retain(|_, p| p.window_id != window_id);
                    self.pending_captures
                        .retain(|id| self.panes.contains_key(id));
                    self.refresh_status_line_if_inputs_changed();
                    ProcessEventResult {
                        state_changed: !self.suppress_window_emissions,
                        change_type: ChangeType::Window,
                        ..Default::default()
                    }
                } else {
                    ProcessEventResult::default()
                }
            }

            ControlModeEvent::WindowAdd { window_id } => {
                // Assign a provisional positional index now (see
                // next_window_index) — `%window-add` carries only the id, and
                // WindowState::new's id-derived index is wrong once ids and
                // indices diverge (e.g. `tmuxy tab create` makes @1 at index 2).
                let provisional_index = self.next_window_index();
                self.windows.entry(window_id.clone()).or_insert_with(|| {
                    let mut w = WindowState::new(&window_id);
                    w.index = provisional_index;
                    w
                });
                self.refresh_status_line_if_inputs_changed();
                // Don't emit state yet - wait for WindowRenamed or list-windows
                // to populate the window name. This prevents brief flashes of
                // windows appearing with empty names (which breaks stack detection).
                ProcessEventResult::default()
            }

            ControlModeEvent::WindowClose { window_id } => {
                self.windows.remove(&window_id);
                self.border_enforced.remove(&window_id);
                self.sidebar_border_cleared.remove(&window_id);
                self.panes.retain(|_, p| p.window_id != window_id);
                self.pending_captures
                    .retain(|id| self.panes.contains_key(id));
                self.refresh_status_line_if_inputs_changed();
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::WindowRenamed { window_id, name } => {
                // Create window if it doesn't exist yet (rename can arrive before
                // add). Provisional positional index (see next_window_index) —
                // don't inherit WindowState::new's wrong id-derived index.
                let provisional_index = self.next_window_index();
                let window = self.windows.entry(window_id.clone()).or_insert_with(|| {
                    let mut w = WindowState::new(&window_id);
                    w.index = provisional_index;
                    w
                });
                window.name = name;
                self.refresh_status_line_if_inputs_changed();
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::WindowPaneChanged { window_id, pane_id } => {
                // Track active pane in window state (survives pane creation/deletion)
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.active_pane_id = Some(pane_id.clone());
                }
                // Update active pane flag on existing panes
                for pane in self.panes.values_mut() {
                    if pane.window_id == window_id {
                        pane.active = pane.id == pane_id;
                    }
                }
                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::PaneFocus,
                    ..Default::default()
                }
            }

            ControlModeEvent::PaneModeChanged { pane_id } => {
                // Toggle in_mode for the pane. %pane-mode-changed fires on both
                // entering and exiting copy mode, so toggling is correct.
                if let Some(pane) = self.panes.get_mut(&pane_id) {
                    pane.in_mode = !pane.in_mode;
                }
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::PaneFocus,
                    ..Default::default()
                }
            }

            ControlModeEvent::PasteBufferChanged { buffer_name } => {
                // tmux does not forward OSC 52 to control-mode clients, so a
                // copy-mode yank only surfaces as %paste-buffer-changed. The
                // native monitor reads the buffer out-of-band via a subprocess;
                // the push-based (wasm) path has only the control channel, so we
                // read it in-band, wrapped in sentinel lines that make the
                // response unambiguously identifiable among interleaved
                // capture-pane replies.
                self.pending_buffer_reads.push_back(buffer_name.clone());
                ProcessEventResult {
                    commands: vec![format!(
                        "display-message -p 'TMUXY_BUF_BEGIN' ; show-buffer -b '{buffer_name}' ; display-message -p 'TMUXY_BUF_END'"
                    )],
                    ..Default::default()
                }
            }

            ControlModeEvent::SessionWindowChanged { window_id, .. } => {
                // Update active window
                for (id, window) in self.windows.iter_mut() {
                    window.active = *id == window_id;
                }
                self.active_window_id = Some(window_id.clone());
                // tmux re-announces the current window for things that did not
                // change it — notably the `select-window -t @N` that pins every
                // keyboard binding to the visible tab. Only refresh the status
                // line if that actually moved something it renders.
                self.refresh_status_line_if_inputs_changed();

                // Refresh capture for every pane in the newly active window so
                // long-idle tabs don't show stale content after a switch. The
                // monitor batches these into a single capture-pane round-trip.
                let refresh: Vec<String> = self
                    .panes
                    .values()
                    .filter(|p| p.window_id == window_id)
                    .map(|p| p.id.clone())
                    .collect();

                ProcessEventResult {
                    state_changed: !self.suppress_window_emissions,
                    change_type: ChangeType::Window,
                    panes_needing_refresh: refresh,
                    ..Default::default()
                }
            }

            ControlModeEvent::CommandResponse {
                output, success, ..
            } => {
                // Marker-wrapped show-buffer responses (copy-mode yank mirror).
                // Each command in a control-mode command list gets its OWN
                // %begin/%end block, so the wrap arrives as three consecutive
                // responses: BEGIN marker → buffer content → END marker. The
                // marker blocks are unambiguous, so this can never be misread
                // as (or steal) a capture-pane response.
                let marker_line = output.trim_end_matches(['\r', '\n']);
                if marker_line == "TMUXY_BUF_BEGIN" {
                    self.buffer_read_armed = !self.pending_buffer_reads.is_empty();
                    return ProcessEventResult::default();
                }
                if marker_line == "TMUXY_BUF_END" {
                    self.buffer_read_armed = false;
                    return ProcessEventResult::default();
                }
                if self.buffer_read_armed {
                    self.buffer_read_armed = false;
                    self.pending_buffer_reads.pop_front();
                    let text = output.trim_end_matches(['\r', '\n']).to_string();
                    if success && !text.is_empty() {
                        return ProcessEventResult {
                            clipboard_writes: vec![(String::new(), text)],
                            ..Default::default()
                        };
                    }
                    return ProcessEventResult::default();
                }

                // Marker-routed capture-pane responses: every self-issued
                // capture is bracketed BEGIN(pane)/END (see capture_command),
                // so the block between the markers is attributed to its pane
                // exactly — never by arrival order or output-shape guessing.
                if let Some(rest) = marker_line.strip_prefix(CAPTURE_BEGIN_MARKER) {
                    // The id travels as bare digits (see capture_command) and
                    // may be surrounded by expansion padding — trim and
                    // re-prefix the `%`.
                    let digits = rest.trim().trim_start_matches('%');
                    if !digits.is_empty() {
                        self.capture_armed = Some(format!("%{digits}"));
                    }
                    return ProcessEventResult::default();
                }
                if marker_line == CAPTURE_END_MARKER {
                    self.capture_armed = None;
                    return ProcessEventResult::default();
                }
                if let Some(pane_id) = self.capture_armed.take() {
                    // In-flight bookkeeping is done for this pane regardless of
                    // the outcome — a wedged entry would freeze the pane's
                    // content preservation in to_state_update forever.
                    self.pending_captures.retain(|id| *id != pane_id);
                    if !success {
                        warn!(?pane_id, "capture command failed");
                        return ProcessEventResult::default();
                    }
                    if let Some(pane) = self.panes.get_mut(&pane_id) {
                        if pane.in_mode {
                            // In copy mode: process into separate copy_mode_content
                            // to avoid corrupting the main terminal state
                            pane.process_copy_mode_capture(output.as_bytes());
                        } else {
                            // Normal mode: reset and reprocess the main terminal
                            pane.reset_and_process_capture(output.as_bytes());

                            // After processing capture output, the vt100 cursor
                            // is at the end of the content (last row). Reposition
                            // it to tmux's actual cursor position.
                            let cursor_seq = format!(
                                "\x1b[{};{}H",
                                pane.tmux_cursor_y + 1,
                                pane.tmux_cursor_x + 1
                            );
                            safe_process(&mut pane.terminal, cursor_seq.as_bytes());
                        }
                        // Capture arrived — clear window-move suppression
                        self.panes_moved_window.remove(&pane_id);
                        return ProcessEventResult {
                            state_changed: true,
                            change_type: ChangeType::PaneOutput { pane_id },
                            ..Default::default()
                        };
                    }
                    // Pane was killed after the capture was sent — discard.
                    self.panes_moved_window.remove(&pane_id);
                    return ProcessEventResult::default();
                }

                // NOTE: every unmarked SUCCESSFUL response — including the
                // empty ack of each send-keys batch — intentionally falls
                // through to a Full change below. An attempted optimization
                // (return None for empty acks, sparing a full TmuxState
                // rebuild per keystroke) regressed keystroke routing after a
                // pane-group tab click: the compound run-shell's empty ack is
                // one of the signals the frontend's optimistic-swap
                // convergence rides on, and suppressing it sent the first
                // post-click keystroke to the stale pane (7-regression
                // group-click E2E). Revisit only after the self-issued
                // list-panes/list-windows commands are marker-routed like
                // captures, so command completions can be classified exactly
                // instead of by ack shape.

                // Not a capture-pane response - parse list-panes/list-windows responses to update state
                let resized_panes = if success {
                    self.handle_command_response(&output)
                } else {
                    Vec::new()
                };
                ProcessEventResult {
                    state_changed: true,
                    panes_needing_refresh: resized_panes,
                    change_type: ChangeType::Full, // Command responses may update many things,
                    ..Default::default()
                }
            }

            ControlModeEvent::SessionsChanged => {
                // %sessions-changed is a GLOBAL event sent to ALL control mode
                // clients when ANY session is created/destroyed. It does NOT mean
                // the current session's state changed. Suppress state emission to
                // prevent cross-session interference (e.g., E2E test sessions
                // causing spurious updates in the user's UI).
                ProcessEventResult::default()
            }
            ControlModeEvent::SessionChanged { session_name, .. } => {
                self.session_name = session_name;
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Session,
                    ..Default::default()
                }
            }
            ControlModeEvent::SessionRenamed { name, .. } => {
                self.session_name = name;
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Session,
                    ..Default::default()
                }
            }
            ControlModeEvent::Exit { .. } => ProcessEventResult {
                state_changed: true,
                change_type: ChangeType::Session,
                ..Default::default()
            },

            // ============================================
            // Flow Control Events (tmux 3.2+ pause-after)
            // ============================================
            ControlModeEvent::Pause { pane_id } => {
                if let Some(pane) = self.panes.get_mut(&pane_id) {
                    pane.paused = true;
                    return ProcessEventResult {
                        state_changed: true,
                        change_type: ChangeType::FlowPause { pane_id },
                        ..Default::default()
                    };
                }
                ProcessEventResult::default()
            }

            ControlModeEvent::Continue { pane_id } => {
                if let Some(pane) = self.panes.get_mut(&pane_id) {
                    pane.paused = false;
                    return ProcessEventResult {
                        state_changed: true,
                        change_type: ChangeType::FlowContinue { pane_id },
                        ..Default::default()
                    };
                }
                ProcessEventResult::default()
            }
        }
    }

    fn handle_output(
        &mut self,
        pane_id: &str,
        content: &[u8],
    ) -> (bool, Vec<(u32, super::images::StoredImage)>, Option<String>) {
        // Only process output for panes we know about from list-panes.
        // This prevents creating panes from other tmux sessions.
        // Panes are added via parse_list_panes_line() which sets window_id.
        if let Some(pane) = self.panes.get_mut(pane_id) {
            // Suppress output for panes that recently moved between windows
            // (e.g., break-pane). The VT100 was reset and a capture-pane is
            // pending — processing %output now would accumulate stale content
            // from the old window before the authoritative capture arrives.
            if self.panes_moved_window.contains(pane_id) {
                return (false, Vec::new(), None);
            }
            // Only process if pane has a valid window_id (was seen in list-panes)
            if !pane.window_id.is_empty() {
                let store_before: Vec<u32> = pane.image_store.keys().copied().collect();
                pane.process_output(content);
                // Collect newly added images
                let new_imgs: Vec<(u32, super::images::StoredImage)> = pane
                    .image_store
                    .iter()
                    .filter(|(id, _)| !store_before.contains(id))
                    .map(|(id, img)| (*id, img.clone()))
                    .collect();
                // Drain any OSC 52 clipboard request the app emitted in this chunk.
                let clipboard = pane.osc_parser.take_clipboard();
                return (true, new_imgs, clipboard);
            }
        }
        // Buffer output for panes not yet created in state.
        // During split, %output can arrive before %layout-change creates the pane.
        // Cap per-pane buffer and total entry count to prevent unbounded growth.
        if self.early_output.len() < 32 || self.early_output.contains_key(pane_id) {
            let buf = self.early_output.entry(pane_id.to_string()).or_default();
            buf.extend(content);
            if buf.len() > 8192 {
                let start = buf.len() - 8192;
                *buf = buf[start..].to_vec();
            }
        }
        (false, Vec::new(), None)
    }

    /// Handle layout change and return list of pane IDs that need content refresh.
    fn handle_layout_change(&mut self, window_id: &str, layout: &str) -> Vec<String> {
        if let Some(window) = self.windows.get_mut(window_id) {
            window.layout = layout.to_string();
        }

        // Parse layout to update pane positions and return panes that were resized
        self.parse_layout(window_id, layout)
    }

    /// Update only the geometry (x, y, width, height) of existing panes from a layout string.
    /// Does NOT create or remove panes. Used for visible_layout during zoom.
    fn update_pane_geometry_from_layout(&mut self, window_id: &str, layout: &str) {
        let layout = match layout.find(',') {
            Some(idx) => &layout[idx + 1..],
            None => return,
        };

        let parsed_panes = parse_layout_panes(layout);
        for lp in &parsed_panes {
            if let Some(pane) = self.panes.get_mut(&lp.id) {
                if pane.window_id == window_id {
                    pane.x = lp.x;
                    pane.y = lp.y;
                    let _ = pane.resize(lp.width, lp.height);
                }
            }
        }
    }

    /// Parse tmux layout string to extract pane positions, creating panes as needed.
    /// Returns a list of pane IDs that were resized.
    ///
    /// Layout format: `checksum,WxH,x,y,pane-id` (leaf) or
    ///                `checksum,WxH,x,y[children]` (vertical split) or
    ///                `checksum,WxH,x,y{children}` (horizontal split)
    ///
    /// This is the authoritative source for pane geometry. Panes discovered in the
    /// layout that don't exist in `self.panes` are created with default metadata.
    /// Panes in this window that are NOT in the layout are removed (reconciliation).
    fn parse_layout(&mut self, window_id: &str, layout: &str) -> Vec<String> {
        // Skip the checksum prefix (e.g., "abc123,")
        let layout = match layout.find(',') {
            Some(idx) => &layout[idx + 1..],
            None => return Vec::new(),
        };

        // Parse all pane geometries from the layout string
        let parsed_panes = parse_layout_panes(layout);
        if parsed_panes.is_empty() {
            return Vec::new();
        }

        // Look up the window's active pane for setting initial active flag on new panes
        let active_pane_id = self
            .windows
            .get(window_id)
            .and_then(|w| w.active_pane_id.clone());

        let mut resized_panes = Vec::new();
        let mut seen_panes: std::collections::HashSet<String> = std::collections::HashSet::new();

        for lp in &parsed_panes {
            seen_panes.insert(lp.id.clone());

            if let Some(pane) = self.panes.get_mut(&lp.id) {
                // Existing pane: update geometry and window assignment
                pane.x = lp.x;
                pane.y = lp.y;
                // Detect pane moving between windows (e.g., break-pane, swap-pane).
                // Reset the VT100 parser immediately to clear stale content from the
                // old window. Without this, %output events that arrive before the
                // capture-pane response would build on top of the stale buffer.
                let moved_window = pane.window_id != window_id;
                pane.window_id = window_id.to_string();
                pane.index = lp.index;
                let was_resized = pane.resize(lp.width, lp.height);
                if moved_window && !was_resized {
                    // resize() already resets VT100 when dimensions change.
                    // When only the window changed (same dimensions), reset manually.
                    pane.terminal = pane.fresh_terminal();
                    pane.image_parser.reset();
                    pane.content_dirty = true;
                    pane.cached_content = None;
                }
                if moved_window {
                    // Track that this pane moved windows so handle_output()
                    // suppresses stale %output until capture-pane arrives.
                    self.panes_moved_window.insert(lp.id.clone());
                }
                if was_resized || moved_window {
                    resized_panes.push(lp.id.clone());
                }
            } else {
                // New pane discovered in layout: create with geometry
                let mut pane = PaneState::new(&lp.id, lp.width, lp.height);
                pane.window_id = window_id.to_string();
                pane.index = lp.index;
                pane.x = lp.x;
                pane.y = lp.y;
                pane.active = active_pane_id.as_ref() == Some(&lp.id);
                // Replay any %output that arrived before this pane was created.
                // During split, %output often arrives before %layout-change.
                if let Some(early) = self.early_output.remove(&lp.id) {
                    pane.process_output(&early);
                }
                self.panes.insert(lp.id.clone(), pane);
                // Queue capture for new panes so their content is fetched
                // authoritatively. Layout dimensions may include the
                // pane-border-status row, causing a dimension mismatch with
                // list-panes that triggers a VT100 reset. The capture ensures
                // content is restored even if %output events are lost.
                resized_panes.push(lp.id.clone());
            }
        }

        // Reconcile: remove panes from this window that are no longer in the layout
        self.panes.retain(|pane_id, pane| {
            if pane.window_id == window_id {
                seen_panes.contains(pane_id)
            } else {
                true // keep panes from other windows
            }
        });

        // Prune in-flight captures for panes that no longer exist — their
        // marker-routed responses are discarded on arrival, and a dead entry
        // would freeze content preservation in to_state_update.
        self.pending_captures
            .retain(|id| self.panes.contains_key(id));

        resized_panes
    }

    /// Rebuild the hidden pane-group member map from a `LIST_STASH_PANES_CMD`
    /// response. Row shape: `stashmember,<pane>,<window>,<group-id>,<cmd>,<title>`
    /// (title is free text and last). Members without a group id are ignored.
    fn rebuild_stash_members(&mut self, output: &str) {
        let mut members = HashMap::new();
        for line in output.lines() {
            if !is_stash_member_line(line) {
                continue;
            }
            let parts: Vec<&str> = line.trim_start().splitn(6, ',').collect();
            if parts.len() < 6 {
                continue;
            }
            let pane_id = parts[1].trim();
            let window_id = parts[2].trim();
            let group_id = parts[3].trim();
            if !pane_id.starts_with('%') || group_id.is_empty() {
                continue;
            }
            members.insert(
                pane_id.to_string(),
                StashMember {
                    window_id: window_id.to_string(),
                    group_id: group_id.to_string(),
                    command: parts[4].to_string(),
                    title: parts[5].to_string(),
                },
            );
        }
        self.stash_members = members;
    }

    /// Handle command response (list-panes, list-windows) and return list of panes that were resized.
    fn handle_command_response(&mut self, output: &str) -> Vec<String> {
        // A stash-members response (LIST_STASH_PANES_CMD) is a self-contained
        // block: rebuild the hidden-member map from it and return, so its rows
        // never reach the active-session pane/window parsers below. An empty
        // block (no rows) can't be told apart from an errored/absent stash
        // session, so leave the map as-is on empty; `to_tmux_state` prunes any
        // member whose group no longer has a visible pane.
        if output.lines().any(is_stash_member_line) {
            self.rebuild_stash_members(output);
            return Vec::new();
        }

        // Track which panes we see in this response
        let mut seen_panes: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut resized_panes: Vec<String> = Vec::new();
        let mut is_list_panes_response = false;

        // Try to parse as list-panes output. Require the shape tmux actually
        // emits — `%<digits>,` at the start of the line — rather than "contains
        // a % and a comma" anywhere, so arbitrary RunCommand output flowing
        // through this same channel can't be mistaken for pane records and
        // conjure ghost panes into the aggregator.
        for line in output.lines() {
            if is_list_panes_line(line) {
                if let Some((pane_id, was_resized)) = self.parse_list_panes_line(line) {
                    seen_panes.insert(pane_id.clone());
                    if was_resized {
                        resized_panes.push(pane_id);
                    }
                    is_list_panes_response = true;
                }
            }
        }

        // If this was a list-panes response, remove panes that weren't seen
        // (they were deleted in tmux)
        if is_list_panes_response && !seen_panes.is_empty() {
            self.panes.retain(|pane_id, pane| {
                // Keep panes that were seen in this response
                if seen_panes.contains(pane_id) {
                    return true;
                }
                // Keep panes with empty window_id (from other sessions' output events)
                // They'll be filtered out in to_tmux_state anyway
                if pane.window_id.is_empty() {
                    return true;
                }
                // Remove panes that have a window_id but weren't in the list-panes response
                // (they were deleted)
                false
            });
            self.pending_captures
                .retain(|id| self.panes.contains_key(id));
        }

        // Try to parse as list-windows output
        let mut is_list_windows_response = false;
        let mut seen_windows: std::collections::HashSet<String> = std::collections::HashSet::new();
        for line in output.lines() {
            if line.contains('@') && line.contains(',') {
                // Extract window_id before parsing (first field starts with @)
                if let Some(wid) = line.split(',').next() {
                    let wid = wid.trim();
                    if wid.starts_with('@') {
                        seen_windows.insert(wid.to_string());
                    }
                }
                self.parse_list_windows_line(line);
                is_list_windows_response = true;
            }
        }

        // Remove windows that weren't in the list-windows response (deleted in tmux).
        if is_list_windows_response && !seen_windows.is_empty() {
            self.windows
                .retain(|window_id, _| seen_windows.contains(window_id));
        }

        // The `list-windows` poll runs constantly and almost always reports the
        // same windows with the same names, indices and active flag.
        if is_list_windows_response {
            self.refresh_status_line_if_inputs_changed();
        }

        resized_panes
    }

    /// Parse a line from list-panes output.
    /// Expected format: `%pane_id,pane_index,x,y,width,height,cursor_x,cursor_y,active,command,title,in_mode,copy_x,copy_y,scroll_position,window_id,border_title,alternate_on,mouse_any_flag,selection_present,selection_start_x,selection_start_y,history_size`
    /// Returns (pane_id, needs_capture) if successfully parsed.
    /// needs_capture is true if pane is new OR was resized.
    fn parse_list_panes_line(&mut self, line: &str) -> Option<(String, bool)> {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 11 {
            return None;
        }

        let pane_id = parts[0].trim();
        if !pane_id.starts_with('%') {
            return None;
        }

        let pane_index: u32 = parts[1].parse().unwrap_or(0);
        let x: u32 = parts[2].parse().unwrap_or(0);
        let y: u32 = parts[3].parse().unwrap_or(0);
        let width: u32 = parts[4].parse().unwrap_or(80);
        let height: u32 = parts[5].parse().unwrap_or(24);
        let cursor_x: u32 = parts[6].parse().unwrap_or(0);
        let cursor_y: u32 = parts[7].parse().unwrap_or(0);
        let active = parts[8] == "1";
        let command = parts[9].to_string();

        // The two free-text fields — pane_title (index 10) and border_title
        // (just after window_id) — can contain commas, which shift the
        // comma-split field positions. The structured fields around them are
        // not free-text, so locate the `window_id` anchor (`@<digits>`)
        // dynamically: it is immediately preceded by in_mode, copy_cursor_x,
        // copy_cursor_y, scroll_position. Everything between command and those
        // four fields is pane_title; everything between window_id and the fixed
        // 6-field tail is border_title.
        let num_tail_fields = 8;

        // Tail fields (fixed, never free-text): alternate_on, mouse_any_flag,
        // pane_marked, selection_present, selection_start_x, selection_start_y,
        // history_size, group_id (`@tmuxy-group-id`, `g<digits>` or empty).
        let (
            alternate_on,
            mouse_any_flag,
            marked,
            selection_present,
            selection_start_x,
            selection_start_y,
            history_size,
            group_id,
        ) = if parts.len() >= 19 {
            let last = parts.len() - 1;
            let gid = parts[last].trim();
            (
                parts[last - 7] == "1",
                parts[last - 6] == "1",
                parts[last - 5] == "1",
                parts[last - 4] == "1",
                parts[last - 3].parse::<u32>().unwrap_or(0),
                parts[last - 2].parse::<u64>().unwrap_or(0),
                parts[last - 1].parse::<u64>().unwrap_or(0),
                (!gid.is_empty()).then(|| gid.to_string()),
            )
        } else {
            (false, false, false, false, 0u32, 0u64, 0u64, None)
        };

        let mut title = String::new();
        let mut in_mode = false;
        let mut copy_cursor_x: u32 = 0;
        let mut copy_cursor_y: u32 = 0;
        let mut scroll_position: u32 = 0;
        let mut window_id = String::new();
        let mut border_title = String::new();
        let mut found_boundary = false;

        if parts.len() > num_tail_fields {
            let is_intlike = |s: &str| s.is_empty() || s.parse::<u32>().is_ok();
            // window_id sits at index >= 15 (command=9, title>=1 field at 10,
            // then 4 structured fields, then window_id). Scan the middle region.
            for i in 15..(parts.len() - num_tail_fields) {
                let val = parts[i];
                if val.starts_with('@')
                    && val.len() > 1
                    && val[1..].chars().all(|c| c.is_ascii_digit())
                    && (parts[i - 4] == "0" || parts[i - 4] == "1")
                    && is_intlike(parts[i - 3])
                    && is_intlike(parts[i - 2])
                    && is_intlike(parts[i - 1])
                {
                    title = parts[10..i - 4].join(",");
                    in_mode = parts[i - 4] == "1";
                    copy_cursor_x = parts[i - 3].parse().unwrap_or(0);
                    copy_cursor_y = parts[i - 2].parse().unwrap_or(0);
                    scroll_position = parts[i - 1].parse().unwrap_or(0);
                    window_id = val.to_string();
                    border_title = parts[i + 1..parts.len() - num_tail_fields].join(",");
                    found_boundary = true;
                    break;
                }
            }
        }

        // Fallback to fixed-offset parsing when the anchor wasn't found (e.g. a
        // truncated line or a future format change). border_title is still
        // recovered from the region before the fixed tail.
        if !found_boundary {
            title = parts.get(10).map(|s| s.to_string()).unwrap_or_default();
            in_mode = parts.get(11).map(|s| *s == "1").unwrap_or(false);
            copy_cursor_x = parts.get(12).and_then(|s| s.parse().ok()).unwrap_or(0);
            copy_cursor_y = parts.get(13).and_then(|s| s.parse().ok()).unwrap_or(0);
            scroll_position = parts.get(14).and_then(|s| s.parse().ok()).unwrap_or(0);
            window_id = parts.get(15).map(|s| s.to_string()).unwrap_or_default();
            border_title = if parts.len() > 16 + num_tail_fields {
                parts[16..parts.len() - num_tail_fields].join(",")
            } else {
                parts.get(16).map(|s| s.to_string()).unwrap_or_default()
            };
        }

        let pane_id_string = pane_id.to_string();

        // Check if this is a new pane
        let is_new_pane = !self.panes.contains_key(&pane_id_string);

        let pane = self
            .panes
            .entry(pane_id_string.clone())
            .or_insert_with(|| PaneState::new(pane_id, width, height));

        // Replay any early %output that arrived before this pane was created
        if is_new_pane {
            if let Some(early) = self.early_output.remove(&pane_id_string) {
                pane.process_output(&early);
            }
        }

        pane.index = pane_index;
        pane.x = x;
        pane.y = y;
        let was_resized = pane.resize(width, height);
        pane.active = active;
        pane.command = command;
        pane.title = title;
        pane.border_title = border_title;
        let was_in_mode = pane.in_mode;
        pane.in_mode = in_mode;
        if was_in_mode && !in_mode {
            pane.copy_mode_content = None;
        }
        pane.copy_cursor_x = copy_cursor_x;
        pane.copy_cursor_y = copy_cursor_y;
        pane.scroll_position = scroll_position;
        pane.window_id = window_id;
        pane.alternate_on = alternate_on;
        pane.mouse_any_flag = mouse_any_flag;
        pane.marked = marked;
        pane.selection_present = selection_present;
        pane.selection_start_x = selection_start_x;
        pane.selection_start_y = selection_start_y;
        pane.history_size = history_size;
        pane.group_id = group_id;

        // Store tmux's authoritative cursor position
        pane.tmux_cursor_x = cursor_x;
        pane.tmux_cursor_y = cursor_y;

        // Need to capture if pane is new, was resized, or just exited copy mode
        // (exiting copy mode requires re-syncing the vt100 terminal with tmux's actual content,
        // since %output events during copy mode may have desynchronized it)
        let exited_copy_mode = was_in_mode && !in_mode;
        let needs_capture = is_new_pane || was_resized || exited_copy_mode;
        Some((pane_id_string, needs_capture))
    }

    /// Parse a line from list-windows output. Expected format (comma-separated,
    /// see constants::LIST_WINDOWS_CMD):
    /// `@id,index,active,window_type,float_parent,float_width,float_height,float_drawer,float_bg,float_noheader,focus_request,sidebar_cols,sidebar_hidden,zoomed,name`
    /// `window_name` is LAST and free text — we `splitn` so its own commas stay
    /// in the trailing field and can't shift any parsed column. Every column
    /// after `active` is a `@tmuxy-*` user option that may be empty.
    fn parse_list_windows_line(&mut self, line: &str) {
        // 15 fields; splitn keeps window_name (the 15th) intact even with commas.
        let parts: Vec<&str> = line.splitn(15, ',').collect();
        if parts.len() < 14 {
            return;
        }

        let window_id = parts[0].trim();
        if !window_id.starts_with('@') {
            return;
        }

        let index: u32 = parts[1].parse().unwrap_or(0);
        let active = parts[2] == "1";
        let name = parts.get(14).map(|s| s.to_string()).unwrap_or_default();

        let opt = |idx: usize| -> Option<String> {
            parts
                .get(idx)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        };

        let window_type = opt(3).and_then(|s| WindowType::parse(&s));
        let float_parent = opt(4);
        let float_width = opt(5).and_then(|s| s.parse::<u32>().ok());
        let float_height = opt(6).and_then(|s| s.parse::<u32>().ok());
        let float_drawer = opt(7);
        let float_bg = opt(8);
        let float_noheader = opt(9).is_some_and(|s| s == "1");
        // Session-scoped, so every row carries the same value and the last one
        // parsed wins. Read from this poll rather than its own `show-options`
        // because the poll already runs; see `tmux_options::FOCUS_REQUEST`.
        self.focus_request = opt(10);
        // A sidebar column the user has dragged off its default width.
        let sidebar_cols = opt(11).and_then(|s| s.parse::<u32>().ok());
        // A sidebar column the user has closed (its pane is kept alive).
        let sidebar_hidden = opt(12).is_some_and(|s| s == "1");
        // Authoritative zoom state. Deriving it only from `%layout-change`
        // flags loses it whenever window state is rebuilt from list-windows —
        // e.g. every fresh client connect, which is exactly when a client
        // attaching to an already-zoomed window needs it.
        let zoomed = opt(13).is_some_and(|s| s == "1");

        let window = self
            .windows
            .entry(window_id.to_string())
            .or_insert_with(|| WindowState::new(window_id));

        window.index = index;
        window.name = name;
        window.active = active;
        window.window_type = window_type;
        window.zoomed = zoomed;
        window.float_parent = float_parent;
        window.float_width = float_width;
        window.float_height = float_height;
        window.float_drawer = float_drawer;
        window.float_bg = float_bg;
        window.float_noheader = float_noheader;
        window.sidebar_cols = sidebar_cols;
        window.sidebar_hidden = sidebar_hidden;

        if active {
            self.active_window_id = Some(window_id.to_string());
        }
    }

    /// Convert current state to a StateUpdate (full or delta) for efficient transmission.
    /// Returns Full state on first call or when too many changes occurred.
    /// Returns Delta with only changed fields on subsequent calls.
    /// Returns None when nothing has changed (empty delta).
    pub fn to_state_update(&mut self) -> Option<crate::StateUpdate> {
        let mut current = self.to_tmux_state();

        // Preserve previous content for panes with pending captures.
        // After resize, pane.resize() clears the VT100 parser but capture-pane
        // hasn't arrived yet. Without this, to_tmux_state() extracts empty/truncated
        // content from the cleared parser and emits it to the frontend.
        if !self.pending_captures.is_empty() {
            if let Some(ref prev) = self.prev_state {
                let prev_panes: std::collections::HashMap<&str, &crate::TmuxPane> =
                    prev.panes.iter().map(|p| (p.tmux_id.as_str(), p)).collect();
                for pane in &mut current.panes {
                    if self.pending_captures.contains(&pane.tmux_id) {
                        // Don't preserve prev_state for panes that moved windows.
                        // Their prev_state has stale content from the old window;
                        // better to show the current (empty/reset) VT100 content
                        // until the authoritative capture-pane response arrives.
                        if self.panes_moved_window.contains(&pane.tmux_id) {
                            continue;
                        }
                        if let Some(prev_pane) = prev_panes.get(pane.tmux_id.as_str()) {
                            pane.content = prev_pane.content.clone();
                            pane.cursor_x = prev_pane.cursor_x;
                            pane.cursor_y = prev_pane.cursor_y;
                        }
                    }
                }
            }
        }

        // First state or no previous state - send full
        let prev = match &self.prev_state {
            None => {
                self.prev_state = Some(current.clone());
                self.delta_seq = 1;
                return Some(crate::StateUpdate::Full { state: current });
            }
            Some(prev) => prev,
        };

        // Compute delta (seq assigned after empty check)
        let mut delta = crate::TmuxDelta::new(0);

        // Check for dimension changes
        if current.total_width != prev.total_width {
            delta.total_width = Some(current.total_width);
        }
        if current.total_height != prev.total_height {
            delta.total_height = Some(current.total_height);
        }

        // Check for active window/pane changes
        if current.active_window_id != prev.active_window_id {
            delta.active_window_id = current.active_window_id.clone();
        }
        if current.active_pane_id != prev.active_pane_id {
            delta.active_pane_id = current.active_pane_id.clone();
        }

        // Check for status line changes
        if current.status_line != prev.status_line {
            delta.status_line = Some(current.status_line.clone());
        }

        // A queued focus request, or its clearing. The empty string is the
        // "cleared" signal — `None` on the delta means "unchanged", so the
        // absence of the option cannot be expressed by `None`.
        if current.focus_request != prev.focus_request {
            delta.focus_request = Some(current.focus_request.clone().unwrap_or_default());
        }

        // Build maps for efficient lookup
        let prev_panes: std::collections::HashMap<&str, &crate::TmuxPane> =
            prev.panes.iter().map(|p| (p.tmux_id.as_str(), p)).collect();
        let curr_panes: std::collections::HashMap<&str, &crate::TmuxPane> = current
            .panes
            .iter()
            .map(|p| (p.tmux_id.as_str(), p))
            .collect();

        let prev_windows: std::collections::HashMap<&str, &crate::TmuxWindow> =
            prev.windows.iter().map(|w| (w.id.as_str(), w)).collect();
        let curr_windows: std::collections::HashMap<&str, &crate::TmuxWindow> =
            current.windows.iter().map(|w| (w.id.as_str(), w)).collect();

        // Track pane changes
        let mut pane_deltas: std::collections::HashMap<String, Option<crate::PaneDelta>> =
            std::collections::HashMap::new();
        let mut new_panes: Vec<crate::TmuxPane> = Vec::new();

        // Find new and modified panes
        for (id, curr_pane) in &curr_panes {
            match prev_panes.get(id) {
                None => {
                    // New pane
                    new_panes.push((*curr_pane).clone());
                }
                Some(prev_pane) => {
                    // Check for changes
                    let pane_delta = self.compute_pane_delta(prev_pane, curr_pane);
                    if !pane_delta.is_empty() {
                        pane_deltas.insert(id.to_string(), Some(pane_delta));
                    }
                }
            }
        }

        // Find removed panes
        for id in prev_panes.keys() {
            if !curr_panes.contains_key(id) {
                pane_deltas.insert(id.to_string(), None); // None = removed
            }
        }

        // Track window changes
        let mut window_deltas: std::collections::HashMap<String, Option<crate::WindowDelta>> =
            std::collections::HashMap::new();
        let mut new_windows: Vec<crate::TmuxWindow> = Vec::new();

        // Find new and modified windows
        for (id, curr_window) in &curr_windows {
            match prev_windows.get(id) {
                None => {
                    new_windows.push((*curr_window).clone());
                }
                Some(prev_window) => {
                    let window_delta = self.compute_window_delta(prev_window, curr_window);
                    if !window_delta.is_empty() {
                        window_deltas.insert(id.to_string(), Some(window_delta));
                    }
                }
            }
        }

        // Find removed windows
        for id in prev_windows.keys() {
            if !curr_windows.contains_key(id) {
                window_deltas.insert(id.to_string(), None);
            }
        }

        // Populate delta fields if there are changes
        if !pane_deltas.is_empty() {
            delta.panes = Some(pane_deltas);
        }
        if !new_panes.is_empty() {
            delta.new_panes = Some(new_panes);
        }
        if !window_deltas.is_empty() {
            delta.windows = Some(window_deltas);
        }
        if !new_windows.is_empty() {
            delta.new_windows = Some(new_windows);
        }

        // Nothing changed — skip emission entirely
        if delta.is_empty() {
            return None;
        }

        // Has real changes — assign seq, update prev_state
        self.delta_seq += 1;
        delta.seq = self.delta_seq;
        self.prev_state = Some(current.clone());

        // If delta is too large (> 50% of panes changed), send full state instead
        let total_panes = current.panes.len();
        let changed_panes = delta.panes.as_ref().map(|p| p.len()).unwrap_or(0)
            + delta.new_panes.as_ref().map(|p| p.len()).unwrap_or(0);

        if total_panes > 0 && changed_panes > total_panes / 2 {
            // Too many changes - send full state
            Some(crate::StateUpdate::Full { state: current })
        } else {
            Some(crate::StateUpdate::Delta { delta })
        }
    }

    /// Compute delta between two panes
    fn compute_pane_delta(
        &self,
        prev: &crate::TmuxPane,
        curr: &crate::TmuxPane,
    ) -> crate::PaneDelta {
        let mut delta = crate::PaneDelta::default();

        if prev.window_id != curr.window_id {
            delta.window_id = Some(curr.window_id.clone());
        }
        // Line-level content diff: only include changed lines. Panes whose
        // content is untouched share the same Arc between prev and curr
        // snapshots, so `ptr_eq` skips the per-line walk entirely.
        if !std::sync::Arc::ptr_eq(&prev.content, &curr.content) {
            let mut changed_lines: std::collections::HashMap<usize, crate::TerminalLine> =
                std::collections::HashMap::new();
            let max_lines = curr.content.len().max(prev.content.len());
            for i in 0..max_lines {
                let prev_line = prev.content.get(i);
                let curr_line = curr.content.get(i);
                if prev_line != curr_line {
                    changed_lines.insert(i, curr_line.cloned().unwrap_or_default());
                }
            }
            if !changed_lines.is_empty() {
                delta.content = Some(changed_lines);
            }
        }
        if prev.cursor_x != curr.cursor_x {
            delta.cursor_x = Some(curr.cursor_x);
        }
        if prev.cursor_y != curr.cursor_y {
            delta.cursor_y = Some(curr.cursor_y);
        }
        if prev.width != curr.width {
            delta.width = Some(curr.width);
        }
        if prev.height != curr.height {
            delta.height = Some(curr.height);
        }
        if prev.x != curr.x {
            delta.x = Some(curr.x);
        }
        if prev.y != curr.y {
            delta.y = Some(curr.y);
        }
        if prev.active != curr.active {
            delta.active = Some(curr.active);
        }
        if prev.command != curr.command {
            delta.command = Some(curr.command.clone());
        }
        if prev.title != curr.title {
            delta.title = Some(curr.title.clone());
        }
        if prev.border_title != curr.border_title {
            delta.border_title = Some(curr.border_title.clone());
        }
        if prev.group_id != curr.group_id {
            // `Some(None)` clears the group id (pane left a group); `Some(Some)`
            // sets it. `skip_serializing_if` on the outer Option keeps unchanged
            // panes off the wire.
            delta.group_id = Some(curr.group_id.clone());
        }
        if prev.in_mode != curr.in_mode {
            delta.in_mode = Some(curr.in_mode);
        }
        if prev.copy_cursor_x != curr.copy_cursor_x {
            delta.copy_cursor_x = Some(curr.copy_cursor_x);
        }
        if prev.copy_cursor_y != curr.copy_cursor_y {
            delta.copy_cursor_y = Some(curr.copy_cursor_y);
        }
        if prev.alternate_on != curr.alternate_on {
            delta.alternate_on = Some(curr.alternate_on);
        }
        if prev.mouse_any_flag != curr.mouse_any_flag {
            delta.mouse_any_flag = Some(curr.mouse_any_flag);
        }
        if prev.marked != curr.marked {
            delta.marked = Some(curr.marked);
        }
        if prev.paused != curr.paused {
            delta.paused = Some(curr.paused);
        }
        if prev.history_size != curr.history_size {
            delta.history_size = Some(curr.history_size);
        }
        if prev.selection_present != curr.selection_present {
            delta.selection_present = Some(curr.selection_present);
        }
        if prev.selection_start_x != curr.selection_start_x {
            delta.selection_start_x = Some(curr.selection_start_x);
        }
        if prev.selection_start_y != curr.selection_start_y {
            delta.selection_start_y = Some(curr.selection_start_y);
        }
        if prev.images != curr.images {
            delta.images = Some(curr.images.clone());
        }
        if prev.cursor_shape != curr.cursor_shape {
            delta.cursor_shape = Some(curr.cursor_shape);
        }
        if prev.cursor_hidden != curr.cursor_hidden {
            delta.cursor_hidden = Some(curr.cursor_hidden);
        }
        delta
    }

    /// Compute delta between two windows
    fn compute_window_delta(
        &self,
        prev: &crate::TmuxWindow,
        curr: &crate::TmuxWindow,
    ) -> crate::WindowDelta {
        let mut delta = crate::WindowDelta::default();

        if prev.name != curr.name {
            delta.name = Some(curr.name.clone());
        }
        if prev.active != curr.active {
            delta.active = Some(curr.active);
        }
        if prev.window_type != curr.window_type {
            delta.window_type = Some(curr.window_type);
        }
        if prev.float_parent != curr.float_parent {
            delta.float_parent = Some(curr.float_parent.clone());
        }
        if prev.float_width != curr.float_width {
            delta.float_width = Some(curr.float_width);
        }
        if prev.float_height != curr.float_height {
            delta.float_height = Some(curr.float_height);
        }
        if prev.float_drawer != curr.float_drawer {
            delta.float_drawer = Some(curr.float_drawer.clone());
        }
        if prev.float_bg != curr.float_bg {
            delta.float_bg = Some(curr.float_bg.clone());
        }
        if prev.float_noheader != curr.float_noheader {
            delta.float_noheader = Some(curr.float_noheader);
        }
        if prev.sidebar_cols != curr.sidebar_cols {
            delta.sidebar_cols = Some(curr.sidebar_cols);
        }
        if prev.sidebar_hidden != curr.sidebar_hidden {
            delta.sidebar_hidden = Some(curr.sidebar_hidden);
        }
        if prev.zoomed != curr.zoomed {
            delta.zoomed = Some(curr.zoomed);
        }

        delta
    }

    /// Convert current state to TmuxState for the frontend.
    pub fn to_tmux_state(&mut self) -> TmuxState {
        let active_window = self.active_window_id.as_ref();

        // Send panes from every window in the session. The frontend filters
        // by activeWindowId via selectVisiblePanes, so panes from inactive
        // windows live harmlessly in context.panes[] — and that cache is
        // what makes SELECT_TAB feel instant: the optimistic activeWindowId
        // flip can render the target tab without waiting for the server
        // round-trip. Hidden pane-group and float windows ride along on the
        // same code path (no special-casing needed once the active-window
        // filter is gone).
        let matching_pane_ids: Vec<String> = self
            .panes
            .values()
            .filter(|p| !p.window_id.is_empty())
            .map(|p| p.id.clone())
            .collect();

        // Tmux stores `pane.active` per window — every window has its own
        // active pane. Collapse to a session-wide single active pane so the
        // frontend can treat `pane.active` as a uniqueness flag (used by
        // keyboard routing, optimistic-prediction lookups, focus indicators).
        // Without this collapse, multiple panes report active=true and any
        // downstream code that assumes "at most one active pane" misbehaves.
        let mut panes: Vec<TmuxPane> = matching_pane_ids
            .iter()
            .filter_map(|id| {
                self.panes.get_mut(id).map(|p| {
                    let mut pane = p.build_tmux_pane();
                    pane.active =
                        pane.active && active_window.map(|w| pane.window_id == *w).unwrap_or(false);
                    pane
                })
            })
            .collect();

        // Append the hidden pane-group members parked in the stash session as
        // lightweight stubs, so a group's tab strip can render every member even
        // though only the visible one is a real pane in this session. Prune
        // members whose group no longer has a visible pane here (the group was
        // dissolved, or its tab was closed wholesale) — those are orphans, not
        // tabs. The stub's stash `window_id` is never the active window, so
        // `selectVisiblePanes` keeps it out of the layout automatically.
        let active_group_ids: std::collections::HashSet<&str> = self
            .panes
            .values()
            .filter_map(|p| p.group_id.as_deref())
            .collect();
        self.stash_members
            .retain(|_, m| active_group_ids.contains(m.group_id.as_str()));
        for (pane_id, member) in &self.stash_members {
            panes.push(stash_member_stub(pane_id, member));
        }

        let windows: Vec<TmuxWindow> = self.windows.values().map(|w| w.to_tmux_window()).collect();

        // Calculate total dimensions
        let total_width = panes.iter().map(|p| p.x + p.width).max().unwrap_or(80);
        let total_height = panes.iter().map(|p| p.y + p.height).max().unwrap_or(24);

        // Find the active pane ID from the active window
        // (each window has its own active pane, we want the one in the active window)
        let active_pane_id = panes
            .iter()
            .find(|p| p.active && active_window.map(|w| p.window_id == *w).unwrap_or(false))
            .or_else(|| panes.iter().find(|p| p.active))
            .map(|p| p.tmux_id.clone());

        // Get status line (uses cache if not dirty)
        let status_line = self.get_status_line(total_width as usize);

        TmuxState {
            session_name: self.session_name.clone(),
            active_window_id: self.active_window_id.clone(),
            active_pane_id,
            panes,
            windows,
            total_width,
            total_height,
            status_line,
            focus_request: self.focus_request.clone(),
        }
    }
}

impl Default for StateAggregator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manually seat a pane in the aggregator so handle_output() processes it
    /// (handle_output rejects panes that haven't been seen in list-panes).
    fn seed_pane(agg: &mut StateAggregator, pane_id: &str, window_id: &str) {
        let mut pane = PaneState::new(pane_id, 80, 24);
        pane.window_id = window_id.to_string();
        agg.panes.insert(pane_id.to_string(), pane);
    }

    /// Empty command acks MUST keep reporting a Full change.
    ///
    /// This pins the revert of an attempted optimization (empty acks →
    /// `ChangeType::None`): the frontend's pane-group swap convergence rides
    /// on ack-driven emissions, and silencing them routed the first
    /// post-click keystroke to the stale pane (7-regression group-click
    /// E2E). Do not silence empty acks until command completions are
    /// marker-routed and can be classified exactly.
    #[test]
    fn empty_command_ack_still_emits_full_change() {
        let mut agg = StateAggregator::new();
        seed_pane(&mut agg, "%0", "@0");

        let r = agg.process_event(ControlModeEvent::CommandResponse {
            timestamp: 0,
            command_num: 0,
            output: String::new(),
            success: true,
        });
        assert!(r.state_changed, "empty ack must still emit");
        assert!(matches!(r.change_type, ChangeType::Full));
    }

    /// Arbitrary command output must not be mistaken for list-panes records.
    ///
    /// `RunCommand` output flows through the same response channel, so a line
    /// that merely contains a `%` and a comma used to be fed to the pane
    /// parser and could conjure ghost panes.
    #[test]
    fn non_list_panes_output_does_not_create_panes() {
        let mut agg = StateAggregator::new();
        let before = agg.panes.len();

        agg.process_event(ControlModeEvent::CommandResponse {
            timestamp: 0,
            command_num: 0,
            // Shapes that pass the old `contains('%') && contains(',')` sniff.
            output: "100% done, thanks\ncpu: 3%, mem: 40%\n[%foo,bar]".to_string(),
            success: true,
        });

        assert_eq!(agg.panes.len(), before, "no ghost panes may be created");
    }

    #[test]
    fn is_list_panes_line_matches_only_real_pane_records() {
        assert!(is_list_panes_line("%0,1,0,0,80,24"));
        assert!(is_list_panes_line("%12,3,"));
        assert!(!is_list_panes_line("100% done, thanks"));
        assert!(!is_list_panes_line("%foo,bar"));
        assert!(!is_list_panes_line("%0"));
        assert!(!is_list_panes_line("x%0,1"));
        assert!(!is_list_panes_line(""));
    }

    /// A response between the capture markers is attributed to exactly the
    /// pane named by the BEGIN marker — and unmarked responses (e.g. a
    /// send-keys ack with EMPTY output, indistinguishable in shape from
    /// capturing a blank pane) can never steal a pending capture. This was
    /// the pane-content-misattribution bug: under command churn one pane
    /// rendered another pane's capture, or none at all.
    #[test]
    fn capture_routing_is_marker_exact_and_theft_proof() {
        let mut agg = StateAggregator::new();
        seed_pane(&mut agg, "%0", "@0");
        seed_pane(&mut agg, "%1", "@0");
        agg.queue_captures(&["%0".to_string(), "%1".to_string()]);

        let response = |output: &str| ControlModeEvent::CommandResponse {
            timestamp: 0,
            command_num: 0,
            output: output.to_string(),
            success: true,
        };

        // An interleaved unmarked ack (empty output) — must NOT be consumed
        // as a capture for %0.
        let r = agg.process_event(response(""));
        assert!(
            !matches!(r.change_type, ChangeType::PaneOutput { .. }),
            "unmarked empty ack must not be routed as a capture"
        );

        // %1's capture arrives FIRST (marker-bracketed) — attribution must
        // follow the marker, not the queue order.
        agg.process_event(response(&format!("{CAPTURE_BEGIN_MARKER} 1\n")));
        let r = agg.process_event(response("PANE_ONE_CONTENT\n"));
        assert!(
            matches!(r.change_type, ChangeType::PaneOutput { ref pane_id } if pane_id == "%1"),
            "marked capture must be attributed to the pane in the marker"
        );
        agg.process_event(response(&format!("{CAPTURE_END_MARKER}\n")));
        assert_eq!(
            agg.panes.get_mut("%1").unwrap().get_content()[0]
                .iter()
                .map(|c| c.char.clone())
                .collect::<String>()
                .trim_end(),
            "PANE_ONE_CONTENT"
        );

        // %0's capture follows and lands in %0 — no shifted attribution.
        agg.process_event(response(&format!("{CAPTURE_BEGIN_MARKER} 0\n")));
        let r = agg.process_event(response("PANE_ZERO_CONTENT\n"));
        assert!(matches!(r.change_type, ChangeType::PaneOutput { ref pane_id } if pane_id == "%0"));
        agg.process_event(response(&format!("{CAPTURE_END_MARKER}\n")));
        assert_eq!(
            agg.panes.get_mut("%0").unwrap().get_content()[0]
                .iter()
                .map(|c| c.char.clone())
                .collect::<String>()
                .trim_end(),
            "PANE_ZERO_CONTENT"
        );

        // Both in-flight entries were consumed.
        assert!(agg.pending_captures.is_empty());
    }

    /// tmux 3.7 strftime-expands display-message output: `%<digits>` in a
    /// marker comes back mangled (observed: 67 spaces of padding). The id
    /// therefore travels as bare digits and the router must tolerate
    /// arbitrary padding around it.
    #[test]
    fn capture_marker_survives_strftime_padding() {
        let mut agg = StateAggregator::new();
        seed_pane(&mut agg, "%69", "@0");
        agg.queue_captures(&["%69".to_string()]);

        let response = |output: &str| ControlModeEvent::CommandResponse {
            timestamp: 0,
            command_num: 0,
            output: output.to_string(),
            success: true,
        };
        // Real tmux 3.7 output shape for 'TMUXY_CAP_BEGIN 69'-style markers,
        // with expansion padding thrown in.
        agg.process_event(response(&format!(
            "{CAPTURE_BEGIN_MARKER}                    69\n"
        )));
        let r = agg.process_event(response("PADDED_OK\n"));
        assert!(
            matches!(r.change_type, ChangeType::PaneOutput { ref pane_id } if pane_id == "%69")
        );
        agg.process_event(response(&format!("{CAPTURE_END_MARKER}\n")));
        assert!(agg.pending_captures.is_empty());
    }

    /// A marked capture for a pane killed mid-flight is discarded — and its
    /// in-flight entry is released so content preservation can't wedge.
    #[test]
    fn capture_for_dead_pane_is_discarded_and_released() {
        let mut agg = StateAggregator::new();
        seed_pane(&mut agg, "%0", "@0");
        agg.queue_captures(&["%9".to_string()]);

        let response = |output: &str| ControlModeEvent::CommandResponse {
            timestamp: 0,
            command_num: 0,
            output: output.to_string(),
            success: true,
        };
        agg.process_event(response(&format!("{CAPTURE_BEGIN_MARKER} 9\n")));
        let r = agg.process_event(response("GHOST\n"));
        assert!(!matches!(r.change_type, ChangeType::PaneOutput { .. }));
        agg.process_event(response(&format!("{CAPTURE_END_MARKER}\n")));
        assert!(agg.pending_captures.is_empty());
    }

    #[test]
    fn osc52_clipboard_write_propagates_to_result() {
        // OSC 52 base64-encoded "hello world" payload — what an app like
        // `printf '\e]52;c;%s\e\\' "$(printf hello\ world | base64)'` sends.
        let mut agg = StateAggregator::new();
        seed_pane(&mut agg, "%0", "@0");

        let event = ControlModeEvent::Output {
            pane_id: "%0".to_string(),
            content: b"\x1b]52;c;aGVsbG8gd29ybGQ=\x07".to_vec(),
        };

        let result = agg.process_event(event);

        assert_eq!(
            result.clipboard_writes,
            vec![("%0".to_string(), "hello world".to_string())],
            "OSC 52 sequence must surface as a clipboard write on the event result"
        );
    }

    #[test]
    fn output_without_osc52_yields_no_clipboard_write() {
        // Sanity check that the new field doesn't fire on plain output.
        let mut agg = StateAggregator::new();
        seed_pane(&mut agg, "%0", "@0");

        let event = ControlModeEvent::Output {
            pane_id: "%0".to_string(),
            content: b"hello\r\n".to_vec(),
        };

        let result = agg.process_event(event);
        assert!(result.clipboard_writes.is_empty());
    }

    /// Build a LIST_PANES_CMD line with the given title and border_title, in the
    /// exact field order of `constants::tmux_formats::LIST_PANES_CMD`.
    fn list_panes_line(title: &str, window_id: &str, border_title: &str) -> String {
        // group_id (final tail field) is left empty here; group parsing has its
        // own test below.
        format!(
            // id,idx,x,y,w,h,cx,cy,active,command,TITLE,in_mode,copy_x,copy_y,scroll,WIN,BORDER,alt,mouse,sel,sx,sy,hist,gid
            "%3,0,0,0,80,24,0,0,1,zsh,{title},0,0,0,0,{window_id},{border_title},0,0,0,0,0,0,100,"
        )
    }

    #[test]
    fn list_panes_plain_title_parses_window_id() {
        let mut agg = StateAggregator::new();
        agg.parse_list_panes_line(&list_panes_line("nvim", "@4", ""));
        let pane = agg.panes.get("%3").expect("pane parsed");
        assert_eq!(pane.window_id, "@4");
        assert_eq!(pane.title, "nvim");
        assert_eq!(pane.history_size, 100);
    }

    #[test]
    fn list_panes_parses_rows_captured_from_a_real_tmux() {
        // Verbatim `list-panes -s -F LIST_PANES_CMD` output from tmux 3.7c: one
        // pane whose app set no title (empty title field) and one that set a
        // comma-laden one over OSC 2. Unlike `list_panes_line`, this carries
        // tmux's real habit of leaving the copy-mode/selection numerics EMPTY
        // rather than zero — the anchor scan has to tolerate both around a
        // blank title.
        let mut agg = StateAggregator::new();
        agg.parse_list_panes_line("%0,0,0,0,80,12,0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,");
        agg.parse_list_panes_line(
            "%1,1,0,13,80,11,0,0,0,sleep,✳ Add tests, docs, and CI,0,,,,@0, ,0,0,0,,,,0,",
        );

        let untitled = agg.panes.get("%0").expect("untitled pane parsed");
        assert_eq!(untitled.title, "", "no app title means an empty field");
        assert_eq!(untitled.window_id, "@0");
        assert_eq!(untitled.command, "sleep");

        let titled = agg.panes.get("%1").expect("titled pane parsed");
        assert_eq!(titled.title, "✳ Add tests, docs, and CI");
        assert_eq!(titled.window_id, "@0");
    }

    #[test]
    fn list_panes_empty_title_keeps_fields_aligned() {
        // LIST_PANES_CMD asks tmux for the APP-SET title only, so a pane whose
        // app never set one arrives with an EMPTY title field. The anchor scan
        // must still find window_id rather than treating the blank as a shift.
        let mut agg = StateAggregator::new();
        agg.parse_list_panes_line(&list_panes_line("", "@4", ""));
        let pane = agg.panes.get("%3").expect("pane parsed");
        assert_eq!(pane.window_id, "@4");
        assert_eq!(pane.title, "");
        assert_eq!(pane.command, "zsh");
        assert_eq!(pane.history_size, 100);
    }

    #[test]
    fn pane_delta_carries_a_changed_title() {
        // A pane header shows the app's own title, so a title change has to
        // survive the delta pass — it used to be dropped, leaving the client
        // stuck on whatever title the initial snapshot carried.
        let agg = StateAggregator::new();
        let mut prev = PaneState::new("%3", 80, 24).build_tmux_pane();
        prev.title = "old".to_string();
        let mut curr = prev.clone();
        curr.title = "✳ new title".to_string();

        let delta = agg.compute_pane_delta(&prev, &curr);
        assert_eq!(delta.title.as_deref(), Some("✳ new title"));

        let unchanged = agg.compute_pane_delta(&curr, &curr);
        assert_eq!(
            unchanged.title, None,
            "an unchanged title stays off the wire"
        );
    }

    #[test]
    fn list_panes_title_with_commas_keeps_window_id() {
        // Regression: a pane title containing commas used to shift the
        // comma-split fields, parsing window_id as "" and blanking the tab.
        let title = "✳ Add Storybook, tests, PWA support and deploy Backstage";
        let mut agg = StateAggregator::new();
        agg.parse_list_panes_line(&list_panes_line(title, "@4", ""));
        let pane = agg.panes.get("%3").expect("pane parsed");
        assert_eq!(pane.window_id, "@4", "window_id must survive a comma title");
        assert_eq!(pane.title, title);
        assert_eq!(pane.scroll_position, 0);
        assert_eq!(pane.history_size, 100);
    }

    #[test]
    fn list_panes_commas_in_both_title_and_border_title() {
        let title = "feat: a, b, c";
        let border = "x, y, z";
        let mut agg = StateAggregator::new();
        agg.parse_list_panes_line(&list_panes_line(title, "@9", border));
        let pane = agg.panes.get("%3").expect("pane parsed");
        assert_eq!(pane.window_id, "@9");
        assert_eq!(pane.title, title);
        assert_eq!(pane.border_title, border);
        assert_eq!(pane.history_size, 100);
    }

    #[test]
    fn list_windows_name_with_commas_keeps_fields_aligned() {
        // Regression: window_name is free text; placing it LAST (see
        // LIST_WINDOWS_CMD) means a name like "build, test" stays in the
        // trailing field and can't shift window_active/@tmuxy-window-type/floats.
        let name = "build, test";
        // @id,index,active,type,float_parent,fw,fh,drawer,bg,noheader,focus,cols,hidden,zoomed,name
        let line = format!("@7,3,1,tab,,,,,,,,,,0,{name}");
        let mut agg = StateAggregator::new();
        agg.parse_list_windows_line(&line);
        let w = agg.windows.get("@7").expect("window parsed");
        assert_eq!(w.index, 3, "index must not be shifted by the comma name");
        assert_eq!(w.name, name);
        assert!(w.active);
        assert_eq!(w.window_type, Some(WindowType::Tab));
        assert!(!w.zoomed);
        assert_eq!(agg.active_window_id.as_deref(), Some("@7"));
    }

    /// Zoom has to come from `list-windows`, not only from `%layout-change`
    /// flags: window state is rebuilt from list-windows on every fresh client
    /// connect, which is exactly when a client attaching to an already-zoomed
    /// window would otherwise render it un-zoomed.
    #[test]
    fn list_windows_carries_the_zoom_flag() {
        let mut agg = StateAggregator::new();
        agg.parse_list_windows_line("@9,2,1,tab,,,,,,,,,,1,editor");
        assert!(agg.windows.get("@9").expect("window parsed").zoomed);

        // ...and clears it again when the window is no longer zoomed.
        agg.parse_list_windows_line("@9,2,1,tab,,,,,,,,,,0,editor");
        assert!(!agg.windows.get("@9").expect("window parsed").zoomed);
    }

    /// A closed sidebar column keeps its window (the dock's shell survives a
    /// close), so "hidden" has to travel as its own flag — read from the same
    /// poll as the width, and cleared when the option is unset.
    #[test]
    fn list_windows_carries_the_sidebar_hidden_flag() {
        let mut agg = StateAggregator::new();
        agg.parse_list_windows_line("@4,5,0,sidebar-right,,,,,,,,35,1,0,__sidebar-right");
        let w = agg.windows.get("@4").expect("window parsed");
        assert_eq!(w.window_type, Some(WindowType::SidebarRight));
        assert_eq!(w.sidebar_cols, Some(35));
        assert!(w.sidebar_hidden);
        assert_eq!(w.name, "__sidebar-right");

        agg.parse_list_windows_line("@4,5,0,sidebar-right,,,,,,,,35,,0,__sidebar-right");
        assert!(!agg.windows.get("@4").expect("window parsed").sidebar_hidden);
    }

    /// The group id rides in the final `list-panes` tail field.
    #[test]
    fn list_panes_parses_group_id() {
        let mut agg = StateAggregator::new();
        // id,idx,x,y,w,h,cx,cy,active,cmd,title,in_mode,cx,cy,scroll,WIN,BORDER,alt,mouse,sel,sx,sy,hist,GID
        agg.parse_list_panes_line("%3,0,0,0,80,24,0,0,1,zsh,vis,0,0,0,0,@4,,0,0,0,0,0,0,100,g5");
        assert_eq!(
            agg.panes
                .get("%3")
                .expect("pane parsed")
                .group_id
                .as_deref(),
            Some("g5")
        );

        // Empty tail → no group.
        agg.parse_list_panes_line("%4,0,0,0,80,24,0,0,1,zsh,plain,0,0,0,0,@4,,0,0,0,0,0,0,100,");
        assert_eq!(agg.panes.get("%4").expect("pane parsed").group_id, None);
    }

    /// A `stashmember,` block rebuilds hidden members without conjuring real
    /// panes or windows into the active-session plane.
    #[test]
    fn stash_block_does_not_create_real_panes() {
        let mut agg = StateAggregator::new();
        agg.handle_command_response("stashmember,%7,@9,g5,vim,editing");
        assert!(
            agg.panes.is_empty(),
            "stash rows must not become real panes"
        );
        assert!(agg.windows.is_empty(), "stash rows must not become windows");
        assert_eq!(agg.stash_members.len(), 1);
    }

    /// Hidden members are emitted as stubs only for groups that still have a
    /// visible member; orphans (no visible pane) are pruned.
    #[test]
    fn stash_members_emit_stubs_only_for_active_groups() {
        let mut agg = StateAggregator::new();
        // Visible member of g5 in window @4.
        agg.parse_list_panes_line("%3,0,0,0,80,24,0,0,1,zsh,vis,0,0,0,0,@4,,0,0,0,0,0,0,100,g5");
        // Hidden member of g5, plus an orphan in g6 (no visible member).
        agg.handle_command_response(
            "stashmember,%7,@9,g5,vim,hidden-title\nstashmember,%8,@9,g6,top,orphan",
        );

        let state = agg.to_tmux_state();
        let ids: Vec<&str> = state.panes.iter().map(|p| p.tmux_id.as_str()).collect();
        assert!(ids.contains(&"%3"), "visible member emitted");
        assert!(
            ids.contains(&"%7"),
            "hidden member of an active group emitted"
        );
        assert!(!ids.contains(&"%8"), "orphan pruned");

        let stub = state
            .panes
            .iter()
            .find(|p| p.tmux_id == "%7")
            .expect("stub");
        assert_eq!(stub.group_id.as_deref(), Some("g5"));
        assert_eq!(
            stub.window_id, "@9",
            "stub keeps its stash window id (never the active one)"
        );
        assert_eq!(stub.title, "hidden-title");
    }

    /// An untagged window (a native `tmux neww` / foreign window) carries no
    /// `@tmuxy-window-type` marker but still surfaces as a tab, and the setup
    /// pass enforces its pane border without tagging it.
    #[test]
    fn untagged_window_is_a_tab_and_gets_only_border_enforcement() {
        let mut agg = StateAggregator::new();
        // @id,index,active,type(empty),float*,zoomed,name
        agg.parse_list_windows_line("@5,0,1,,,,,,,,,,,0,shell");

        let cmds = agg.collect_window_tag_commands();
        assert!(
            cmds.iter().any(|c| c.contains("pane-border-status top")),
            "tab needs pane-border enforcement: {cmds:?}"
        );
        assert!(
            !cmds.iter().any(|c| c.contains("@tmuxy-window-type")),
            "a tab must never be tagged: {cmds:?}"
        );
        // Idempotent — already enforced, so nothing new.
        assert!(agg.collect_window_tag_commands().is_empty());

        // Emitted as a tab despite carrying no marker.
        let state = agg.to_tmux_state();
        let w = state.windows.iter().find(|w| w.id == "@5").expect("window");
        assert_eq!(w.window_type, Some(WindowType::Tab));
    }

    /// Each sidebar is docked beside the pane grid, so the client-size pass must
    /// size it to its own narrow column — sizing it to the viewport makes its
    /// shell wrap at a width the UI never draws. The two columns differ in
    /// width, so they cannot share one size.
    #[test]
    fn window_ids_by_sizing_splits_both_sidebars_off() {
        use crate::constants::sidebar_dock;

        let mut agg = StateAggregator::new();
        agg.parse_list_windows_line("@1,0,1,tab,,,,,,,,,,0,shell");
        agg.parse_list_windows_line("@2,1,0,float,,,,,,,,,,0,float");
        agg.parse_list_windows_line("@3,2,0,sidebar-left,,,,,,,,,,0,tree");
        agg.parse_list_windows_line("@4,3,0,sidebar-right,,,,,,,,,,0,term");

        let (mut viewport, mut sidebars) = agg.window_ids_by_sizing();
        viewport.sort();
        sidebars.sort();
        assert_eq!(viewport, vec!["@1".to_string(), "@2".to_string()]);
        assert_eq!(
            sidebars,
            vec![
                ("@3".to_string(), sidebar_dock::LEFT_COLS),
                ("@4".to_string(), sidebar_dock::RIGHT_COLS),
            ],
            "each column carries its own width, not a shared one"
        );

        // A sidebar keeps the viewport's rows — it runs the full height of the
        // app body and draws no header of its own.
        assert_eq!(
            sidebar_dock::size(WindowType::SidebarLeft, None, 50),
            Some((sidebar_dock::LEFT_COLS, 50))
        );
        // ...and never collapses to zero rows on a degenerate viewport.
        assert_eq!(
            sidebar_dock::size(WindowType::SidebarRight, None, 0),
            Some((sidebar_dock::RIGHT_COLS, 1))
        );
        // Everything else is viewport-sized, so it has no column width.
        assert_eq!(sidebar_dock::size(WindowType::Tab, None, 50), None);
        assert_eq!(sidebar_dock::size(WindowType::Float, None, 50), None);
    }

    /// A dragged column width replaces the default, and is clamped so a drag
    /// can neither squeeze the column below legibility nor swallow the grid.
    #[test]
    fn sidebar_width_honours_the_user_drag_within_limits() {
        use crate::constants::sidebar_dock;

        let mut agg = StateAggregator::new();
        agg.parse_list_windows_line("@3,2,0,sidebar-left,,,,,,,,48,,0,tree");
        let (_, sidebars) = agg.window_ids_by_sizing();
        assert_eq!(sidebars, vec![("@3".to_string(), 48)]);

        assert_eq!(
            sidebar_dock::cols(WindowType::SidebarLeft, Some(2)),
            Some(sidebar_dock::MIN_COLS),
            "a drag past the floor stops at it"
        );
        assert_eq!(
            sidebar_dock::cols(WindowType::SidebarRight, Some(9999)),
            Some(sidebar_dock::MAX_COLS),
            "...and past the ceiling likewise"
        );
        // A width set on a non-sidebar window is meaningless, not a size.
        assert_eq!(sidebar_dock::cols(WindowType::Tab, Some(48)), None);
    }

    /// `%window-add` lands before the `@tmuxy-window-type` marker is readable,
    /// so a sidebar's window is first adopted as a tab and given the tab-only
    /// pane-border row. The next pass, once the type is known, has to take it
    /// back — a sidebar is sized without that row.
    #[test]
    fn sidebar_loses_the_pane_border_a_tab_gets() {
        let mut agg = StateAggregator::new();
        // The window as `%window-add` / the first list-windows sees it: no
        // marker yet, because the create command's `set-option` has not been
        // read back.
        agg.parse_list_windows_line("@4,2,0,,,,,,,,,,,0,side");
        let adopted = agg.collect_window_tag_commands();
        assert!(
            adopted
                .iter()
                .any(|c| c == "set-option -w -t @4 pane-border-status top"),
            "an untyped new window is adopted as a tab: {adopted:?}"
        );

        // The list-windows response carries the marker the create command set.
        agg.parse_list_windows_line("@4,2,0,sidebar-right,,,,,,,,,,0,side");
        let corrected = agg.collect_window_tag_commands();
        assert!(
            corrected
                .iter()
                .any(|c| c == "set-option -w -t @4 pane-border-status off"),
            "the border must be taken back once the type lands: {corrected:?}"
        );
        // ...exactly once, and never re-enforced afterwards.
        assert!(agg.collect_window_tag_commands().is_empty());
    }

    /// The monitor re-lists windows right behind a create command, so a
    /// sidebar can be typed before it was ever adopted as a tab. The global
    /// `pane-border-status top` still applies to it, so the border must come
    /// off in that case too — it used to be skipped, leaving the pane a row short.
    #[test]
    fn sidebar_typed_on_arrival_still_loses_the_pane_border() {
        let mut agg = StateAggregator::new();
        agg.parse_list_windows_line("@4,2,0,sidebar-left,,,,,,,,,,0,__sidebar-left");
        let cmds = agg.collect_window_tag_commands();
        assert!(
            cmds.iter()
                .any(|c| c == "set-option -w -t @4 pane-border-status off"),
            "a sidebar typed on arrival must still drop the border row: {cmds:?}"
        );
        assert!(agg.collect_window_tag_commands().is_empty());
    }

    /// The pin every keyboard binding carries (`select-window -t @N \; …`)
    /// makes tmux re-announce the window that is already current. That must not
    /// refresh the status line: the refresh is five `tmux display-message`
    /// subprocesses plus a shell, run synchronously while the user waits for
    /// the keypress they just made.
    #[test]
    fn reselecting_the_active_window_leaves_the_status_line_alone() {
        let mut agg = StateAggregator::new();
        let mut first = WindowState::new("@0");
        first.index = 1;
        first.active = true;
        agg.windows.insert("@0".to_string(), first);
        let mut second = WindowState::new("@1");
        second.index = 2;
        agg.windows.insert("@1".to_string(), second);
        agg.active_window_id = Some("@0".to_string());
        // Settle the fingerprint the way the first status-line read would.
        agg.refresh_status_line_if_inputs_changed();
        agg.status_line_dirty = false;

        agg.step(ControlModeEvent::SessionWindowChanged {
            session_id: "$0".to_string(),
            window_id: "@0".to_string(),
        });
        assert!(
            !agg.status_line_dirty,
            "re-selecting the current window must not dirty the status line"
        );

        // A real switch still does.
        agg.step(ControlModeEvent::SessionWindowChanged {
            session_id: "$0".to_string(),
            window_id: "@1".to_string(),
        });
        assert!(
            agg.status_line_dirty,
            "switching to a different window must dirty the status line"
        );
    }

    /// The `list-windows` poll runs several times a second and almost always
    /// reports exactly what it reported last time.
    #[test]
    fn unchanged_list_windows_poll_leaves_the_status_line_alone() {
        let mut agg = StateAggregator::new();
        // list-windows row: id, index, active, then the @tmuxy-* option columns,
        // with the window name last.
        let poll = |name: &str| format!("@0,1,1,tab,,,,,,,,,,,{name}");
        // `new()` starts dirty so the first state request fetches; clear it so
        // the assertion below is about the poll, not about construction.
        agg.status_line_dirty = false;

        agg.handle_command_response(&poll("shell"));
        assert!(
            agg.status_line_dirty,
            "the first poll has nothing cached and must refresh"
        );
        agg.status_line_dirty = false;

        agg.handle_command_response(&poll("shell"));
        assert!(
            !agg.status_line_dirty,
            "an identical poll must not trigger a refresh"
        );

        agg.handle_command_response(&poll("build"));
        assert!(
            agg.status_line_dirty,
            "a renamed window must trigger a refresh"
        );
    }

    #[test]
    fn window_add_assigns_provisional_index_past_the_highest() {
        // The tmuxy guest snapshot already has window id and index diverged:
        // root @0 sits at positional index 1.
        let mut agg = StateAggregator::new();
        let mut root = WindowState::new("@0");
        root.index = 1;
        agg.windows.insert("@0".to_string(), root);

        // `tmuxy tab create` allocates window @1; %window-add carries only the
        // id. The new window must land at index 2 (one past the highest), NOT
        // the id-derived guess of 1 — which would collide with root and render
        // the wrong tab number until the delayed list-windows arrives.
        agg.step(ControlModeEvent::WindowAdd {
            window_id: "@1".to_string(),
        });

        let new_window = agg.windows.get("@1").expect("window @1 created");
        assert_eq!(new_window.index, 2);
    }

    #[test]
    fn window_renamed_creating_a_window_also_gets_provisional_index() {
        let mut agg = StateAggregator::new();
        let mut root = WindowState::new("@0");
        root.index = 1;
        agg.windows.insert("@0".to_string(), root);

        // A rename can arrive before the add and creates the window; it must
        // get the same provisional index, not the id-derived guess.
        agg.step(ControlModeEvent::WindowRenamed {
            window_id: "@1".to_string(),
            name: "build".to_string(),
        });

        let w = agg.windows.get("@1").expect("window @1 created by rename");
        assert_eq!(w.index, 2);
        assert_eq!(w.name, "build");
    }

    /// A metadata-only change (window rename) must produce a delta carrying NO
    /// pane content: untouched grids are Arc-shared between snapshots, so the
    /// diff skips them by pointer identity instead of walking every cell — the
    /// fix for "a one-field delta costs as much as a full sync".
    #[test]
    fn metadata_delta_shares_content_and_omits_grids() {
        let mut agg = StateAggregator::new();
        seed_pane(&mut agg, "%0", "@0");
        agg.windows.insert("@0".to_string(), WindowState::new("@0"));
        agg.step(ControlModeEvent::Output {
            pane_id: "%0".to_string(),
            content: b"hello world\r\n".to_vec(),
        });
        agg.set_status_line(String::new());

        // First update is the full snapshot.
        assert!(matches!(
            agg.to_state_update(),
            Some(crate::StateUpdate::Full { .. })
        ));

        // Consecutive snapshots share one grid allocation (refcount bump,
        // not a per-cell deep copy).
        let s1 = agg.to_tmux_state();
        let s2 = agg.to_tmux_state();
        assert!(
            std::sync::Arc::ptr_eq(&s1.panes[0].content, &s2.panes[0].content),
            "unchanged pane content must be shared, not rebuilt"
        );

        // A rename-only change yields a delta with the window change and no
        // pane entries at all.
        agg.step(ControlModeEvent::WindowRenamed {
            window_id: "@0".to_string(),
            name: "renamed".to_string(),
        });
        agg.set_status_line(String::new());
        match agg.to_state_update() {
            Some(crate::StateUpdate::Delta { delta }) => {
                assert!(
                    delta.panes.is_none(),
                    "rename must not resend or re-diff pane content"
                );
                let windows = delta.windows.expect("window delta present");
                let w = windows
                    .get("@0")
                    .expect("@0 in delta")
                    .as_ref()
                    .expect("modified, not removed");
                assert_eq!(w.name.as_deref(), Some("renamed"));
            }
            other => panic!("expected Delta, got {other:?}"),
        }
    }

    #[test]
    fn list_windows_still_corrects_a_wrong_provisional_index() {
        // Provisional is just a good default for the gap; the authoritative
        // list-windows must always win (e.g. an insert-in-the-middle case).
        let mut agg = StateAggregator::new();
        let mut root = WindowState::new("@0");
        root.index = 1;
        agg.windows.insert("@0".to_string(), root);
        agg.step(ControlModeEvent::WindowAdd {
            window_id: "@1".to_string(),
        });
        assert_eq!(agg.windows.get("@1").unwrap().index, 2);

        // tmux reports @1 actually at index 5 — drive the correction through
        // the real parser (a list-windows line arriving as a command
        // response), not by hand-assigning the field.
        agg.process_event(ControlModeEvent::CommandResponse {
            timestamp: 0,
            command_num: 0,
            output: "@1,5,1,tab,,,,,,,,,,shell".to_string(),
            success: true,
        });
        assert_eq!(
            agg.windows.get("@1").unwrap().index,
            5,
            "authoritative list-windows index must overwrite the provisional"
        );
    }

    /// Read back the text a pane's OSC 8 marks actually cover, as
    /// `(url, text)` — the same join `extract_cells_with_urls` does, which is
    /// what the frontend turns into `<a href>`.
    fn linked_text(pane: &PaneState) -> Vec<(String, String)> {
        let screen = pane.terminal.screen();
        let (rows, cols) = screen.size();
        let mut out: Vec<(String, String)> = Vec::new();
        for row in 0..rows {
            let mut run: Option<(String, String)> = None;
            for col in 0..cols {
                let url = pane.osc_parser.get_url(u32::from(row), u32::from(col));
                let ch = screen
                    .cell(row, col)
                    .map(|c| c.contents())
                    .unwrap_or_default();
                match (url, &mut run) {
                    (Some(u), Some((cur, text))) if cur == u => text.push_str(&ch),
                    (Some(u), _) => {
                        if let Some(done) = run.take() {
                            out.push(done);
                        }
                        run = Some((u.clone(), ch.to_string()));
                    }
                    (None, _) => {
                        if let Some(done) = run.take() {
                            out.push(done);
                        }
                    }
                }
            }
            if let Some(done) = run.take() {
                out.push(done);
            }
        }
        out
    }

    fn osc8(url: &str, label: &str) -> Vec<u8> {
        format!("\x1b]8;;{url}\x07{label}\x1b]8;;\x07").into_bytes()
    }

    #[test]
    fn hyperlink_lands_on_its_own_text_after_a_cursor_move() {
        // Regression: the OSC parser used to advance a private cursor on \n,
        // \r and printable ASCII only. A CSI cursor move — which is most of
        // what a shell prompt emits — was invisible to it, so its rows drifted
        // and the URL attached to whatever text later occupied those cells.
        // Here CUP jumps to row 4 before the link is written.
        let mut pane = PaneState::new("%1", 40, 10);
        let mut out = b"\x1b[5;1H".to_vec();
        out.extend_from_slice(&osc8("https://example.com/osc", "OSC-LINK"));
        out.extend_from_slice(b"\r\ntail-after-link");
        pane.process_output(&out);

        assert_eq!(
            linked_text(&pane),
            vec![(
                "https://example.com/osc".to_string(),
                "OSC-LINK".to_string()
            )],
            "the link must cover its own label, not the line after it"
        );
    }

    #[test]
    fn hyperlink_follows_its_line_as_output_scrolls_it_up() {
        let mut pane = PaneState::new("%1", 40, 4);
        pane.process_output(&osc8("https://example.com/s", "LINK"));
        // Push the link's line up with more output than the pane is tall.
        pane.process_output(b"\r\na\r\nb\r\nc");

        assert_eq!(
            linked_text(&pane),
            vec![("https://example.com/s".to_string(), "LINK".to_string())],
            "the mark must travel with the line it was written on"
        );
    }

    #[test]
    fn hyperlink_scrolled_off_the_top_is_dropped() {
        let mut pane = PaneState::new("%1", 40, 3);
        pane.process_output(&osc8("https://example.com/gone", "LINK"));
        pane.process_output(b"\r\na\r\nb\r\nc\r\nd\r\ne");

        assert!(
            linked_text(&pane).is_empty(),
            "a link scrolled off screen must not re-attach to a surviving row"
        );
    }

    #[test]
    fn hyperlink_wrapping_the_right_edge_covers_both_rows() {
        let mut pane = PaneState::new("%1", 10, 6);
        pane.process_output(b"\x1b[1;9H");
        pane.process_output(&osc8("https://example.com/w", "ABCD"));

        let linked = linked_text(&pane);
        let joined: String = linked.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(joined, "ABCD", "wrapped link lost cells: {linked:?}");
        assert!(linked.iter().all(|(u, _)| u == "https://example.com/w"));
    }

    #[test]
    fn hyperlink_terminated_with_st_is_recorded() {
        // Real shells emit ST (ESC \\), not BEL, to close OSC 8.
        let mut pane = PaneState::new("%1", 40, 6);
        pane.process_output(b"\x1b]8;;https://example.com/st\x1b\\OSC-LINK\x1b]8;;\x1b\\\r\ntail");
        assert_eq!(
            linked_text(&pane),
            vec![("https://example.com/st".to_string(), "OSC-LINK".to_string())]
        );
    }

    #[test]
    fn a_refill_keeps_the_alternate_screen_tmux_reports() {
        // A client that attaches while an application (vim, Claude Code) is
        // already on the alternate screen: list-panes says alternate_on=1,
        // then the capture refill rebuilds the parser. The rebuilt parser must
        // be on the alternate screen too, or every following %output flips
        // the flag back to false and the pane re-renders on each flap.
        let mut pane = PaneState::new("%1", 40, 4);
        pane.alternate_on = true;
        pane.reset_and_process_capture(b"drawn on the alternate screen\n");
        assert!(pane.terminal.screen().alternate_screen());
        pane.process_output(b"more");
        assert!(
            pane.alternate_on,
            "output after a refill must not drop alternate mode"
        );

        // And a pane on the main screen stays there.
        let mut main = PaneState::new("%2", 40, 4);
        main.alternate_on = false;
        main.reset_and_process_capture(b"shell\n");
        assert!(!main.terminal.screen().alternate_screen());
        main.process_output(b"x");
        assert!(!main.alternate_on);
    }

    #[test]
    fn a_link_after_a_capture_refresh_is_still_recorded() {
        // Regression: the scroll counter belongs to one vt100 grid, and a
        // capture refresh builds a fresh parser whose counter restarts at 0.
        // Comparing the new counter against the old baseline produced a large
        // negative delta, which shifted every subsequent mark off the screen —
        // links silently stopped appearing after the first capture refresh.
        let mut pane = PaneState::new("%1", 40, 4);
        // Scroll the grid so the counter is well past zero.
        pane.process_output(b"a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng");
        pane.reset_and_process_capture(b"fresh\n");

        pane.process_output(&osc8("https://example.com/after", "LINK"));

        assert_eq!(
            linked_text(&pane),
            vec![("https://example.com/after".to_string(), "LINK".to_string())]
        );
    }

    #[test]
    fn links_do_not_leak_onto_the_alternate_screen() {
        // The alternate grid has its own scroll counter AND its own text, so a
        // mark taken on the normal screen must not survive the switch.
        let mut pane = PaneState::new("%1", 40, 4);
        pane.process_output(&osc8("https://example.com/main", "LINK"));
        assert!(!linked_text(&pane).is_empty());

        // Enter the alternate screen and paint over the same cells.
        pane.process_output(b"\x1b[?1049h\x1b[HVIMTEXT");

        assert!(
            linked_text(&pane).is_empty(),
            "a normal-screen URL must not attach to alternate-screen content"
        );
    }

    #[test]
    fn plain_output_records_no_links() {
        let mut pane = PaneState::new("%1", 40, 6);
        pane.process_output(b"https://example.com/not-osc8\r\nplain text");
        assert!(pane.osc_parser.cell_urls.is_empty());
    }

    #[test]
    fn clear_from_home_erases_the_screen() {
        // The exact bytes zsh emits for `clear` (captured with pipe-pane):
        // an OSC title, then CUP home + ED with no parameter.
        let mut pane = PaneState::new("%1", 43, 10);
        pane.process_output(b"one\r\ntwo\r\nthree\r\n");
        pane.process_output(
            b"c\x08clear\x1b[?2004l\r\r\n\x1b]0;clear\x07\x1b[H\x1b[J\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m       \r \r\x1b]0;zsh\x07\r\x1b[0m\x1b[27m\x1b[24m\x1b[J\r\n\x1b[34m~\x1b[39m\r\n\x1b[35m\xe2\x9d\xaf\x1b[39m \x1b[K\x1b[?2004h",
        );
        let text = pane.terminal.screen().contents();
        assert!(
            !text.contains("one") && !text.contains("three"),
            "screen not cleared: {text:?}"
        );
    }
}

#[cfg(test)]
mod marked_pane_tests {
    use super::*;

    /// `#{pane_marked}` rides in the fixed tail of list-panes, between
    /// mouse_any_flag and selection_present, and must survive the free-text
    /// title/border fields around it.
    #[test]
    fn list_panes_carries_the_marked_flag() {
        let mut agg = StateAggregator::new();
        agg.parse_list_panes_line("%3,0,0,0,80,24,0,0,1,zsh,a, title,0,0,0,0,@4,,0,0,1,0,0,0,100,");
        let pane = agg.panes.get("%3").expect("pane parsed");
        assert!(pane.marked);
        assert_eq!(pane.title, "a, title");
        assert_eq!(pane.history_size, 100);

        agg.parse_list_panes_line("%3,0,0,0,80,24,0,0,1,zsh,a, title,0,0,0,0,@4,,0,0,0,0,0,0,100,");
        assert!(!agg.panes.get("%3").expect("pane parsed").marked);
    }
}
