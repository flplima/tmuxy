use super::*;
use crate::PaneId;

impl StateAggregator {
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
                let prev_panes: HashMap<&PaneId, &crate::TmuxPane> =
                    prev.panes.iter().map(|p| (&p.tmux_id, p)).collect();
                for pane in &mut current.panes {
                    if self.pending_captures.contains(&pane.tmux_id) {
                        // Don't preserve prev_state for panes that moved windows.
                        // Their prev_state has stale content from the old window;
                        // better to show the current (empty/reset) VT100 content
                        // until the authoritative capture-pane response arrives.
                        if self.panes_moved_window.contains(&pane.tmux_id) {
                            continue;
                        }
                        if let Some(prev_pane) = prev_panes.get(&pane.tmux_id) {
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
                self.delta_seq = 1;
                current.seq = 1;
                self.prev_state = Some(current.clone());
                return Some(crate::StateUpdate::Full { state: current });
            }
            Some(prev) => prev,
        };

        // Compute delta (seq assigned after empty check)
        let mut delta = crate::TmuxDelta::default();

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

        // A queued focus request, or its clearing. The empty string is the
        // "cleared" signal — `None` on the delta means "unchanged", so the
        // absence of the option cannot be expressed by `None`.
        if current.focus_request != prev.focus_request {
            delta.focus_request = Some(current.focus_request.clone().unwrap_or_default());
        }

        // Build maps for efficient lookup
        let prev_panes: HashMap<&PaneId, &crate::TmuxPane> =
            prev.panes.iter().map(|p| (&p.tmux_id, p)).collect();
        let curr_panes: HashMap<&PaneId, &crate::TmuxPane> =
            current.panes.iter().map(|p| (&p.tmux_id, p)).collect();

        let prev_windows: HashMap<&WindowId, &crate::TmuxWindow> =
            prev.windows.iter().map(|w| (&w.id, w)).collect();
        let curr_windows: HashMap<&WindowId, &crate::TmuxWindow> =
            current.windows.iter().map(|w| (&w.id, w)).collect();

        // Track pane changes
        let mut pane_deltas: HashMap<PaneId, Option<crate::PaneDelta>> = HashMap::new();
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
                        pane_deltas.insert((*id).clone(), Some(pane_delta));
                    }
                }
            }
        }

        // Find removed panes
        for id in prev_panes.keys() {
            if !curr_panes.contains_key(id) {
                pane_deltas.insert((*id).clone(), None); // None = removed
            }
        }

        // Track window changes
        let mut window_deltas: HashMap<WindowId, Option<crate::WindowDelta>> = HashMap::new();
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
                        window_deltas.insert((*id).clone(), Some(window_delta));
                    }
                }
            }
        }

        // Find removed windows
        for id in prev_windows.keys() {
            if !curr_windows.contains_key(id) {
                window_deltas.insert((*id).clone(), None);
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

        // Has real changes — assign seq, update prev_state. The full state
        // sent in the delta's place below carries the same number.
        self.delta_seq += 1;
        delta.seq = self.delta_seq;
        current.seq = self.delta_seq;
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
    pub(super) fn compute_pane_delta(
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
        if prev.group_pos != curr.group_pos {
            delta.group_pos = Some(curr.group_pos);
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
        if prev.pane_state != curr.pane_state {
            delta.pane_state = Some(curr.pane_state.clone());
        }
        if prev.pane_ask != curr.pane_ask {
            delta.pane_ask = Some(curr.pane_ask.clone());
        }
        if prev.pane_widget != curr.pane_widget {
            delta.pane_widget = Some(curr.pane_widget.clone());
        }
        if prev.pane_restore != curr.pane_restore {
            delta.pane_restore = Some(curr.pane_restore.clone());
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
    pub(super) fn compute_window_delta(
        &self,
        prev: &crate::TmuxWindow,
        curr: &crate::TmuxWindow,
    ) -> crate::WindowDelta {
        let mut delta = crate::WindowDelta::default();

        if prev.index != curr.index {
            delta.index = Some(curr.index);
        }
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
        if prev.collapsible != curr.collapsible {
            delta.collapsible = Some(curr.collapsible);
        }
        if prev.zoomed != curr.zoomed {
            delta.zoomed = Some(curr.zoomed);
        }
        if prev.active_pane_id != curr.active_pane_id {
            delta.active_pane_id = Some(curr.active_pane_id.clone());
        }
        if prev.pane_tree != curr.pane_tree {
            delta.pane_tree = Some(curr.pane_tree.clone());
        }

        delta
    }
}
