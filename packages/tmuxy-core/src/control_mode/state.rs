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
            terminal: vt100::Parser::new(h, w, 0),
            osc_parser,
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
            in_mode: false,
            copy_cursor_x: 0,
            copy_cursor_y: 0,
            scroll_position: 0,
            tmux_cursor_x: 0,
            tmux_cursor_y: 0,
            alternate_on: false,
            mouse_any_flag: false,
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
        // Returns content with OSC sequences stripped for vt100
        let processed = self.osc_parser.process(&image_result.clean_bytes);

        // Process through terminal emulator
        safe_process(&mut self.terminal, &processed);

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
        let w = (self.width as u16).max(1);
        let h = (self.height as u16).max(1);
        self.terminal = vt100::Parser::new(h, w, 0);
        // Keep image placements: the capture text can't recreate them (tmux
        // strips image escapes from captured history).
        self.image_parser.reset_for_capture();
        // capture-pane output carries no OSC 8 sequences (tmux strips them), so
        // the old cell→URL map can only mis-attach stale URLs to fresh content
        // at the same coordinates. Clear it and let live %output repopulate.
        self.osc_parser.reset();

        // Strip trailing newline to prevent scroll when content exactly fills terminal.
        // capture-pane output typically ends with \n, but processing this final newline
        // would push the cursor past the last row, causing unwanted scroll.
        let content = if content.ends_with(b"\n") {
            &content[..content.len() - 1]
        } else {
            content
        };

        // Normalize newlines: capture-pane outputs \n only, but vt100 treats \n as
        // "move down" without returning to column 0. We need \r\n for proper line handling.
        let normalized: Vec<u8> = content
            .iter()
            .flat_map(|&b| {
                if b == b'\n' {
                    vec![b'\r', b'\n']
                } else {
                    vec![b]
                }
            })
            .collect();

        // Process the normalized content
        safe_process(&mut self.terminal, &normalized);
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

        // Strip trailing newline to prevent scroll when content exactly fills terminal.
        let content = if content.ends_with(b"\n") {
            &content[..content.len() - 1]
        } else {
            content
        };

        // Normalize newlines: capture-pane outputs \n only, but vt100 treats \n as
        // "move down" without returning to column 0. We need \r\n for proper line handling.
        let normalized: Vec<u8> = content
            .iter()
            .flat_map(|&b| {
                if b == b'\n' {
                    vec![b'\r', b'\n']
                } else {
                    vec![b]
                }
            })
            .collect();

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
            in_mode: self.in_mode,
            copy_cursor_x: self.copy_cursor_x,
            copy_cursor_y: self.copy_cursor_y,
            alternate_on: self.alternate_on,
            mouse_any_flag: self.mouse_any_flag,
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

    /// Group pane membership from @tmuxy-group-panes (e.g. ["%4","%6","%7"]).
    pub group_panes: Option<Vec<String>>,

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
            group_panes: None,
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
            window_type: self.window_type,
            group_panes: self.group_panes.clone(),
            float_parent: self.float_parent.clone(),
            float_width: self.float_width,
            float_height: self.float_height,
            float_drawer: self.float_drawer.clone(),
            float_bg: self.float_bg.clone(),
            float_noheader: self.float_noheader,
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

    /// Cached status line (optimization: only refresh on window events or periodic sync)
    cached_status_line: String,

    /// Whether status line needs refresh
    status_line_dirty: bool,

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

/// Marker printed (via `display-message -p`) immediately BEFORE a self-issued
/// capture-pane command, carrying the target pane id. Routing captures by
/// marker instead of arrival order or output shape is what makes attribution
/// exact: any other command's response (a send-keys ack has EMPTY output,
/// indistinguishable from capturing a blank pane) can otherwise steal a
/// pending capture and shunt one pane's content into another.
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
    let bare = pane_id.trim_start_matches('%');
    format!(
        "display-message -p '{CAPTURE_BEGIN_MARKER} {bare}' ; capture-pane -t {pane_id} -p -e ; display-message -p '{CAPTURE_END_MARKER}'"
    )
}

