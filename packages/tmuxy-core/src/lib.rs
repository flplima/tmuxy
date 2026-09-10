pub mod constants;
pub mod control_mode;
pub mod error;

// Native (non-wasm) transport + tmux-command layer, gated behind `native`.
#[cfg(feature = "native")]
pub mod command_router;
#[cfg(feature = "native")]
pub mod ctx;
#[cfg(feature = "native")]
pub mod debug_log;
#[cfg(feature = "native")]
pub mod executor;

pub mod layout;
pub mod mime;
#[cfg(feature = "native")]
pub mod retry;
#[cfg(feature = "native")]
pub mod servers;
#[cfg(feature = "native")]
pub mod session;
#[cfg(feature = "native")]
pub mod theme;
#[cfg(feature = "native")]
pub mod tmux_service;
#[cfg(feature = "native")]
pub mod trace;
#[cfg(feature = "native")]
pub mod worktrees;

#[cfg(feature = "native")]
pub use ctx::{Clock, Ctx, TmuxCommand};
#[cfg(feature = "native")]
pub use tmux_service::{build_tmux_stack, TmuxRequest, TmuxService, TMUX_CALL_TIMEOUT};

pub use error::{Result as TmuxResult, TmuxError};
#[cfg(feature = "native")]
pub use retry::{retry_with, RetryPolicy};

use serde::{Deserialize, Serialize};

// Re-export key binding types and functions
#[cfg(feature = "native")]
pub use executor::{get_prefix_bindings, get_prefix_key, get_root_bindings, KeyBinding};

/// Default session name for tmuxy
pub const DEFAULT_SESSION_NAME: &str = "tmuxy";

// ============================================
// Structured Cell Types (for eliminating double ANSI parsing)
// ============================================

/// Color representation for terminal cells
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum CellColor {
    /// Indexed color (0-255)
    Indexed(u8),
    /// RGB color
    Rgb { r: u8, g: u8, b: u8 },
}

/// Cell style attributes (only present if cell has non-default styling)
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CellStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<CellColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<CellColor>,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub bold: bool,
    /// SGR 2: faint/dim text. Apps like Claude Code use this for autosuggestions.
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub dim: bool,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub italic: bool,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub underline: bool,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub inverse: bool,
    /// OSC 8 hyperlink URL (if cell is part of a hyperlink)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl CellStyle {
    pub fn is_empty(&self) -> bool {
        self.fg.is_none()
            && self.bg.is_none()
            && !self.bold
            && !self.dim
            && !self.italic
            && !self.underline
            && !self.inverse
            && self.url.is_none()
    }
}

/// A single terminal cell with character and optional styling
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalCell {
    /// The character(s) in this cell (usually single char, but can be multi-byte)
    #[serde(rename = "c")]
    pub char: String,
    /// Style attributes (only present if cell has styling)
    #[serde(rename = "s", skip_serializing_if = "Option::is_none")]
    pub style: Option<CellStyle>,
}

impl TerminalCell {
    pub fn new(char: String) -> Self {
        Self { char, style: None }
    }

    pub fn with_style(char: String, style: CellStyle) -> Self {
        let style = if style.is_empty() { None } else { Some(style) };
        Self { char, style }
    }
}

/// A line of terminal cells
pub type TerminalLine = Vec<TerminalCell>;

/// Pane content as structured cells (pre-parsed from ANSI)
pub type PaneContent = Vec<TerminalLine>;

/// One cell's character, as everything downstream spells it.
///
/// vt100 gives an unwritten cell — and the continuation half of a wide one —
/// an empty string; a space keeps the joined line on the column grid. Shared
/// so a hyperlink mark and the extraction that validates it are comparing the
/// same spelling of the same cell.
pub fn screen_cell_char(screen: &vt100::Screen, row: u16, col: u16) -> String {
    let raw = screen
        .cell(row, col)
        .map(|c| c.contents())
        .unwrap_or_default();
    if raw.is_empty() {
        " ".to_string()
    } else {
        raw.to_string()
    }
}

/// Extract structured cells from a vt100 screen.
/// This is the single source of truth for cell extraction, used by both
/// parse_ansi_to_cells (polling mode) and PaneState::get_content (control mode).
pub fn extract_cells_from_screen(screen: &vt100::Screen) -> PaneContent {
    extract_cells_with_urls(screen, None)
}

