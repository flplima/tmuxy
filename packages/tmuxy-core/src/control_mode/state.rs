//! State aggregator for tmux control mode
//!
//! Aggregates control mode events into coherent state using vt100 terminal emulation.

use super::parser::ControlModeEvent;
use crate::{parse_stack_window_name, TmuxPane, TmuxState, TmuxWindow};
use std::collections::HashMap;

/// Result of processing a control mode event
#[derive(Debug, Default)]
pub struct ProcessEventResult {
    /// Whether state changed in a way that should trigger a UI update
    pub state_changed: bool,
    /// Pane IDs that need their content refreshed via capture-pane
    pub panes_needing_refresh: Vec<String>,
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

    /// In copy mode
    pub in_mode: bool,

    /// Copy mode cursor position
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,

    /// Tmux-reported cursor position (authoritative)
    pub tmux_cursor_x: u32,
    pub tmux_cursor_y: u32,
}

impl PaneState {
    pub fn new(id: &str, width: u32, height: u32) -> Self {
        Self {
            id: id.to_string(),
            index: 0,
            window_id: String::new(),
            terminal: vt100::Parser::new(height as u16, width as u16, 0),
            raw_buffer: Vec::new(),
            x: 0,
            y: 0,
            width,
            height,
            active: false,
            command: String::new(),
            in_mode: false,
            copy_cursor_x: 0,
            copy_cursor_y: 0,
            tmux_cursor_x: 0,
            tmux_cursor_y: 0,
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

        // Process through terminal emulator
        self.terminal.process(content);
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

    /// Get the rendered screen content as lines
    pub fn get_content(&self) -> Vec<String> {
        let screen = self.terminal.screen();
        let mut lines = Vec::with_capacity(self.height as usize);

        for row in 0..screen.size().0 {
            let mut line = String::new();

            for col in 0..screen.size().1 {
                let cell = screen.cell(row, col).unwrap();

                // Build ANSI escape sequence for this cell
                let mut has_style = false;
                let mut style = String::from("\x1b[");

                // Bold
                if cell.bold() {
                    style.push_str("1;");
                    has_style = true;
                }

                // Italic
                if cell.italic() {
                    style.push_str("3;");
                    has_style = true;
                }

                // Underline
                if cell.underline() {
                    style.push_str("4;");
                    has_style = true;
                }

                // Inverse/Reverse
                if cell.inverse() {
                    style.push_str("7;");
                    has_style = true;
                }

                // Foreground color
                match cell.fgcolor() {
                    vt100::Color::Default => {}
                    vt100::Color::Idx(idx) => {
                        style.push_str(&format!("38;5;{};", idx));
                        has_style = true;
                    }
                    vt100::Color::Rgb(r, g, b) => {
                        style.push_str(&format!("38;2;{};{};{};", r, g, b));
                        has_style = true;
                    }
                }

                // Background color
                match cell.bgcolor() {
                    vt100::Color::Default => {}
                    vt100::Color::Idx(idx) => {
                        style.push_str(&format!("48;5;{};", idx));
                        has_style = true;
                    }
                    vt100::Color::Rgb(r, g, b) => {
                        style.push_str(&format!("48;2;{};{};{};", r, g, b));
                        has_style = true;
                    }
                }

                if has_style {
                    // Remove trailing semicolon and close
                    style.pop();
                    style.push('m');
                    line.push_str(&style);
                }

                // Add the character
                line.push_str(&cell.contents());

                if has_style {
                    line.push_str("\x1b[0m");
                }
            }

            // Trim trailing whitespace but preserve content
            let trimmed = line.trim_end();
            lines.push(trimmed.to_string());
        }

        lines
    }

    /// Convert to TmuxPane struct
    pub fn to_tmux_pane(&self) -> TmuxPane {
        TmuxPane {
            id: self.index,
            tmux_id: self.id.clone(),
            window_id: self.window_id.clone(),
            content: self.get_content(),
            // Use tmux's authoritative cursor position instead of vt100 emulator
            cursor_x: self.tmux_cursor_x,
            cursor_y: self.tmux_cursor_y,
            width: self.width,
            height: self.height,
            x: self.x,
            y: self.y,
            active: self.active,
            command: self.command.clone(),
            in_mode: self.in_mode,
            copy_cursor_x: self.copy_cursor_x,
            copy_cursor_y: self.copy_cursor_y,
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
        }
    }

    pub fn to_tmux_window(&self) -> TmuxWindow {
        let stack_info = parse_stack_window_name(&self.name);
        TmuxWindow {
            id: self.id.clone(),
            index: self.index,
            name: self.name.clone(),
            active: self.active,
            is_stack_window: stack_info.is_some(),
            stack_parent_pane: stack_info.as_ref().map(|s| s.parent_pane_id.clone()),
            stack_index: stack_info.as_ref().map(|s| s.stack_index),
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

    /// Queue of pane IDs waiting for capture-pane responses.
    /// Uses FIFO order since tmux responses come back in order.
    pending_captures: std::collections::VecDeque<String>,
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
        }
    }

    /// Queue a pending capture-pane command.
    pub fn queue_capture(&mut self, pane_id: String) {
        self.pending_captures.push_back(pane_id);
    }

    /// Process a control mode event.
    /// Returns information about state changes and any panes that need content refresh.
    pub fn process_event(&mut self, event: ControlModeEvent) -> ProcessEventResult {
        match event {
            ControlModeEvent::Output { pane_id, content } => {
                ProcessEventResult {
                    state_changed: self.handle_output(&pane_id, &content),
                    panes_needing_refresh: Vec::new(),
                }
            }

            ControlModeEvent::ExtendedOutput {
                pane_id, content, ..
            } => ProcessEventResult {
                state_changed: self.handle_output(&pane_id, &content),
                panes_needing_refresh: Vec::new(),
            },

            ControlModeEvent::LayoutChange {
                window_id, layout, ..
            } => {
                let resized_panes = self.handle_layout_change(&window_id, &layout);
                ProcessEventResult {
                    state_changed: true,
                    panes_needing_refresh: resized_panes,
                }
            }

            ControlModeEvent::WindowAdd { window_id } => {
                self.windows
                    .entry(window_id.clone())
                    .or_insert_with(|| WindowState::new(&window_id));
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
                ProcessEventResult { state_changed: true, ..Default::default() }
            }

            ControlModeEvent::WindowRenamed { window_id, name } => {
                if let Some(window) = self.windows.get_mut(&window_id) {
                    window.name = name;
                }
                ProcessEventResult { state_changed: true, ..Default::default() }
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
                ProcessEventResult { state_changed: true, ..Default::default() }
            }

            ControlModeEvent::PaneModeChanged { pane_id: _ } => {
                // Don't toggle blindly - the list-panes periodic sync (every 500ms)
                // provides the authoritative in_mode state. Toggling here could cause
                // desync if events are duplicated or lost.
                // The next list-panes response will set the correct in_mode value.
                ProcessEventResult { state_changed: true, ..Default::default() }
            }

            ControlModeEvent::SessionWindowChanged { window_id, .. } => {
                // Update active window
                for (id, window) in self.windows.iter_mut() {
                    window.active = *id == window_id;
                }
                self.active_window_id = Some(window_id);
                ProcessEventResult { state_changed: true, ..Default::default() }
            }

            ControlModeEvent::CommandResponse { output, success, .. } => {
                // Check if this looks like a capture-pane response
                // capture-pane output is terminal content, not structured data
                let first_line = output.lines().next().unwrap_or("");
                let looks_like_list_panes = first_line.starts_with('%') && first_line.matches(',').count() >= 5;
                let looks_like_list_windows = first_line.starts_with('@') && first_line.contains(',');

                // If we have pending captures and this doesn't look like list-panes/list-windows,
                // treat it as a capture-pane response
                if !self.pending_captures.is_empty() && !looks_like_list_panes && !looks_like_list_windows {
                    if let Some(pane_id) = self.pending_captures.pop_front() {
                        if let Some(pane) = self.panes.get_mut(&pane_id) {
                            // capture-pane -p -e returns plain text with ANSI colors but no cursor positioning.
                            // We need to reset the terminal and process from the top.
                            pane.reset_and_process_capture(output.as_bytes());
                        }
                        return ProcessEventResult { state_changed: true, ..Default::default() };
                    }
                }

                // Parse list-panes/list-windows responses to update state
                let resized_panes = if success {
                    self.handle_command_response(&output)
                } else {
                    Vec::new()
                };
                ProcessEventResult {
                    state_changed: true,
                    panes_needing_refresh: resized_panes,
                }
            }

            ControlModeEvent::SessionsChanged => {
                ProcessEventResult { state_changed: true, ..Default::default() }
            }
            ControlModeEvent::SessionChanged { session_name, .. } => {
                self.session_name = session_name;
                ProcessEventResult { state_changed: true, ..Default::default() }
            }
            ControlModeEvent::SessionRenamed { name, .. } => {
                self.session_name = name;
                ProcessEventResult { state_changed: true, ..Default::default() }
            }
            ControlModeEvent::Exit { .. } => {
                ProcessEventResult { state_changed: true, ..Default::default() }
            }

            _ => ProcessEventResult::default(),
        }
    }

    fn handle_output(&mut self, pane_id: &str, content: &[u8]) -> bool {
        let pane = self.panes.entry(pane_id.to_string()).or_insert_with(|| {
            PaneState::new(pane_id, self.default_width, self.default_height)
        });
        pane.process_output(content);
        true
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
        for line in output.lines() {
            if line.contains('@') && line.contains(',') {
                self.parse_list_windows_line(line);
            }
        }

        resized_panes
    }

    /// Parse a line from list-panes output.
    /// Expected format: `%pane_id,pane_index,x,y,width,height,cursor_x,cursor_y,active,command,in_mode,copy_x,copy_y,window_id`
    /// Returns (pane_id, needs_capture) if successfully parsed.
    /// needs_capture is true if pane is new OR was resized.
    fn parse_list_panes_line(&mut self, line: &str) -> Option<(String, bool)> {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 10 {
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
        let in_mode = parts.get(10).map(|s| *s == "1").unwrap_or(false);
        let copy_cursor_x: u32 = parts.get(11).and_then(|s| s.parse().ok()).unwrap_or(0);
        let copy_cursor_y: u32 = parts.get(12).and_then(|s| s.parse().ok()).unwrap_or(0);
        let window_id = parts.get(13).map(|s| s.to_string()).unwrap_or_default();

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
        pane.in_mode = in_mode;
        pane.copy_cursor_x = copy_cursor_x;
        pane.copy_cursor_y = copy_cursor_y;
        pane.window_id = window_id;

        // Store tmux's authoritative cursor position
        pane.tmux_cursor_x = cursor_x;
        pane.tmux_cursor_y = cursor_y;

        // Need to capture if pane is new or was resized
        let needs_capture = is_new_pane || was_resized;
        Some((pane_id_string, needs_capture))
    }

    /// Parse a line from list-windows output.
    /// Expected format: `@window_id,window_index,name,active`
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

        let window = self
            .windows
            .entry(window_id.to_string())
            .or_insert_with(|| WindowState::new(window_id));

        window.index = index;
        window.name = name;
        window.active = active;

        if active {
            self.active_window_id = Some(window_id.to_string());
        }
    }

    /// Convert current state to TmuxState for the frontend.
    pub fn to_tmux_state(&self) -> TmuxState {
        // Get panes for the active window AND stack windows
        // Stack windows are hidden windows that contain stacked panes
        let active_window = self.active_window_id.as_ref();

        // Find all stack window IDs (windows whose names match the stack pattern)
        let stack_window_ids: std::collections::HashSet<String> = self
            .windows
            .values()
            .filter(|w| parse_stack_window_name(&w.name).is_some())
            .map(|w| w.id.clone())
            .collect();

        let panes: Vec<TmuxPane> = self
            .panes
            .values()
            .filter(|p| {
                // Only include panes that belong to a window we know about
                if p.window_id.is_empty() {
                    return false;
                }
                // Include panes from active window OR from stack windows
                let is_active_window = active_window
                    .map(|w| p.window_id == *w)
                    .unwrap_or(false);
                let is_stack_window = stack_window_ids.contains(&p.window_id);
                is_active_window || is_stack_window
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

        // Find the active pane ID
        let active_pane_id = panes
            .iter()
            .find(|p| p.active)
            .map(|p| p.tmux_id.clone());

        TmuxState {
            session_name: self.session_name.clone(),
            active_window_id: self.active_window_id.clone(),
            active_pane_id,
            panes,
            windows,
            total_width,
            total_height,
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
    }
}

impl Default for StateAggregator {
    fn default() -> Self {
        Self::new()
    }
}
