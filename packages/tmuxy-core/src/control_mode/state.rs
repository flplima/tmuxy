//! State aggregator for tmux control mode
//!
//! Aggregates control mode events into coherent state using vt100 terminal emulation.

use super::parser::ControlModeEvent;
use crate::{extract_cells_from_screen, extract_cells_with_urls, is_float_window_name, parse_pane_group_window_name, PaneContent, TmuxPane, TmuxPopup, TmuxState, TmuxWindow};
use std::collections::HashMap;

/// Type of change that occurred
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeType {
    /// No change
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

impl Default for ChangeType {
    fn default() -> Self {
        ChangeType::None
    }
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

    /// Raw output buffer (for rich content like images)
    pub raw_buffer: Vec<u8>,

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

    /// Tmux-reported cursor position (authoritative)
    pub tmux_cursor_x: u32,
    pub tmux_cursor_y: u32,

    /// Whether application is in alternate screen mode (vim, less, htop)
    pub alternate_on: bool,

    /// Whether application wants mouse events (mouse tracking enabled)
    pub mouse_any_flag: bool,

    /// Whether this pane's output is paused due to flow control
    pub paused: bool,

    /// Pane group ID (from @tmuxy_pane_group_id user option)
    pub group_id: Option<String>,

    /// Pane group tab index (from @tmuxy_pane_group_index user option)
    pub group_tab_index: Option<u32>,

    /// Content captured during copy mode (separate from main terminal to avoid corruption)
    pub copy_mode_content: Option<PaneContent>,
}

impl PaneState {
    pub fn new(id: &str, width: u32, height: u32) -> Self {
        Self {
            id: id.to_string(),
            index: 0,
            window_id: String::new(),
            terminal: vt100::Parser::new(height as u16, width as u16, 0),
            osc_parser: super::osc::OscParser::new(),
            raw_buffer: Vec::new(),
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
            tmux_cursor_x: 0,
            tmux_cursor_y: 0,
            alternate_on: false,
            mouse_any_flag: false,
            paused: false,
            group_id: None,
            group_tab_index: None,
            copy_mode_content: None,
        }
    }

    /// Process new output for this pane (appends to existing buffer)
    pub fn process_output(&mut self, content: &[u8]) {
        // Store raw content for rich content parsing
        self.raw_buffer.extend(content);

        // Limit raw buffer size (keep last 64KB)
        if self.raw_buffer.len() > 65536 {
            let start = self.raw_buffer.len() - 65536;
            self.raw_buffer = self.raw_buffer[start..].to_vec();
        }

        // Process through OSC parser to extract hyperlinks/clipboard
        // Returns content with OSC sequences stripped for vt100
        let processed = self.osc_parser.process(content);

        // Process through terminal emulator
        self.terminal.process(&processed);
    }

    /// Reset terminal and process capture-pane output.
    /// capture-pane returns plain text with ANSI colors but no cursor positioning,
    /// so we need to reset to top-left before processing.
    pub fn reset_and_process_capture(&mut self, content: &[u8]) {
        // Create fresh terminal to clear all state
        self.terminal = vt100::Parser::new(self.height as u16, self.width as u16, 0);
        self.raw_buffer.clear();

        // Normalize newlines: capture-pane outputs \n only, but vt100 treats \n as
        // "move down" without returning to column 0. We need \r\n for proper line handling.
        let normalized: Vec<u8> = content.iter().flat_map(|&b| {
            if b == b'\n' {
                vec![b'\r', b'\n']
            } else {
                vec![b]
            }
        }).collect();

        // Process the normalized content
        self.terminal.process(&normalized);
        self.raw_buffer.extend(content);
    }

    /// Resize the terminal.
    /// Returns true if the dimensions actually changed.
    pub fn resize(&mut self, width: u32, height: u32) -> bool {
        if self.width != width || self.height != height {
            self.width = width;
            self.height = height;
            // Create a new terminal parser with the new dimensions.
            // This clears the old content which is necessary because after a resize
            // (e.g., after split-pane), the old content is no longer valid.
            // The monitor should issue capture-pane commands to refresh content.
            self.terminal = vt100::Parser::new(height as u16, width as u16, 0);
            self.raw_buffer.clear();
            true
        } else {
            false
        }
    }

    /// Get the rendered screen content as structured cells
    pub fn get_content(&self) -> PaneContent {
        extract_cells_with_urls(self.terminal.screen(), Some(&self.osc_parser))
    }

    /// Process capture-pane output during copy mode.
    /// Uses a temporary terminal to avoid corrupting the main terminal state,
    /// since %output events from background processes continue arriving during copy mode.
    pub fn process_copy_mode_capture(&mut self, content: &[u8]) {
        let mut temp_terminal = vt100::Parser::new(self.height as u16, self.width as u16, 0);

        // Normalize newlines: capture-pane outputs \n only, but vt100 treats \n as
        // "move down" without returning to column 0. We need \r\n for proper line handling.
        let normalized: Vec<u8> = content.iter().flat_map(|&b| {
            if b == b'\n' {
                vec![b'\r', b'\n']
            } else {
                vec![b]
            }
        }).collect();

        temp_terminal.process(&normalized);
        self.copy_mode_content = Some(extract_cells_from_screen(temp_terminal.screen()));
    }

    /// Convert to TmuxPane struct
    pub fn to_tmux_pane(&self) -> TmuxPane {
        // Use vt100 emulator cursor for immediate feedback on output events.
        // The vt100 cursor is updated on every %output event, while tmux_cursor_x/y
        // are only updated on periodic list-panes responses (every 500ms).
        let screen = self.terminal.screen();
        let vt100_cursor_x = screen.cursor_position().1 as u32;
        let vt100_cursor_y = screen.cursor_position().0 as u32;

        TmuxPane {
            id: self.index,
            tmux_id: self.id.clone(),
            window_id: self.window_id.clone(),
            content: if self.in_mode {
                self.copy_mode_content.as_ref().cloned().unwrap_or_else(|| self.get_content())
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
            group_id: self.group_id.clone(),
            group_tab_index: self.group_tab_index,
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

    /// Float parent window ID (from @float_parent option)
    pub float_parent: Option<String>,

    /// Float width in chars (from @float_width option)
    pub float_width: Option<u32>,

    /// Float height in chars (from @float_height option)
    pub float_height: Option<u32>,
}

impl WindowState {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            index: id
                .trim_start_matches('@')
                .parse()
                .unwrap_or(0),
            name: String::new(),
            active: false,
            layout: String::new(),
            float_parent: None,
            float_width: None,
            float_height: None,
        }
    }

    pub fn to_tmux_window(&self) -> TmuxWindow {
        let pane_group_info = parse_pane_group_window_name(&self.name);
        TmuxWindow {
            id: self.id.clone(),
            index: self.index,
            name: self.name.clone(),
            active: self.active,
            is_pane_group_window: pane_group_info.is_some(),
            pane_group_parent_pane: pane_group_info.as_ref().map(|g| g.parent_pane_id.clone()),
            pane_group_index: pane_group_info.as_ref().map(|g| g.pane_group_index),
            is_float_window: is_float_window_name(&self.name),
            float_parent: self.float_parent.clone(),
            float_width: self.float_width,
            float_height: self.float_height,
        }
    }
}

/// Popup state (for control mode popup support)
pub struct PopupState {
    /// Popup ID
    pub id: String,

    /// Terminal emulator for popup content
    pub terminal: vt100::Parser,

    /// Dimensions
    pub width: u32,
    pub height: u32,

    /// Position
    pub x: u32,
    pub y: u32,

    /// Whether the popup is active
    pub active: bool,

    /// Command running in popup
    pub command: String,
}

impl PopupState {
    pub fn new(id: &str, width: u32, height: u32, x: u32, y: u32, command: Option<String>) -> Self {
        Self {
            id: id.to_string(),
            terminal: vt100::Parser::new(height as u16, width as u16, 0),
            width,
            height,
            x,
            y,
            active: true,
            command: command.unwrap_or_default(),
        }
    }

    /// Process output for the popup
    pub fn process_output(&mut self, content: &[u8]) {
        self.terminal.process(content);
    }

    /// Get popup content as structured cells
    pub fn get_content(&self) -> PaneContent {
        extract_cells_from_screen(self.terminal.screen())
    }

    /// Convert to TmuxPopup for sending to frontend
    pub fn to_tmux_popup(&self) -> TmuxPopup {
        let screen = self.terminal.screen();
        let cursor_x = screen.cursor_position().1 as u32;
        let cursor_y = screen.cursor_position().0 as u32;

        TmuxPopup {
            id: self.id.clone(),
            content: self.get_content(),
            cursor_x,
            cursor_y,
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
            active: self.active,
            command: self.command.clone(),
        }
    }
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

    /// Default pane dimensions (used when creating new panes)
    default_width: u32,
    default_height: u32,

    /// Queue of pane IDs for pending capture-pane commands (FIFO).
    /// We use a queue because we can't reliably match command numbers when
    /// attaching to an existing session (tmux's counter may be at a different point).
    pending_captures: std::collections::VecDeque<String>,

    /// Cached status line (optimization: only refresh on window events or periodic sync)
    cached_status_line: String,

    /// Whether status line needs refresh
    status_line_dirty: bool,

    // Delta state tracking
    /// Previous state snapshot for delta computation
    prev_state: Option<crate::TmuxState>,

    /// Sequence number for delta updates
    delta_seq: u64,

    /// Active popup state (if any)
    /// Note: Requires tmux with control mode popup support (PR #4361)
    popup: Option<PopupState>,
}

impl StateAggregator {
    pub fn new() -> Self {
        Self {
            session_name: crate::DEFAULT_SESSION_NAME.to_string(),
            panes: HashMap::new(),
            windows: HashMap::new(),
            active_window_id: None,
            default_width: 80,
            default_height: 24,
            pending_captures: std::collections::VecDeque::new(),
            cached_status_line: String::new(),
            status_line_dirty: true, // Fetch on first state request
            prev_state: None,
            delta_seq: 0,
            popup: None,
        }
    }

    /// Create with a specific session name
    pub fn with_session_name(session_name: &str) -> Self {
        Self {
            session_name: session_name.to_string(),
            panes: HashMap::new(),
            windows: HashMap::new(),
            active_window_id: None,
            default_width: 80,
            default_height: 24,
            pending_captures: std::collections::VecDeque::new(),
            cached_status_line: String::new(),
            status_line_dirty: true, // Fetch on first state request
            prev_state: None,
            delta_seq: 0,
            popup: None,
        }
    }

    /// Mark status line as needing refresh (call on window-related events)
    pub fn mark_status_line_dirty(&mut self) {
        self.status_line_dirty = true;
    }

    /// Refresh status line if dirty, otherwise use cached value.
    /// Width is the total terminal width from pane layout, used for padding.
    fn get_status_line(&mut self, width: usize) -> String {
        if self.status_line_dirty {
            self.cached_status_line = crate::executor::capture_status_line(&self.session_name, width)
                .unwrap_or_default();
            self.status_line_dirty = false;
        }
        self.cached_status_line.clone()
    }

    /// Check if output looks like capture-pane output (terminal content).
    /// capture-pane output has different characteristics than list-panes/list-windows:
    /// - list-panes: lines start with %pane_id followed by comma-separated fields
    /// - list-windows: lines start with @window_id followed by comma-separated fields
    /// - capture-pane: terminal content with ANSI escapes, arbitrary text
    fn looks_like_capture_output(&self, output: &str) -> bool {
        // Empty output is not capture output (could be from a command that produces no output)
        if output.is_empty() {
            return false;
        }

        // Check all non-empty lines
        let lines: Vec<&str> = output.lines().collect();
        if lines.is_empty() {
            return false;
        }

        // list-panes output: each line starts with %N, (pane ID, comma)
        // list-windows output: each line starts with @N, (window ID, comma)
        // Both have consistent comma-separated format
        let first_line = lines[0];

        // If it looks like list-panes format
        if first_line.starts_with('%') && first_line.contains(',') {
            // Check if all lines follow the pattern
            let all_list_panes = lines.iter().all(|line| {
                line.starts_with('%') && line.contains(',')
            });
            if all_list_panes {
                return false; // This is list-panes output
            }
        }

        // If it looks like list-windows format
        if first_line.starts_with('@') && first_line.contains(',') {
            // Check if all lines follow the pattern
            let all_list_windows = lines.iter().all(|line| {
                line.starts_with('@') && line.contains(',')
            });
            if all_list_windows {
                return false; // This is list-windows output
            }
        }

        // If we have pending captures and the output doesn't match list formats,
        // it's likely capture-pane output
        true
    }

    /// Queue capture-pane commands for matching responses.
    /// Pane IDs are queued in the order the commands were sent (FIFO).
    /// We use FIFO because we can't reliably match command numbers when
    /// attaching to an existing session (tmux's counter may be different).
    pub fn queue_captures(&mut self, pane_ids: &[String]) {
        for pane_id in pane_ids {
            self.pending_captures.push_back(pane_id.clone());
        }
    }

    /// Check if any pane is currently in copy mode
    pub fn has_pane_in_copy_mode(&self) -> bool {
        self.panes.values().any(|p| p.in_mode)
    }

    /// Get IDs of panes currently in copy mode (only those with a valid window)
    pub fn get_panes_in_copy_mode(&self) -> Vec<String> {
        self.panes.values()
            .filter(|p| p.in_mode && !p.window_id.is_empty())
            .map(|p| p.id.clone())
            .collect()
    }

    /// Process a control mode event.
    /// Returns information about state changes and any panes that need content refresh.
    pub fn process_event(&mut self, event: ControlModeEvent) -> ProcessEventResult {
        match event {
            ControlModeEvent::Output { pane_id, content } => {
                let changed = self.handle_output(&pane_id, &content);
                ProcessEventResult {
                    state_changed: changed,
                    panes_needing_refresh: Vec::new(),
                    change_type: if changed {
                        ChangeType::PaneOutput { pane_id: pane_id.clone() }
                    } else {
                        ChangeType::None
                    },
                }
            }

            ControlModeEvent::ExtendedOutput {
                pane_id, content, ..
            } => {
                let changed = self.handle_output(&pane_id, &content);
                ProcessEventResult {
                    state_changed: changed,
                    panes_needing_refresh: Vec::new(),
                    change_type: if changed {
                        ChangeType::PaneOutput { pane_id: pane_id.clone() }
                    } else {
                        ChangeType::None
                    },
                }
            }

            ControlModeEvent::LayoutChange {
                window_id, layout, ..
            } => {
                let resized_panes = self.handle_layout_change(&window_id, &layout);
                ProcessEventResult {
                    state_changed: true,
                    panes_needing_refresh: resized_panes,
                    change_type: ChangeType::PaneLayout,
                }
            }

            ControlModeEvent::WindowAdd { window_id } => {
                self.windows
                    .entry(window_id.clone())
                    .or_insert_with(|| WindowState::new(&window_id));
                self.status_line_dirty = true; // Window added - refresh status line
                // Don't emit state yet - wait for WindowRenamed or list-windows
                // to populate the window name. This prevents brief flashes of
                // windows appearing with empty names (which breaks stack detection).
                ProcessEventResult::default()
            }

            ControlModeEvent::WindowClose { window_id } => {
                self.windows.remove(&window_id);
                // Remove panes belonging to this window
                self.panes
                    .retain(|_, p| p.window_id != window_id);
                self.status_line_dirty = true; // Window closed - refresh status line
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::WindowRenamed { window_id, name } => {
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.name = name;
                }
                self.status_line_dirty = true; // Window renamed - refresh status line
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::WindowPaneChanged {
                window_id,
                pane_id,
            } => {
                // Update active pane in window
                for (_, pane) in self.panes.iter_mut() {
                    if pane.window_id == window_id {
                        pane.active = pane.id == pane_id;
                    }
                }
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::PaneFocus,
                    ..Default::default()
                }
            }

            ControlModeEvent::PaneModeChanged { pane_id: _ } => {
                // Don't toggle blindly - the list-panes periodic sync (every 500ms)
                // provides the authoritative in_mode state. Toggling here could cause
                // desync if events are duplicated or lost.
                // The next list-panes response will set the correct in_mode value.
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::PaneFocus,
                    ..Default::default()
                }
            }

            ControlModeEvent::SessionWindowChanged { window_id, .. } => {
                // Update active window
                for (id, window) in self.windows.iter_mut() {
                    window.active = *id == window_id;
                }
                self.active_window_id = Some(window_id);
                self.status_line_dirty = true; // Active window changed - refresh status line
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Window,
                    ..Default::default()
                }
            }

            ControlModeEvent::CommandResponse { output, success, .. } => {
                // First, try to match pending capture-pane responses using heuristics.
                // capture-pane output characteristics:
                // - Doesn't look like list-panes output (no leading %pane_id,pane_index,...)
                // - Doesn't look like list-windows output (no leading @window_id,...)
                // - Usually multi-line with terminal content (ANSI escape codes, text)
                //
                // Note: We use FIFO because tmux command numbers can't be reliably
                // tracked when attaching to an existing session.
                if !self.pending_captures.is_empty() && success {
                    // Check if this looks like capture-pane output
                    let is_capture_output = self.looks_like_capture_output(&output);

                    if is_capture_output {
                        if let Some(pane_id) = self.pending_captures.pop_front() {
                            if let Some(pane) = self.panes.get_mut(&pane_id) {
                                if pane.in_mode {
                                    // In copy mode: process into separate copy_mode_content
                                    // to avoid corrupting the main terminal state
                                    pane.process_copy_mode_capture(output.as_bytes());
                                } else {
                                    // Normal mode: reset and reprocess the main terminal
                                    pane.reset_and_process_capture(output.as_bytes());

                                    // After processing capture output, the vt100 cursor is at the end
                                    // of the content (last row). Reposition it to tmux's actual cursor
                                    // position so subsequent %output events render correctly.
                                    let cursor_seq = format!(
                                        "\x1b[{};{}H",
                                        pane.tmux_cursor_y + 1,
                                        pane.tmux_cursor_x + 1
                                    );
                                    pane.terminal.process(cursor_seq.as_bytes());
                                }
                            }
                            return ProcessEventResult {
                                state_changed: true,
                                change_type: ChangeType::PaneOutput { pane_id },
                                ..Default::default()
                            };
                        }
                    }
                }

                // Not a capture-pane response - parse list-panes/list-windows responses to update state
                let resized_panes = if success {
                    self.handle_command_response(&output)
                } else {
                    Vec::new()
                };
                ProcessEventResult {
                    state_changed: true,
                    panes_needing_refresh: resized_panes,
                    change_type: ChangeType::Full, // Command responses may update many things
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
            ControlModeEvent::Exit { .. } => {
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Session,
                    ..Default::default()
                }
            }

            // ============================================
            // Popup Events (requires tmux with PR #4361)
            // ============================================

            ControlModeEvent::PopupOpen {
                popup_id,
                width,
                height,
                x,
                y,
                command,
            } => {
                self.popup = Some(PopupState::new(&popup_id, width, height, x, y, command));
                ProcessEventResult {
                    state_changed: true,
                    change_type: ChangeType::Full, // Popup changes affect keyboard routing
                    ..Default::default()
                }
            }

            ControlModeEvent::PopupOutput { popup_id, content } => {
                if let Some(ref mut popup) = self.popup {
                    if popup.id == popup_id {
                        popup.process_output(&content);
                        return ProcessEventResult {
                            state_changed: true,
                            change_type: ChangeType::Full,
                            ..Default::default()
                        };
                    }
                }
                ProcessEventResult::default()
            }

            ControlModeEvent::PopupClose { popup_id } => {
                if let Some(ref popup) = self.popup {
                    if popup.id == popup_id {
                        self.popup = None;
                        return ProcessEventResult {
                            state_changed: true,
                            change_type: ChangeType::Full,
                            ..Default::default()
                        };
                    }
                }
                ProcessEventResult::default()
            }

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

            _ => ProcessEventResult::default(),
        }
    }

    fn handle_output(&mut self, pane_id: &str, content: &[u8]) -> bool {
        // Only process output for panes we know about from list-panes.
        // This prevents creating panes from other tmux sessions.
        // Panes are added via parse_list_panes_line() which sets window_id.
        if let Some(pane) = self.panes.get_mut(pane_id) {
            // Only process if pane has a valid window_id (was seen in list-panes)
            if !pane.window_id.is_empty() {
                pane.process_output(content);
                return true;
            }
        }
        // Ignore output from unknown panes (likely from other sessions)
        false
    }

    /// Handle layout change and return list of pane IDs that need content refresh.
    fn handle_layout_change(&mut self, window_id: &str, layout: &str) -> Vec<String> {
        if let Some(window) = self.windows.get_mut(window_id) {
            window.layout = layout.to_string();
        }

        // Parse layout to update pane positions and collect resized pane IDs
        let resized_panes = self.parse_layout(window_id, layout);

        // Return panes that were resized (they need content refresh)
        resized_panes
    }

    /// Parse tmux layout string to extract pane positions.
    /// Returns a list of pane IDs that were resized.
    ///
    /// Layout format: `checksum,WxH,x,y[,pane-id or {children} or [children]]`
    /// - `{}` = horizontal split (side by side)
    /// - `[]` = vertical split (stacked)
    fn parse_layout(&mut self, window_id: &str, layout: &str) -> Vec<String> {
        // Skip the checksum prefix (e.g., "abc123,")
        let layout = if let Some(idx) = layout.find(',') {
            &layout[idx + 1..]
        } else {
            return Vec::new();
        };

        let mut resized_panes = Vec::new();
        self.parse_layout_recursive(window_id, layout, 0, 0, &mut resized_panes);
        resized_panes
    }

    fn parse_layout_recursive(
        &mut self,
        window_id: &str,
        layout: &str,
        base_x: u32,
        base_y: u32,
        resized_panes: &mut Vec<String>,
    ) -> Option<(u32, u32)> {
        // Parse dimensions: WxH,x,y
        let parts: Vec<&str> = layout.splitn(4, ',').collect();
        if parts.len() < 3 {
            return None;
        }

        // Parse WxH
        let dims: Vec<&str> = parts[0].split('x').collect();
        if dims.len() != 2 {
            return None;
        }

        let width: u32 = dims[0].parse().ok()?;
        let height: u32 = dims[1].parse().ok()?;
        let x: u32 = parts[1].parse().ok()?;
        let y: u32 = parts[2].parse().ok()?;

        // Check for children or pane ID
        if parts.len() >= 4 {
            let rest = parts[3];

            // Check for pane ID (just a number)
            if let Ok(pane_idx) = rest.trim_end_matches(|c| c == ']' || c == '}').parse::<u32>() {
                // Find pane by index and update position
                // Note: We construct pane_id from layout index, but this may not match actual
                // pane IDs after panes are created/deleted. Only update position, not window_id.
                // window_id is set by list-panes command which has accurate pane IDs.
                let pane_id = format!("%{}", pane_idx);
                if let Some(pane) = self.panes.get_mut(&pane_id) {
                    // Only update position if pane already has this window_id
                    // (was set by list-panes), to avoid associating wrong panes
                    if pane.window_id == window_id {
                        pane.x = base_x + x;
                        pane.y = base_y + y;
                        // resize() returns true if dimensions changed
                        if pane.resize(width, height) {
                            resized_panes.push(pane_id);
                        }
                    }
                }
            }
            // Note: Full recursive layout parsing with {} and [] is complex
            // For now, we rely on list-panes command for accurate positions
        }

        Some((width, height))
    }

    /// Handle command response (list-panes, list-windows) and return list of panes that were resized.
    fn handle_command_response(&mut self, output: &str) -> Vec<String> {
        // Track which panes we see in this response
        let mut seen_panes: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut resized_panes: Vec<String> = Vec::new();
        let mut is_list_panes_response = false;

        // Try to parse as list-panes output
        for line in output.lines() {
            if line.contains('%') && line.contains(',') {
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
        }

        // Try to parse as list-windows output
        let mut is_list_windows_response = false;
        for line in output.lines() {
            if line.contains('@') && line.contains(',') {
                self.parse_list_windows_line(line);
                is_list_windows_response = true;
            }
        }

        // Refresh status line on periodic sync (list-windows response)
        if is_list_windows_response {
            self.status_line_dirty = true;
        }

        resized_panes
    }

    /// Parse a line from list-panes output.
    /// Expected format: `%pane_id,pane_index,x,y,width,height,cursor_x,cursor_y,active,command,title,in_mode,copy_x,copy_y,window_id,border_title,alternate_on,mouse_any_flag`
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
        let title = parts[10].to_string();
        let in_mode = parts.get(11).map(|s| *s == "1").unwrap_or(false);
        let copy_cursor_x: u32 = parts.get(12).and_then(|s| s.parse().ok()).unwrap_or(0);
        let copy_cursor_y: u32 = parts.get(13).and_then(|s| s.parse().ok()).unwrap_or(0);
        let window_id = parts.get(14).map(|s| s.to_string()).unwrap_or_default();

        // Parse remaining fields, handling border_title which may contain commas
        // Fields after window_id: border_title (may have commas), alternate_on, mouse_any_flag
        // We parse from the end to find the known fixed fields
        let remaining_parts = if parts.len() > 15 { &parts[15..] } else { &[] };

        // The last four fields should be alternate_on, mouse_any_flag, group_id, group_tab_index
        // Parse from the end to find the known fixed fields
        let (border_title, alternate_on, mouse_any_flag, group_id, group_tab_index) = if remaining_parts.len() >= 4 {
            let last_idx = remaining_parts.len() - 1;
            let group_tab_idx_str = remaining_parts[last_idx];
            let group_id_str = remaining_parts[last_idx - 1];
            let mouse_flag = remaining_parts[last_idx - 2] == "1";
            let alt_on = remaining_parts[last_idx - 3] == "1";
            // Everything before the last four fields is border_title
            let title_parts = if remaining_parts.len() > 4 {
                remaining_parts[..remaining_parts.len() - 4].join(",")
            } else {
                String::new()
            };
            let gid = if group_id_str.is_empty() { None } else { Some(group_id_str.to_string()) };
            let gtab = group_tab_idx_str.parse::<u32>().ok();
            (title_parts, alt_on, mouse_flag, gid, gtab)
        } else if remaining_parts.len() >= 2 {
            // Fallback: old format with just alternate_on and mouse_any_flag
            let last_idx = remaining_parts.len() - 1;
            let mouse_flag = remaining_parts[last_idx] == "1";
            let alt_on = remaining_parts[last_idx - 1] == "1";
            let title_parts = if remaining_parts.len() > 2 {
                remaining_parts[..remaining_parts.len() - 2].join(",")
            } else {
                String::new()
            };
            (title_parts, alt_on, mouse_flag, None, None)
        } else if remaining_parts.len() == 1 {
            (remaining_parts[0].to_string(), false, false, None, None)
        } else {
            (String::new(), false, false, None, None)
        };

        let pane_id_string = pane_id.to_string();

        // Check if this is a new pane
        let is_new_pane = !self.panes.contains_key(&pane_id_string);

        let pane = self
            .panes
            .entry(pane_id_string.clone())
            .or_insert_with(|| PaneState::new(pane_id, width, height));

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
        pane.window_id = window_id;
        pane.alternate_on = alternate_on;
        pane.mouse_any_flag = mouse_any_flag;
        pane.group_id = group_id;
        pane.group_tab_index = group_tab_index;

        // Store tmux's authoritative cursor position
        pane.tmux_cursor_x = cursor_x;
        pane.tmux_cursor_y = cursor_y;

        // Need to capture if pane is new or was resized
        let needs_capture = is_new_pane || was_resized;
        Some((pane_id_string, needs_capture))
    }

    /// Parse a line from list-windows output.
    /// Expected format: `@window_id,window_index,name,active,float_parent,float_width,float_height`
    fn parse_list_windows_line(&mut self, line: &str) {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 4 {
            return;
        }

        let window_id = parts[0].trim();
        if !window_id.starts_with('@') {
            return;
        }

        let index: u32 = parts[1].parse().unwrap_or(0);
        let name = parts[2].to_string();
        let active = parts[3] == "1";

        // Parse float window options (may be empty)
        let float_parent = parts.get(4)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let float_width = parts.get(5)
            .and_then(|s| s.parse::<u32>().ok());
        let float_height = parts.get(6)
            .and_then(|s| s.parse::<u32>().ok());

        let window = self
            .windows
            .entry(window_id.to_string())
            .or_insert_with(|| WindowState::new(window_id));

        window.index = index;
        window.name = name;
        window.active = active;
        window.float_parent = float_parent;
        window.float_width = float_width;
        window.float_height = float_height;

        if active {
            self.active_window_id = Some(window_id.to_string());
        }
    }

    /// Convert current state to a StateUpdate (full or delta) for efficient transmission.
    /// Returns Full state on first call or when too many changes occurred.
    /// Returns Delta with only changed fields on subsequent calls.
    /// Returns None when nothing has changed (empty delta).
    pub fn to_state_update(&mut self) -> Option<crate::StateUpdate> {
        let current = self.to_tmux_state();

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
        let curr_panes: std::collections::HashMap<&str, &crate::TmuxPane> =
            current.panes.iter().map(|p| (p.tmux_id.as_str(), p)).collect();

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

        // Check for popup changes
        match (&current.popup, &prev.popup) {
            (Some(curr_popup), None) => {
                // Popup opened - send full popup state
                delta.popup = Some(Some(curr_popup.clone()));
            }
            (None, Some(_)) => {
                // Popup closed
                delta.popup = Some(None);
            }
            (Some(curr_popup), Some(prev_popup)) => {
                // Popup exists in both - check for changes
                // For simplicity, send full popup if anything changed
                if curr_popup.id != prev_popup.id
                    || curr_popup.content != prev_popup.content
                    || curr_popup.cursor_x != prev_popup.cursor_x
                    || curr_popup.cursor_y != prev_popup.cursor_y
                    || curr_popup.width != prev_popup.width
                    || curr_popup.height != prev_popup.height
                    || curr_popup.x != prev_popup.x
                    || curr_popup.y != prev_popup.y
                    || curr_popup.active != prev_popup.active
                    || curr_popup.command != prev_popup.command
                {
                    delta.popup = Some(Some(curr_popup.clone()));
                }
            }
            (None, None) => {
                // No popup change
            }
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
    fn compute_pane_delta(&self, prev: &crate::TmuxPane, curr: &crate::TmuxPane) -> crate::PaneDelta {
        let mut delta = crate::PaneDelta::default();

        if prev.window_id != curr.window_id {
            delta.window_id = Some(curr.window_id.clone());
        }
        if prev.content != curr.content {
            delta.content = Some(curr.content.clone());
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
        if prev.group_id != curr.group_id {
            delta.group_id = Some(curr.group_id.clone());
        }
        if prev.group_tab_index != curr.group_tab_index {
            delta.group_tab_index = Some(curr.group_tab_index);
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
        if prev.is_pane_group_window != curr.is_pane_group_window {
            delta.is_pane_group_window = Some(curr.is_pane_group_window);
        }
        if prev.pane_group_parent_pane != curr.pane_group_parent_pane {
            delta.pane_group_parent_pane = Some(curr.pane_group_parent_pane.clone());
        }
        if prev.pane_group_index != curr.pane_group_index {
            delta.pane_group_index = Some(curr.pane_group_index);
        }
        if prev.is_float_window != curr.is_float_window {
            delta.is_float_window = Some(curr.is_float_window);
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

        delta
    }

    /// Reset delta tracking (force full state on next call)
    pub fn reset_delta_tracking(&mut self) {
        self.prev_state = None;
        self.delta_seq = 0;
    }

    /// Convert current state to TmuxState for the frontend.
    pub fn to_tmux_state(&mut self) -> TmuxState {
        // Get panes for the active window AND group windows
        // Group windows are hidden windows that contain grouped panes
        let active_window = self.active_window_id.as_ref();

        // Build set of pane group window IDs.
        // Include all pane group windows unconditionally: after swap-pane, the parent
        // pane may be in the group window itself (not the active window).
        let valid_pane_group_windows: std::collections::HashSet<String> = self
            .windows
            .values()
            .filter_map(|w| {
                if parse_pane_group_window_name(&w.name).is_some() {
                    Some(w.id.clone())
                } else {
                    None
                }
            })
            .collect();

        // Float windows are always included (they contain floating panes)
        let float_windows: std::collections::HashSet<String> = self
            .windows
            .values()
            .filter_map(|w| {
                if is_float_window_name(&w.name) {
                    Some(w.id.clone())
                } else {
                    None
                }
            })
            .collect();

        let panes: Vec<TmuxPane> = self
            .panes
            .values()
            .filter(|p| {
                // Only include panes that belong to a window we know about
                if p.window_id.is_empty() {
                    return false;
                }
                // Include panes from active window, valid pane group windows, OR float windows
                let is_active_window = active_window
                    .map(|w| p.window_id == *w)
                    .unwrap_or(false);
                let is_valid_pane_group_window = valid_pane_group_windows.contains(&p.window_id);
                let is_float_window = float_windows.contains(&p.window_id);
                is_active_window || is_valid_pane_group_window || is_float_window
            })
            .map(|p| p.to_tmux_pane())
            .collect();

        let windows: Vec<TmuxWindow> = self
            .windows
            .values()
            .map(|w| w.to_tmux_window())
            .collect();

        // Calculate total dimensions
        let total_width = panes
            .iter()
            .map(|p| p.x + p.width)
            .max()
            .unwrap_or(80);
        let total_height = panes
            .iter()
            .map(|p| p.y + p.height)
            .max()
            .unwrap_or(24);

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
            popup: self.popup.as_ref().map(|p| p.to_tmux_popup()),
        }
    }

    /// Get a reference to a pane by ID.
    pub fn get_pane(&self, pane_id: &str) -> Option<&PaneState> {
        self.panes.get(pane_id)
    }

    /// Get a mutable reference to a pane by ID.
    pub fn get_pane_mut(&mut self, pane_id: &str) -> Option<&mut PaneState> {
        self.panes.get_mut(pane_id)
    }

    /// Set default dimensions for new panes.
    pub fn set_default_dimensions(&mut self, width: u32, height: u32) {
        self.default_width = width;
        self.default_height = height;
    }

    /// Clear all state (for reconnection).
    pub fn clear(&mut self) {
        self.panes.clear();
        self.windows.clear();
        self.active_window_id = None;
        self.pending_captures.clear();
        self.cached_status_line.clear();
        self.status_line_dirty = true;
        self.popup = None;
    }

    /// Check if a popup is currently active
    pub fn has_popup(&self) -> bool {
        self.popup.is_some()
    }

    /// Get the current popup state
    pub fn get_popup(&self) -> Option<&PopupState> {
        self.popup.as_ref()
    }
}

impl Default for StateAggregator {
    fn default() -> Self {
        Self::new()
    }
}