/// Extract structured cells from a vt100 screen with optional OSC parser for hyperlinks.
/// When osc_parser is provided, URL information is included in cell styles.
pub fn extract_cells_with_urls(
    screen: &vt100::Screen,
    osc_parser: Option<&control_mode::OscParser>,
) -> PaneContent {
    let (rows, cols) = screen.size();
    let mut lines: Vec<TerminalLine> = Vec::with_capacity(rows as usize);

    for row in 0..rows {
        let mut line: Vec<TerminalCell> = Vec::with_capacity(cols as usize);

        // The row's text first, as a unit: a hyperlink is only still a
        // hyperlink if the text it was written on is still there, and that is
        // judged per run rather than per cell (see `OscParser::row_urls`).
        let chars: Vec<String> = (0..cols)
            .map(|col| screen_cell_char(screen, row, col))
            .collect();
        let row_urls = osc_parser.map(|p| p.row_urls(row as u32, &chars));

        // `chars` is consumed here, so collecting the row up front costs no
        // allocation over building each cell's string in place.
        for (col, char_content) in chars.into_iter().enumerate() {
            let col = col as u16;
            // `screen.cell` only returns None when row/col exceed the grid bounds,
            // which the `0..rows` / `0..cols` loops guarantee against.
            let Some(cell) = screen.cell(row, col) else {
                continue;
            };

            let fg = match cell.fgcolor() {
                vt100::Color::Default => None,
                vt100::Color::Idx(idx) => Some(CellColor::Indexed(idx)),
                vt100::Color::Rgb(r, g, b) => Some(CellColor::Rgb { r, g, b }),
            };

            let bg = match cell.bgcolor() {
                vt100::Color::Default => None,
                vt100::Color::Idx(idx) => Some(CellColor::Indexed(idx)),
                vt100::Color::Rgb(r, g, b) => Some(CellColor::Rgb { r, g, b }),
            };

            let url = row_urls
                .as_ref()
                .and_then(|urls| urls[col as usize].map(str::to_string));

            let style = CellStyle {
                fg,
                bg,
                bold: cell.bold(),
                dim: cell.dim(),
                italic: cell.italic(),
                underline: cell.underline(),
                inverse: cell.inverse(),
                url,
            };

            line.push(TerminalCell::with_style(char_content, style));
        }

        // Trim trailing empty cells
        while let Some(last) = line.last() {
            if last.char.trim().is_empty() && last.style.is_none() {
                line.pop();
            } else {
                break;
            }
        }

        lines.push(line);
    }

    lines
}

/// Parse scrollback content into structured cells.
/// Uses the line count from the content itself as the height.
pub fn parse_scrollback_to_cells(content: &str, width: u32) -> PaneContent {
    let line_count = content.lines().count().max(1) as u32;
    parse_ansi_to_cells(content, width, line_count)
}

/// Parse ANSI content into structured cells using vt100 terminal emulation
pub fn parse_ansi_to_cells(content: &str, width: u32, height: u32) -> PaneContent {
    let mut parser = vt100::Parser::new(height as u16, width as u16, 0);

    let normalized = control_mode::normalize_capture_bytes(content.as_bytes());
    parser.process(&normalized);
    extract_cells_from_screen(parser.screen())
}

// ============================================
// Tmux State Types
// ============================================

