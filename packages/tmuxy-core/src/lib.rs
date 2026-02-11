pub mod control_mode;
pub mod executor;
pub mod session;

use serde::{Deserialize, Serialize};

// Re-export key binding types and functions
pub use executor::{get_prefix_bindings, get_prefix_key, get_root_bindings, process_key, KeyBinding};

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

/// Convert pane content to a string for hashing/comparison purposes
pub fn content_to_hash_string(content: &PaneContent) -> String {
    content
        .iter()
        .map(|line| line.iter().map(|cell| cell.char.as_str()).collect::<String>())
        .collect::<Vec<_>>()
        .join("")
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

        for col in 0..cols {
            let cell = screen.cell(row, col).unwrap();
            // vt100 returns empty string for unwritten cells; use space to preserve
            // column alignment when characters are joined on the frontend
            let raw_content = cell.contents();
            let char_content = if raw_content.is_empty() { " ".to_string() } else { raw_content };

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

            // Get URL from OSC parser if available
            let url = osc_parser.and_then(|p| p.get_url(row as u32, col as u32).cloned());

            let style = CellStyle {
                fg,
                bg,
                bold: cell.bold(),
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

/// Parse ANSI content into structured cells using vt100 terminal emulation
pub fn parse_ansi_to_cells(content: &str, width: u32, height: u32) -> PaneContent {
    let mut parser = vt100::Parser::new(height as u16, width as u16, 0);

    // Normalize newlines for vt100
    let normalized: Vec<u8> = content.bytes().flat_map(|b| {
        if b == b'\n' {
            vec![b'\r', b'\n']
        } else {
            vec![b]
        }
    }).collect();

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
    pub tmux_id: String, // actual tmux pane ID (e.g., "%0")
    pub window_id: String, // window this pane belongs to (e.g., "@0")
    pub content: PaneContent,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
    pub active: bool,
    pub command: String,
    pub title: String, // pane title (set by shell/application)
    pub border_title: String, // evaluated pane-border-format from tmux config
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
    /// True if this pane's output is paused due to flow control
    /// When true, UI should show a pause indicator
    #[serde(default)]
    pub paused: bool,
    /// Pane group ID (from @tmuxy_pane_group_id user option)
    /// When set, this pane belongs to the group identified by this ID (parent pane's tmux_id)
    #[serde(default)]
    pub group_id: Option<String>,
    /// Pane group tab index (from @tmuxy_pane_group_index user option)
    /// Determines tab ordering within the group (0, 1, 2...)
    #[serde(default)]
    pub group_tab_index: Option<u32>,
}

/// A single tmux window (tab)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxWindow {
    /// Window ID (e.g., "@0")
    pub id: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
    /// True if this is a hidden pane group window (name starts with "__%")
    pub is_pane_group_window: bool,
    /// Parent pane ID if this is a pane group window (e.g., "%5")
    pub pane_group_parent_pane: Option<String>,
    /// Pane group index if this is a pane group window (0, 1, 2...)
    pub pane_group_index: Option<u32>,
    /// True if this is a hidden float window (name starts with "__float_")
    #[serde(default)]
    pub is_float_window: bool,
    /// Parent window ID for float window (from @float_parent option)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_parent: Option<String>,
    /// Float window width in chars (from @float_width option)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_width: Option<u32>,
    /// Float window height in chars (from @float_height option)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_height: Option<u32>,
}

/// Info parsed from a pane group window name
pub struct PaneGroupWindowInfo {
    pub parent_pane_id: String,
    pub pane_group_index: u32,
}

/// Check if a window name matches the float window pattern: "__float_{title}"
/// Returns true if the name starts with "__float_"
pub fn is_float_window_name(name: &str) -> bool {
    name.starts_with("__float_")
}

/// Parse a pane group window name pattern: "__%{pane_id}_group_{n}"
/// Returns None if the name doesn't match the pattern
pub fn parse_pane_group_window_name(name: &str) -> Option<PaneGroupWindowInfo> {
    // Pattern: __%{pane_id}_group_{n}
    // Example: __%5_group_1
    if !name.starts_with("__%") {
        return None;
    }

    let rest = &name[3..]; // Skip "__%"
    let parts: Vec<&str> = rest.split("_group_").collect();
    if parts.len() != 2 {
        return None;
    }

    // Pane ID part must not be empty
    if parts[0].is_empty() {
        return None;
    }

    let pane_id = format!("%{}", parts[0]);
    let pane_group_index = parts[1].parse::<u32>().ok()?;

    Some(PaneGroupWindowInfo {
        parent_pane_id: pane_id,
        pane_group_index,
    })
}

/// Tmux popup state
/// Note: Popup control mode support requires tmux version with PR #4361 merged.
/// Until then, popup state will always be None.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxPopup {
    /// Popup ID (unique identifier)
    pub id: String,
    /// Popup content (terminal cells)
    pub content: PaneContent,
    /// Cursor position
    pub cursor_x: u32,
    pub cursor_y: u32,
    /// Popup dimensions
    pub width: u32,
    pub height: u32,
    /// Position relative to window (centered by default)
    pub x: u32,
    pub y: u32,
    /// Whether the popup is currently active (receiving input)
    pub active: bool,
    /// Command running in popup (if any)
    pub command: String,
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
    /// Active popup (if any)
    /// Note: Requires tmux with control mode popup support (PR #4361)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub popup: Option<TmuxPopup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxError {
    pub message: String,
}

/// Delta update for a single pane (only changed fields)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaneDelta {
    /// Window ID (only if changed, e.g. after swap-pane across windows)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    /// Content (only if changed) - structured cells or ANSI strings
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<PaneContent>,
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
    /// Flow control pause state (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    /// Pane group ID (only if changed): Some(Some(x)) = set, Some(None) = cleared, None = unchanged
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Option<String>>,
    /// Pane group tab index (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_tab_index: Option<Option<u32>>,
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
            && self.in_mode.is_none()
            && self.copy_cursor_x.is_none()
            && self.copy_cursor_y.is_none()
            && self.alternate_on.is_none()
            && self.mouse_any_flag.is_none()
            && self.paused.is_none()
            && self.group_id.is_none()
            && self.group_tab_index.is_none()
    }
}