/// `capture_command` for an explicit scrollback range (copy-mode sync).
pub fn capture_command_range(pane_id: &str, start: i64, end: i64) -> String {
    let bare = pane_id.trim_start_matches('%');
    format!(
        "display-message -p '{CAPTURE_BEGIN_MARKER} {bare}' ; capture-pane -t {pane_id} -p -e -S {start} -E {end} ; display-message -p '{CAPTURE_END_MARKER}'"
    )
}

impl StateAggregator {
    pub fn new() -> Self {
        Self {
            session_name: crate::DEFAULT_SESSION_NAME.to_string(),
            panes: HashMap::new(),
            windows: HashMap::new(),
            active_window_id: None,
            pending_captures: std::collections::VecDeque::new(),
            capture_armed: None,
            pending_buffer_reads: std::collections::VecDeque::new(),
            buffer_read_armed: false,

            cached_status_line: String::new(),
            status_line_dirty: true, // Fetch on first state request
            prev_state: None,
            delta_seq: 0,
            suppress_window_emissions: false,
            panes_moved_window: std::collections::HashSet::new(),
            early_output: HashMap::new(),
            settling_until: None,
            settling_started: None,
            settling_awaiting_first_event: false,
        }
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

            cached_status_line: String::new(),
            status_line_dirty: true, // Fetch on first state request
            prev_state: None,
            delta_seq: 0,
            suppress_window_emissions: false,
            panes_moved_window: std::collections::HashSet::new(),
            early_output: HashMap::new(),
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

    /// Refresh status line if dirty, otherwise use cached value.
    /// Width is the total terminal width from pane layout, used for padding.
    fn get_status_line(&mut self, width: usize) -> String {
        if self.status_line_dirty {
            // Native refreshes the status line via a `capture-pane` on the status
            // window. On wasm there is no tmux to call — the host supplies it via
            // `set_status_line`, so we keep the cached value here.
            #[cfg(feature = "native")]
            {
                self.cached_status_line =
                    crate::executor::capture_status_line(&self.session_name, width)
                        .unwrap_or_default();
            }
            #[cfg(not(feature = "native"))]
            {
                let _ = width;
            }
            self.status_line_dirty = false;
        }
        self.cached_status_line.clone()
    }

    /// Set the status-line text directly (used by non-native hosts that fetch it
    /// out-of-band, e.g. the wasm/v86 path).
    pub fn set_status_line(&mut self, status: String) {
        self.cached_status_line = status;
        self.status_line_dirty = false;
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

    /// Auto-adopt every untagged window: returns set-option commands to tag
    /// each one, AND mutates the local `WindowState` so the very next state
    /// emission already reflects the inferred type (no foreign-window flicker
    /// while the set-option round-trip is in flight). Idempotent — windows
    /// with `@tmuxy-window-type` already set are skipped.
    ///
    /// Name-based inference (defensive, in case set-option from a tmuxy script
    /// hasn't propagated yet):
    /// - `float` or `__float_*` → Float
    /// - `group` or `__group_*` → Group
    /// - `__sidebar` → Sidebar
    /// - anything else → Tab (auto-adopt: existing user windows become tabs)
    pub fn collect_window_tag_commands(&mut self) -> Vec<String> {
        let mut cmds = Vec::new();
        for window in self.windows.values_mut() {
            if window.window_type.is_some() {
                continue;
            }
            let inferred = if window.name == "float" || window.name.starts_with("__float_") {
                WindowType::Float
            } else if window.name == "group" || window.name.starts_with("__group_") {
                WindowType::Group
            } else if window.name == "__sidebar" {
                WindowType::Sidebar
            } else {
                WindowType::Tab
            };
            window.window_type = Some(inferred);
            cmds.push(format!(
                "set-option -w -t {} {} {}",
                window.id,
                crate::constants::tmux_options::WINDOW_TYPE,
                inferred.as_str()
            ));
            // Every Tab window must carry `pane-border-status top` so its
            // topmost pane sits at y=1, reserving the border row that PaneLayout
            // draws the pane header into. `enforce_settings` only sets this on
            // the window active at attach (it's a per-window option, NOT global
            // — `set -g` risks a tmux 3.5a control-mode crash), so a window born
            // later (a new tab from `new-window` → splitw+breakp) would default
            // to `off`, leaving its pane at y=0 and the header stealing the
            // first content row. Tagging is the one place every new window
            // funnels through, so enforce it here, per-window (targeted, safe).
            if inferred == WindowType::Tab {
                cmds.push(format!(
                    "set-option -w -t {} pane-border-status top",
                    window.id
                ));
                cmds.push(format!(
                    "set-option -w -t {} pane-border-format ' '",
                    window.id
                ));
            }
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

    /// Process a control mode event.
    /// Returns information about state changes and any panes that need content refresh.
    pub fn process_event(&mut self, event: ControlModeEvent) -> ProcessEventResult {
        match event {
            ControlModeEvent::Output { pane_id, content } => {
                let (changed, new_imgs, clipboard) = self.handle_output(&pane_id, &content);
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
                        ChangeType::PaneOutput {
                            pane_id: pane_id.clone(),
                        }
                    } else {
                        ChangeType::None
                    },
                    new_images,
                    clipboard_writes,
                    commands: Vec::new(),
                }
            }

            ControlModeEvent::ExtendedOutput {
                pane_id, content, ..
            } => {
                let (changed, new_imgs, clipboard) = self.handle_output(&pane_id, &content);
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
                        ChangeType::PaneOutput {
                            pane_id: pane_id.clone(),
                        }
                    } else {
                        ChangeType::None
                    },
                    new_images,
                    clipboard_writes,
                    commands: Vec::new(),
                }
            }

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
                    self.status_line_dirty = true;
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
                self.status_line_dirty = true;
                // Don't emit state yet - wait for WindowRenamed or list-windows
                // to populate the window name. This prevents brief flashes of
                // windows appearing with empty names (which breaks stack detection).
                ProcessEventResult::default()
            }

            ControlModeEvent::WindowClose { window_id } => {
                self.windows.remove(&window_id);
                self.panes.retain(|_, p| p.window_id != window_id);
                self.pending_captures
                    .retain(|id| self.panes.contains_key(id));
                self.status_line_dirty = true;
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
                self.status_line_dirty = true;
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
                self.status_line_dirty = true; // Active window changed - refresh status line

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

                // Every mutating command the frontend sends — including each
                // send-keys keystroke batch — comes back as an empty ack. An
                // empty body carries no state, so treating it as a Full change
                // forced a whole TmuxState rebuild, per-pane clone and diff on
                // every keypress. Nothing to parse means nothing changed.
                //
                // A non-empty body is still assumed to be list-panes/
                // list-windows output. Marker-wrapping the self-issued list
                // commands (as captures already are) would let this be exact
                // rather than sniffed.
                if !success || output.trim().is_empty() {
                    return ProcessEventResult::default();
                }

                // Not a capture-pane response - parse list-panes/list-windows responses to update state
                let resized_panes = self.handle_command_response(&output);
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
                    let w = (pane.width as u16).max(1);
                    let h = (pane.height as u16).max(1);
                    pane.terminal = vt100::Parser::new(h, w, 0);
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

    /// Handle command response (list-panes, list-windows) and return list of panes that were resized.
    fn handle_command_response(&mut self, output: &str) -> Vec<String> {
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

        // Refresh status line on periodic sync (list-windows response)
        if is_list_windows_response {
            self.status_line_dirty = true;
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
        let num_tail_fields = 6;

        // Tail fields (fixed, never free-text): alternate_on, mouse_any_flag,
        // selection_present, selection_start_x, selection_start_y, history_size.
        let (
            alternate_on,
            mouse_any_flag,
            selection_present,
            selection_start_x,
            selection_start_y,
            history_size,
        ) = if parts.len() >= 17 {
            let last = parts.len() - 1;
            (
                parts[last - 5] == "1",
                parts[last - 4] == "1",
                parts[last - 3] == "1",
                parts[last - 2].parse::<u32>().unwrap_or(0),
                parts[last - 1].parse::<u64>().unwrap_or(0),
                parts[last].parse::<u64>().unwrap_or(0),
            )
        } else {
            (false, false, false, 0u32, 0u64, 0u64)
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
        pane.selection_present = selection_present;
        pane.selection_start_x = selection_start_x;
        pane.selection_start_y = selection_start_y;
        pane.history_size = history_size;

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
    /// `@id,index,active,window_type,float_parent,float_width,float_height,float_drawer,float_bg,float_noheader,group_panes,name`
    /// `window_name` is LAST and free text — we `splitn` so its own commas stay
    /// in the trailing field and can't shift any parsed column. Every column
    /// after `active` is a `@tmuxy-*` user option that may be empty.
    fn parse_list_windows_line(&mut self, line: &str) {
        // 12 fields; splitn keeps window_name (the 12th) intact even with commas.
        let parts: Vec<&str> = line.splitn(12, ',').collect();
        if parts.len() < 11 {
            return;
        }

        let window_id = parts[0].trim();
        if !window_id.starts_with('@') {
            return;
        }

        let index: u32 = parts[1].parse().unwrap_or(0);
        let active = parts[2] == "1";
        let name = parts.get(11).map(|s| s.to_string()).unwrap_or_default();

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
        // Group pane membership stored as space-separated (e.g. "%4 %6 %7")
        // to avoid colliding with the comma-separated list-windows format.
        let group_panes = opt(10).map(|s| {
            s.split_whitespace()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        });

        let window = self
            .windows
            .entry(window_id.to_string())
            .or_insert_with(|| WindowState::new(window_id));

        window.index = index;
        window.name = name;
        window.active = active;
        window.window_type = window_type;
        window.group_panes = group_panes;
        window.float_parent = float_parent;
        window.float_width = float_width;
        window.float_height = float_height;
        window.float_drawer = float_drawer;
        window.float_bg = float_bg;
        window.float_noheader = float_noheader;

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
        if prev.border_title != curr.border_title {
            delta.border_title = Some(curr.border_title.clone());
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
        if prev.group_panes != curr.group_panes {
            delta.group_panes = Some(curr.group_panes.clone());
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
        let panes: Vec<TmuxPane> = matching_pane_ids
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

    /// An empty command ack must not be reported as a state change.
    ///
    /// Every mutating command — including each send-keys batch the keyboard
    /// actor sends — returns `%begin`/`%end` with no body. Treating those as
    /// `ChangeType::Full` forced a full TmuxState rebuild + diff per keystroke.
    #[test]
    fn empty_command_ack_reports_no_change() {
        let mut agg = StateAggregator::new();
        seed_pane(&mut agg, "%0", "@0");

        for body in ["", "   ", "\n", "  \n  "] {
            let r = agg.process_event(ControlModeEvent::CommandResponse {
                timestamp: 0,
                command_num: 0,
                output: body.to_string(),
                success: true,
            });
            assert!(
                !r.state_changed,
                "empty ack {body:?} must not report a state change"
            );
            assert!(matches!(r.change_type, ChangeType::None));
        }
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
        format!(
            // id,idx,x,y,w,h,cx,cy,active,command,TITLE,in_mode,copy_x,copy_y,scroll,WIN,BORDER,alt,mouse,sel,sx,sy,hist
            "%3,0,0,0,80,24,0,0,1,zsh,{title},0,0,0,0,{window_id},{border_title},0,0,0,0,0,100"
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
        // @id,index,active,type,float_parent,fw,fh,drawer,bg,noheader,group,name
        let line = format!("@7,3,1,tab,,,,,,,,{name}");
        let mut agg = StateAggregator::new();
        agg.parse_list_windows_line(&line);
        let w = agg.windows.get("@7").expect("window parsed");
        assert_eq!(w.index, 3, "index must not be shifted by the comma name");
        assert_eq!(w.name, name);
        assert!(w.active);
        assert_eq!(w.window_type, Some(WindowType::Tab));
        assert_eq!(agg.active_window_id.as_deref(), Some("@7"));
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
            output: "@1,5,1,tab,,,,,,,,shell".to_string(),
            success: true,
        });
        assert_eq!(
            agg.windows.get("@1").unwrap().index,
            5,
            "authoritative list-windows index must overwrite the provisional"
        );
    }
}