/// A single tmux pane
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxPane {
    pub id: u32,
    pub tmux_id: String,   // actual tmux pane ID (e.g., "%0")
    pub window_id: String, // window this pane belongs to (e.g., "@0")
    /// Rendered cell grid. `Arc`-shared so building a state snapshot, storing
    /// `prev_state`, and diffing unchanged panes never deep-copies the grid —
    /// the cost that made a one-field delta as expensive as a full sync.
    /// Serializes transparently (serde `rc`), so the wire shape is unchanged.
    pub content: std::sync::Arc<PaneContent>,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
    pub active: bool,
    pub command: String,
    pub title: String,        // pane title (set by shell/application)
    pub border_title: String, // evaluated pane-border-format from tmux config
    /// Pane-group identity from `@tmuxy-group-id` (e.g. `g5`). `None` unless the
    /// pane belongs to a group. Set on the visible member and every hidden
    /// member (the latter emitted as lightweight stubs from the stash session),
    /// so the frontend reconstructs group membership by grouping on this value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub in_mode: bool, // true if in copy mode
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,
    /// True if the application is in alternate screen mode (vim, less, htop)
    /// Used to determine scroll behavior (wheel -> arrow keys vs copy mode)
    #[serde(default)]
    pub alternate_on: bool,
    /// True if the application has mouse tracking enabled
    /// When true, mouse events should be forwarded as SGR sequences
    #[serde(default)]
    pub mouse_any_flag: bool,
    /// True if this is tmux's marked pane (`select-pane -m`). The UI shows an
    /// indicator and offers swap/join with it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub marked: bool,
    /// True if this pane's output is paused due to flow control
    /// When true, UI should show a pause indicator
    #[serde(default)]
    pub paused: bool,
    /// Number of history lines (scrollback above the visible area)
    #[serde(default)]
    pub history_size: u64,
    /// Whether a selection is active in copy mode
    #[serde(default)]
    pub selection_present: bool,
    /// Selection start X (visible-area-relative column), only meaningful when selection_present
    #[serde(default)]
    pub selection_start_x: u32,
    /// Selection start Y (visible-area-relative row, can be negative if off-screen)
    #[serde(default)]
    pub selection_start_y: i32,
    /// Image placements on this pane's terminal grid
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<control_mode::images::ImagePlacement>,
    /// Cursor shape from DECSCUSR: 0/1=block_blink, 2=block, 3=underline_blink, 4=underline, 5=bar_blink, 6=bar
    #[serde(default)]
    pub cursor_shape: u8,
    /// Whether the cursor is hidden (DECTCEM mode 25 off / ESC[?25l)
    #[serde(default)]
    pub cursor_hidden: bool,
}

/// Window type discriminator. Set on windows tmuxy created or has adopted.
/// Windows without a type are foreign and tmuxy ignores them everywhere.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowType {
    Tab,
    Float,
    FloatBackdrop,
    /// The left sidebar's window — a single pane running `tmuxy widget tree`,
    /// which the UI renders as the tab/pane tree. See [`SidebarRight`] for the
    /// properties both sidebars share.
    ///
    /// [`SidebarRight`]: WindowType::SidebarRight
    SidebarLeft,
    /// The right sidebar's window — a single pane holding a shell (or whatever
    /// the user runs there) that the UI docks to the right edge on every tab.
    ///
    /// Both sidebar kinds are chrome windows exactly like floats: excluded from
    /// the tab bar, and sized to their own narrow column rather than the client
    /// viewport (see [`constants::sidebar_dock`]).
    SidebarRight,
}

impl WindowType {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "tab" => Some(WindowType::Tab),
            "float" => Some(WindowType::Float),
            "float-backdrop" => Some(WindowType::FloatBackdrop),
            "sidebar-left" => Some(WindowType::SidebarLeft),
            "sidebar-right" => Some(WindowType::SidebarRight),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WindowType::Tab => "tab",
            WindowType::Float => "float",
            WindowType::FloatBackdrop => "float-backdrop",
            WindowType::SidebarLeft => "sidebar-left",
            WindowType::SidebarRight => "sidebar-right",
        }
    }

    /// Whether this is one of the two docked sidebar columns. They share every
    /// behaviour that separates chrome from tabs — hidden from the tab strip,
    /// no pane border, sized to a fixed column — and differ only in width and
    /// which edge they dock to.
    pub fn is_sidebar(self) -> bool {
        matches!(self, WindowType::SidebarLeft | WindowType::SidebarRight)
    }
}

