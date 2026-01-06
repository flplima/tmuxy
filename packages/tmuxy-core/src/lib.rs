pub mod control_mode;
pub mod executor;
pub mod session;

use serde::{Deserialize, Serialize};

// Re-export key binding types and functions
pub use executor::{get_prefix_bindings, get_prefix_key, KeyBinding};

/// Default session name for tmuxy
pub const DEFAULT_SESSION_NAME: &str = "tmuxy";

/// A single tmux pane
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxPane {
    pub id: u32,
    pub tmux_id: String, // actual tmux pane ID (e.g., "%0")
    pub window_id: String, // window this pane belongs to (e.g., "@0")
    pub content: Vec<String>,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
    pub active: bool,
    pub command: String,
    pub in_mode: bool, // true if in copy mode
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,
}

/// A single tmux window (tab)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxWindow {
    /// Window ID (e.g., "@0")
    pub id: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
    /// True if this is a hidden stack window (name starts with "__")
    pub is_stack_window: bool,
    /// Parent pane ID if this is a stack window (e.g., "%5")
    pub stack_parent_pane: Option<String>,
    /// Stack index if this is a stack window (0, 1, 2...)
    pub stack_index: Option<u32>,
}

/// Info parsed from a stack window name
pub struct StackWindowInfo {
    pub parent_pane_id: String,
    pub stack_index: u32,
}

/// Parse a stack window name pattern: "__%{pane_id}_stack_{n}"
/// Returns None if the name doesn't match the pattern
pub fn parse_stack_window_name(name: &str) -> Option<StackWindowInfo> {
    // Pattern: __%{pane_id}_stack_{n}
    // Example: __%5_stack_1
    if !name.starts_with("__%") {
        return None;
    }

    let rest = &name[3..]; // Skip "__%"
    let parts: Vec<&str> = rest.split("_stack_").collect();
    if parts.len() != 2 {
        return None;
    }

    // Pane ID part must not be empty
    if parts[0].is_empty() {
        return None;
    }

    let pane_id = format!("%{}", parts[0]);
    let stack_index = parts[1].parse::<u32>().ok()?;

    Some(StackWindowInfo {
        parent_pane_id: pane_id,
        stack_index,
    })
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxError {
    pub message: String,
}

/// Capture the state of all panes in the current window
pub fn capture_state() -> Result<TmuxState, String> {
    capture_state_for_session(DEFAULT_SESSION_NAME)
}

/// Capture the state of all panes in a specific session's current window
pub fn capture_state_for_session(session_name: &str) -> Result<TmuxState, String> {
    let pane_infos = executor::get_all_panes_info(session_name)?;
    let window_infos = executor::get_windows(session_name)?;

    // Find active window first (panes from get_all_panes_info belong to this window)
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
            tmux_id: info.id,
            window_id: active_window_id.clone().unwrap_or_default(),
            content: content.lines().map(String::from).collect(),
            cursor_x: info.cursor_x,
            cursor_y: info.cursor_y,
            width: info.width,
            height: info.height,
            x: info.x,
            y: info.y,
            active: info.active,
            command: info.command,
            in_mode: info.in_mode,
            copy_cursor_x: info.copy_cursor_x,
            copy_cursor_y: info.copy_cursor_y,
        });
    }

    // Convert window infos
    let windows: Vec<TmuxWindow> = window_infos
        .into_iter()
        .map(|w| {
            // Check if this is a stack window
            let stack_info = parse_stack_window_name(&w.name);
            TmuxWindow {
                id: w.id,
                index: w.index,
                name: w.name,
                active: w.active,
                is_stack_window: stack_info.is_some(),
                stack_parent_pane: stack_info.as_ref().map(|s| s.parent_pane_id.clone()),
                stack_index: stack_info.as_ref().map(|s| s.stack_index),
            }
        })
        .collect();

    // Find active pane
    let active_pane_id = panes
        .iter()
        .find(|p| p.active)
        .map(|p| p.tmux_id.clone());

    Ok(TmuxState {
        session_name: session_name.to_string(),
        active_window_id,
        active_pane_id,
        panes,
        windows,
        total_width,
        total_height,
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
    fn test_parse_stack_window_name() {
        // Valid stack window names
        let info = parse_stack_window_name("__%5_stack_1").unwrap();
        assert_eq!(info.parent_pane_id, "%5");
        assert_eq!(info.stack_index, 1);

        let info = parse_stack_window_name("__%123_stack_42").unwrap();
        assert_eq!(info.parent_pane_id, "%123");
        assert_eq!(info.stack_index, 42);

        // Invalid names should return None
        assert!(parse_stack_window_name("workspace").is_none());
        assert!(parse_stack_window_name("_workspace").is_none());
        assert!(parse_stack_window_name("__workspace").is_none());
        assert!(parse_stack_window_name("__%5_notstack_1").is_none());
        assert!(parse_stack_window_name("__%5_stack_").is_none());
        assert!(parse_stack_window_name("__%_stack_1").is_none());
    }
}