/// Delta update for a single window (only changed fields)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_pane_group_window: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_group_parent_pane: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_group_index: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_float_window: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_parent: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_width: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_height: Option<Option<u32>>,
}

impl WindowDelta {
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.active.is_none()
            && self.is_pane_group_window.is_none()
            && self.pane_group_parent_pane.is_none()
            && self.pane_group_index.is_none()
            && self.is_float_window.is_none()
            && self.float_parent.is_none()
            && self.float_width.is_none()
            && self.float_height.is_none()
    }
}

/// Delta update for popup (only changed fields, or None = popup closed)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PopupDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<PaneContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_y: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

impl PopupDelta {
    pub fn is_empty(&self) -> bool {
        self.content.is_none()
            && self.cursor_x.is_none()
            && self.cursor_y.is_none()
            && self.width.is_none()
            && self.height.is_none()
            && self.x.is_none()
            && self.y.is_none()
            && self.active.is_none()
            && self.command.is_none()
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
    /// Total dimensions changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_height: Option<u32>,
    /// Popup changed: Some(popup) = new/updated, Some(delta) = partial update, None field = removed
    /// Using Option<Option<...>> where outer None = no change, Some(None) = popup closed, Some(Some(delta)) = popup updated
    #[serde(skip_serializing_if = "Option::is_none")]
    pub popup: Option<Option<TmuxPopup>>,
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
            total_width: None,
            total_height: None,
            popup: None,
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
            && self.total_width.is_none()
            && self.total_height.is_none()
            && self.popup.is_none()
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

/// Capture the state of all panes in the current window
pub fn capture_state() -> Result<TmuxState, String> {
    capture_state_for_session(DEFAULT_SESSION_NAME)
}

/// Capture the state of all panes in a specific session's current window
pub fn capture_state_for_session(session_name: &str) -> Result<TmuxState, String> {
    let pane_infos = executor::get_all_panes_info(session_name)?;
    let window_infos = executor::get_windows(session_name)?;

    // Find active window
    let active_window_id = window_infos
        .iter()
        .find(|w| w.active)
        .map(|w| w.id.clone());

    let mut panes = Vec::new();
    let mut total_width = 0u32;
    let mut total_height = 0u32;

    for info in pane_infos {
        let content = executor::capture_pane_by_id(&info.id)?;

        // Track total dimensions
        let pane_right = info.x + info.width;
        let pane_bottom = info.y + info.height;
        if pane_right > total_width {
            total_width = pane_right;
        }
        if pane_bottom > total_height {
            total_height = pane_bottom;
        }

        panes.push(TmuxPane {
            id: info.index,
            tmux_id: info.id.clone(),
            window_id: info.window_id,
            content: parse_ansi_to_cells(&content, info.width, info.height),
            cursor_x: info.cursor_x,
            cursor_y: info.cursor_y,
            width: info.width,
            height: info.height,
            x: info.x,
            y: info.y,
            active: info.active,
            command: info.command,
            title: info.title,
            border_title: info.border_title,
            in_mode: info.in_mode,
            copy_cursor_x: info.copy_cursor_x,
            copy_cursor_y: info.copy_cursor_y,
            // These are populated in control mode, not available in polling mode
            alternate_on: false,
            mouse_any_flag: false,
            paused: false,
            group_id: info.group_id,
            group_tab_index: info.group_tab_index,
        });
    }

    // Convert window infos
    let windows: Vec<TmuxWindow> = window_infos
        .into_iter()
        .map(|w| {
            // Check if this is a pane group or float window
            let pane_group_info = parse_pane_group_window_name(&w.name);
            TmuxWindow {
                id: w.id,
                index: w.index,
                name: w.name.clone(),
                active: w.active,
                is_pane_group_window: pane_group_info.is_some(),
                pane_group_parent_pane: pane_group_info.as_ref().map(|g| g.parent_pane_id.clone()),
                pane_group_index: pane_group_info.as_ref().map(|g| g.pane_group_index),
                is_float_window: is_float_window_name(&w.name),
                // Float window options are only available in control mode (via list-windows)
                // Polling mode doesn't support these
                float_parent: None,
                float_width: None,
                float_height: None,
            }
        })
        .collect();

    // Find active pane
    let active_pane_id = panes
        .iter()
        .find(|p| p.active)
        .map(|p| p.tmux_id.clone());

    // Capture status line (use total_width from pane layout for proper padding)
    let status_line = executor::capture_status_line(session_name, total_width as usize).unwrap_or_default();

    Ok(TmuxState {
        session_name: session_name.to_string(),
        active_window_id,
        active_pane_id,
        panes,
        windows,
        total_width,
        total_height,
        status_line,
        // Popup state requires tmux with control mode popup support (PR #4361)
        // Until that's merged, popup detection is not possible
        popup: None,
    })
}

// Alias for backwards compatibility
pub fn capture_window_state() -> Result<TmuxState, String> {
    capture_state()
}

pub fn capture_window_state_for_session(session_name: &str) -> Result<TmuxState, String> {
    capture_state_for_session(session_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pane_group_window_name() {
        // Valid pane group window names
        let info = parse_pane_group_window_name("__%5_group_1").unwrap();
        assert_eq!(info.parent_pane_id, "%5");
        assert_eq!(info.pane_group_index, 1);

        let info = parse_pane_group_window_name("__%123_group_42").unwrap();
        assert_eq!(info.parent_pane_id, "%123");
        assert_eq!(info.pane_group_index, 42);

        // Invalid names should return None
        assert!(parse_pane_group_window_name("workspace").is_none());
        assert!(parse_pane_group_window_name("_workspace").is_none());
        assert!(parse_pane_group_window_name("__workspace").is_none());
        assert!(parse_pane_group_window_name("__%5_notgroup_1").is_none());
        assert!(parse_pane_group_window_name("__%5_group_").is_none());
        assert!(parse_pane_group_window_name("__%_group_1").is_none());
    }
}