/// A single tmux window (tab/float/group/foreign)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxWindow {
    /// Window ID (e.g., "@0")
    pub id: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
    /// Window type as set via @tmuxy-window-type. None = foreign window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_type: Option<WindowType>,
    /// Parent window ID for a float (the launcher window) or backdrop (the float).
    /// Sourced from @tmuxy-float-parent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_parent: Option<String>,
    /// Float width in cells (from @tmuxy-float-width).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_width: Option<u32>,
    /// Float height in cells (from @tmuxy-float-height).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_height: Option<u32>,
    /// Drawer-style float direction (from @tmuxy-float-drawer).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_drawer: Option<String>,
    /// Float backdrop style (from @tmuxy-float-bg).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_bg: Option<String>,
    /// True if the float hides its header chrome (from @tmuxy-float-noheader).
    #[serde(default, skip_serializing_if = "is_false")]
    pub float_noheader: bool,
    /// A sidebar column's width in terminal columns when the user has dragged it
    /// off its default (from @tmuxy-sidebar-cols). The client draws the column
    /// at this many cells, so it must match what the backend sized the pane to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_cols: Option<u32>,
    /// True while the user has closed this sidebar column (from
    /// @tmuxy-sidebar-hidden). The pane behind it stays alive, so the window
    /// existing no longer means the column is shown.
    #[serde(default, skip_serializing_if = "is_false")]
    pub sidebar_hidden: bool,
    /// True while the window keeps only the active pane's first-level row
    /// expanded (from @tmuxy-collapsible; see `layout.rs`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub collapsible: bool,
    /// True while a pane in this window is zoomed. tmux hides every other pane
    /// when zoomed; the frontend must not keep painting them underneath.
    #[serde(default)]
    pub zoomed: bool,
    /// The window's own active pane. tmux keeps one per window, but `pane.active`
    /// is collapsed to the session's single active pane for the client, so a
    /// background tab's active pane would otherwise be unknown until it is
    /// switched to — and the switch would land on its first pane for a beat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
}

/// Full tmux state with all panes and windows
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxState {
    /// Session name (e.g., "tmuxy")
    pub session_name: String,
    /// Active window ID (e.g., "@0")
    pub active_window_id: Option<String>,
    /// Active pane ID (e.g., "%0")
    pub active_pane_id: Option<String>,
    pub panes: Vec<TmuxPane>,
    pub windows: Vec<TmuxWindow>,
    pub total_width: u32,
    pub total_height: u32,
    /// Rendered tmux status line with ANSI escape sequences
    pub status_line: String,
    /// Pending one-shot focus request from a shell helper (`left` / `right` /
    /// `panes`), or `None` when nothing is queued. See
    /// [`constants::tmux_options::FOCUS_REQUEST`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_request: Option<String>,
}

/// Serialize a line-number-keyed map with STRING keys. serde_json does this
/// implicitly (JSON object keys are strings — the wire shape the frontend
/// already speaks), but serde-wasm-bindgen's maps-as-objects mode REFUSES
/// non-string keys ("Map key is not a string"), which aborted serialization of
/// every content-carrying delta on the wasm path.
fn ser_line_map<S: serde::Serializer>(
    v: &Option<std::collections::HashMap<usize, TerminalLine>>,
    s: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    match v {
        None => s.serialize_none(),
        Some(m) => {
            let mut map = s.serialize_map(Some(m.len()))?;
            for (k, val) in m {
                map.serialize_entry(&k.to_string(), val)?;
            }
            map.end()
        }
    }
}

/// Delta update for a single pane (only changed fields)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaneDelta {
    /// Window ID (only if changed, e.g. after swap-pane across windows)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    /// Content (only changed lines) - line index → line content
    /// Only lines that differ from the previous state are included.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_line_map"
    )]
    pub content: Option<std::collections::HashMap<usize, TerminalLine>>,
    /// Cursor position (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_y: Option<u32>,
    /// Dimensions (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Position (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<u32>,
    /// Active state (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    /// Command (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Title (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Border title (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_title: Option<String>,
    /// Pane-group id (only if changed). Outer `Option` = "changed?"; inner
    /// `Option` = the new value (`None` clears it — the pane left its group).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Option<String>>,
    /// Copy mode state (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_cursor_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_cursor_y: Option<u32>,
    /// Alternate screen mode (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternate_on: Option<bool>,
    /// Mouse any flag (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mouse_any_flag: Option<bool>,
    /// Marked pane flag (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marked: Option<bool>,
    /// Flow control pause state (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    /// History size (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_size: Option<u64>,
    /// Selection present (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_present: Option<bool>,
    /// Selection start X (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_start_x: Option<u32>,
    /// Selection start Y (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_start_y: Option<i32>,
    /// Image placements (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<control_mode::images::ImagePlacement>>,
    /// Cursor shape (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_shape: Option<u8>,
    /// Cursor hidden (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_hidden: Option<bool>,
}

impl PaneDelta {
    pub fn is_empty(&self) -> bool {
        self.window_id.is_none()
            && self.content.is_none()
            && self.cursor_x.is_none()
            && self.cursor_y.is_none()
            && self.width.is_none()
            && self.height.is_none()
            && self.x.is_none()
            && self.y.is_none()
            && self.active.is_none()
            && self.command.is_none()
            && self.title.is_none()
            && self.border_title.is_none()
            && self.group_id.is_none()
            && self.in_mode.is_none()
            && self.copy_cursor_x.is_none()
            && self.copy_cursor_y.is_none()
            && self.alternate_on.is_none()
            && self.mouse_any_flag.is_none()
            && self.marked.is_none()
            && self.paused.is_none()
            && self.history_size.is_none()
            && self.selection_present.is_none()
            && self.selection_start_x.is_none()
            && self.selection_start_y.is_none()
            && self.images.is_none()
            && self.cursor_shape.is_none()
            && self.cursor_hidden.is_none()
    }
}

/// Delta update for a single window (only changed fields)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowDelta {
    /// The window's index moved: `move-window` / `swap-window` renumber the
    /// windows behind the moved one too, and the strip is ordered by index.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_type: Option<Option<WindowType>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_parent: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_width: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_height: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_drawer: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_bg: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_noheader: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_cols: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collapsible: Option<bool>,
    /// True while this window has a zoomed pane. tmux hides the other panes
    /// entirely when zoomed, so the frontend needs this to do the same.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoomed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<Option<String>>,
}

impl WindowDelta {
    pub fn is_empty(&self) -> bool {
        self.index.is_none()
            && self.active_pane_id.is_none()
            && self.name.is_none()
            && self.active.is_none()
            && self.window_type.is_none()
            && self.float_parent.is_none()
            && self.float_width.is_none()
            && self.float_height.is_none()
            && self.float_drawer.is_none()
            && self.float_bg.is_none()
            && self.float_noheader.is_none()
            && self.sidebar_cols.is_none()
            && self.sidebar_hidden.is_none()
            && self.collapsible.is_none()
            && self.zoomed.is_none()
    }
}

/// Delta state update - only includes what changed
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxDelta {
    /// Sequence number for ordering
    pub seq: u64,
    /// Changed panes: pane_id -> delta (None = pane removed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panes: Option<std::collections::HashMap<String, Option<PaneDelta>>>,
    /// Changed windows: window_id -> delta (None = window removed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows: Option<std::collections::HashMap<String, Option<WindowDelta>>>,
    /// New panes (full data for newly added panes)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_panes: Option<Vec<TmuxPane>>,
    /// New windows (full data for newly added windows)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_windows: Option<Vec<TmuxWindow>>,
    /// Active window changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_window_id: Option<String>,
    /// Active pane changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
    /// Status line changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_line: Option<String>,
    /// A shell helper queued (or cleared) a focus request. `Some("")` means it
    /// was cleared — the option is gone — so the field distinguishes "no change"
    /// (absent) from "no longer pending" (empty string).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus_request: Option<String>,
    /// Total dimensions changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_height: Option<u32>,
}

impl TmuxDelta {
    pub fn new(seq: u64) -> Self {
        Self {
            seq,
            panes: None,
            windows: None,
            new_panes: None,
            new_windows: None,
            active_window_id: None,
            active_pane_id: None,
            status_line: None,
            focus_request: None,
            total_width: None,
            total_height: None,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.panes.is_none()
            && self.windows.is_none()
            && self.new_panes.is_none()
            && self.new_windows.is_none()
            && self.active_window_id.is_none()
            && self.active_pane_id.is_none()
            && self.status_line.is_none()
            && self.focus_request.is_none()
            && self.total_width.is_none()
            && self.total_height.is_none()
    }
}

/// Message type for state updates (full or delta)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StateUpdate {
    /// Full state (used for initial sync and reconnection)
    #[serde(rename = "full")]
    Full { state: TmuxState },
    /// Delta update (used for incremental updates)
    #[serde(rename = "delta")]
    Delta { delta: TmuxDelta },
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn window_type_round_trip() {
        for ty in [
            WindowType::Tab,
            WindowType::Float,
            WindowType::FloatBackdrop,
            WindowType::SidebarLeft,
            WindowType::SidebarRight,
        ] {
            let s = ty.as_str();
            assert_eq!(WindowType::parse(s), Some(ty));
        }
        assert_eq!(WindowType::parse("workspace"), None);
        assert_eq!(WindowType::parse(""), None);
    }

    #[test]
    fn window_type_serializes_as_kebab() {
        let ty = WindowType::FloatBackdrop;
        let json = serde_json::to_string(&ty).unwrap();
        assert_eq!(json, "\"float-backdrop\"");
        let back: WindowType = serde_json::from_str(&json).unwrap();
        assert_eq!(back, WindowType::FloatBackdrop);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod vt100_capture_test {
    #[test]
    fn test_capture_pane_first_line() {
        // Simulate capture-pane output (14 lines ending with newline)
        let content = b"1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n";

        // Strip trailing newline (as done in reset_and_process_capture)
        let content = if content.ends_with(b"\n") {
            &content[..content.len() - 1]
        } else {
            &content[..]
        };

        // Create terminal with 14 rows, 128 cols
        let mut terminal = vt100::Parser::new(14, 128, 0);

        // Normalize newlines (as done in reset_and_process_capture)
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

        // Process the content
        terminal.process(&normalized);

        // Extract cells
        let screen = terminal.screen();
        let content = crate::extract_cells_from_screen(screen);

        // Check first 3 rows
        assert_eq!(content[0][0].char, "1", "First row should start with '1'");
        assert_eq!(content[1][0].char, "2", "Second row should start with '2'");
        assert_eq!(content[2][0].char, "3", "Third row should start with '3'");
    }

    #[test]
    fn test_sgr_dim_faint_propagates_to_cell_style() {
        // SGR 2 (faint/dim) — used by Claude Code's TUI for autosuggestion text.
        // vt100 0.15 silently dropped this; 0.16 propagates it as cell.dim().
        // \e[2m turns on dim, \e[22m turns it off, \e[0m fully resets.
        let bytes = b"\x1b[2mdim\x1b[22m bright\x1b[2mD\x1b[0mP";
        let mut terminal = vt100::Parser::new(1, 32, 0);
        terminal.process(bytes);

        let cells = crate::extract_cells_from_screen(terminal.screen());
        let row = &cells[0];

        let is_dim = |col: usize| {
            row.get(col)
                .expect("cell present")
                .style
                .as_ref()
                .is_some_and(|s| s.dim)
        };

        // Column layout for "\x1b[2mdim\x1b[22m bright\x1b[2mD\x1b[0mP":
        //   0..2: 'd','i','m' (dim on)
        //   3:    ' '         (dim off)
        //   4..9: 'b','r','i','g','h','t'
        //   10:   'D'         (dim on again)
        //   11:   'P'         (dim off via SGR 0)
        assert!(is_dim(0), "'d' should be dim");
        assert!(is_dim(1), "'i' should be dim");
        assert!(is_dim(2), "'m' should be dim");
        assert!(!is_dim(4), "'b' (in 'bright') should not be dim");
        assert!(!is_dim(9), "'t' (end of 'bright') should not be dim");
        assert!(is_dim(10), "'D' after re-enabling SGR 2 should be dim");
        assert!(!is_dim(11), "'P' after SGR 0 should not be dim");
    }

    #[test]
    fn test_emoji_width() {
        let bytes = "🟥".as_bytes();
        let mut terminal = vt100::Parser::new(1, 10, 0);
        terminal.process(bytes);
        let screen = terminal.screen();
        let (_, col) = screen.cursor_position();
        assert_eq!(col, 2, "vt100 should treat 🟥 as 2 columns wide");
    }

    /// Feed `text` to a fresh 1×20 emulator and return the cursor column plus
    /// the non-empty cell contents in order — the shape tmux's grid would have
    /// (`screen_write_combine`), which is the oracle for these cases: tmux
    /// reports `#{cursor_x}` from ITS grid, so any width disagreement here
    /// shows up as text drifting off the grid in the browser.
    fn combined_cells(text: &str) -> (u16, Vec<String>) {
        let mut terminal = vt100::Parser::new(1, 20, 0);
        terminal.process(text.as_bytes());
        let screen = terminal.screen();
        let (_, col) = screen.cursor_position();
        let cells = (0..20)
            .filter_map(|c| screen.cell(0, c))
            .filter(|cell| cell.has_contents())
            .map(|cell| cell.contents().to_string())
            .collect();
        (col, cells)
    }

    #[test]
    fn zwj_sequence_is_one_wide_cell() {
        // 👩 + ZWJ + 💻: tmux joins the character after a ZWJ into the same
        // cell, so the sequence is one 2-column glyph — not 👩 + 💻 (4 columns).
        let (col, cells) = combined_cells("👩\u{200D}💻X");
        assert_eq!(col, 3);
        assert_eq!(cells, vec!["👩\u{200D}💻", "X"]);
    }

    #[test]
    fn zwj_sequence_that_outgrows_the_cell_starts_a_new_character() {
        // 👨‍👩‍👧‍👦 is 25 bytes; the cell holds 22, so the last member is
        // written as its own wide character (tmux: same rule, 21-byte cells).
        let (col, cells) = combined_cells("👨\u{200D}👩\u{200D}👧\u{200D}👦X");
        assert_eq!(col, 5);
        assert_eq!(cells, vec!["👨\u{200D}👩\u{200D}👧\u{200D}", "👦", "X"]);
    }

    #[test]
    fn skin_tone_modifier_joins_its_emoji() {
        // U+1F3FD is itself East Asian Wide; without the tmux rule it would
        // take two more columns after 👍.
        let (col, cells) = combined_cells("👍\u{1F3FD}X");
        assert_eq!(col, 3);
        assert_eq!(cells, vec!["👍\u{1F3FD}", "X"]);
    }

    #[test]
    fn skin_tone_modifier_after_a_non_emoji_is_its_own_character() {
        let (col, cells) = combined_cells("a\u{1F3FD}X");
        assert_eq!(col, 4);
        assert_eq!(cells, vec!["a", "\u{1F3FD}", "X"]);
    }

    #[test]
    fn variation_selector_keeps_the_base_width() {
        // ❤ + VS16 stays a 1-column cell (tmux default:
        // variation-selector-always-wide off).
        let (col, cells) = combined_cells("\u{2764}\u{FE0F}X");
        assert_eq!(col, 2);
        assert_eq!(cells, vec!["\u{2764}\u{FE0F}", "X"]);
    }

    #[test]
    fn regional_indicator_pair_is_one_wide_cell() {
        // 🇺🇸: two 1-column indicators become one 2-column flag; a third
        // indicator starts a new (unpaired) flag cell.
        let (col, cells) = combined_cells("\u{1F1FA}\u{1F1F8}\u{1F1E9}X");
        assert_eq!(col, 4);
        assert_eq!(cells, vec!["\u{1F1FA}\u{1F1F8}", "\u{1F1E9}", "X"]);
        let screen_cells = {
            let mut terminal = vt100::Parser::new(1, 20, 0);
            terminal.process("\u{1F1FA}\u{1F1F8}".as_bytes());
            let screen = terminal.screen();
            (
                screen.cell(0, 0).unwrap().is_wide(),
                screen.cell(0, 1).unwrap().is_wide_continuation(),
            )
        };
        assert_eq!(screen_cells, (true, true));
    }

    #[test]
    fn hangul_filler_and_dangling_joiners_are_dropped() {
        // U+3164 is ignored outright; a ZWJ / VS16 at column 0 has nothing to
        // attach to and is discarded rather than drawn.
        let (col, cells) = combined_cells("\u{3164}\u{200D}\u{FE0F}X");
        assert_eq!(col, 1);
        assert_eq!(cells, vec!["X"]);
    }

    #[test]
    fn combining_mark_joins_a_wide_character_through_its_continuation() {
        // The cell before the cursor is 中's continuation half; the accent
        // must land on 中 itself.
        let (col, cells) = combined_cells("中\u{0301}X");
        assert_eq!(col, 3);
        assert_eq!(cells, vec!["中\u{0301}", "X"]);
    }
}

#[cfg(test)]
mod pane_delta_marked_tests {
    use super::PaneDelta;

    /// A mark toggle is often the ONLY thing that changes about a pane; a delta
    /// carrying just `marked` must not be classified as empty, or it is never
    /// sent and the flag waits for the next full snapshot.
    #[test]
    fn a_delta_with_only_the_marked_flag_is_not_empty() {
        let delta = PaneDelta {
            marked: Some(true),
            ..PaneDelta::default()
        };
        assert!(!delta.is_empty());
        assert!(PaneDelta::default().is_empty());
    }
}
