use super::*;
use crate::PaneId;

impl StateAggregator {
    /// Convert current state to a StateUpdate (full or delta) for efficient transmission.
    /// Returns Full state on first call or when too many changes occurred.
    /// Returns Delta with only changed fields on subsequent calls.
    /// Returns None when nothing has changed (empty delta).
    pub fn to_state_update(&mut self) -> Option<crate::StateUpdate> {
        let mut current = self.to_tmux_state();
        // First state or no previous state - send full. Not before the
        // initial sync has landed: every unmarked ack of `sync_initial_state`
        // (`set window-size manual` first) reports a Full change, and a Full
        // emitted then has no panes, no windows and no content — a client
        // reconnecting to a restarted monitor saw its page blanked by it
        // until the deltas and captures arrived. The stream opens with the
        // same complete picture `GetState` waits for.
        let prev = match &self.prev_state {
            None if !self.initial_state_ready() => return None,
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
        if current.plugins_rev != prev.plugins_rev {
            delta.plugins_rev = Some(current.plugins_rev.clone().unwrap_or_default());
        }
        if current.theme_rev != prev.theme_rev {
            delta.theme_rev = Some(current.theme_rev.clone().unwrap_or_default());
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
                    let pane_delta = pane_delta(prev_pane, curr_pane);
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
                    let window_delta = window_delta(prev_window, curr_window);
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
}

/// Every listed field that differs between `prev` and `curr`, set on
/// `delta` as `Some` of the current value: the one shape of a field diff.
macro_rules! changed_fields {
    ($delta:ident, $prev:ident, $curr:ident; $($field:ident),+ $(,)?) => {
        $(
            if $prev.$field != $curr.$field {
                $delta.$field = Some(Clone::clone(&$curr.$field));
            }
        )+
    };
}

/// Delta between two snapshots of a pane.
pub(super) fn pane_delta(prev: &crate::TmuxPane, curr: &crate::TmuxPane) -> crate::PaneDelta {
    let mut delta = crate::PaneDelta::default();
    // Line-level content diff: only include changed lines. Panes whose
    // content is untouched share the same Arc between prev and curr
    // snapshots, so `ptr_eq` skips the per-line walk entirely.
    if !std::sync::Arc::ptr_eq(&prev.content, &curr.content) {
        let max_lines = curr.content.len().max(prev.content.len());
        let changed_lines: HashMap<usize, crate::TerminalLine> = (0..max_lines)
            .filter(|&i| prev.content.get(i) != curr.content.get(i))
            .map(|i| (i, curr.content.get(i).cloned().unwrap_or_default()))
            .collect();
        if !changed_lines.is_empty() {
            delta.content = Some(changed_lines);
        }
    }
    // `group_id` is an `Option` of its own: `Some(None)` clears it (the pane
    // left a group), and `skip_serializing_if` on the outer Option keeps
    // unchanged panes off the wire.
    changed_fields!(delta, prev, curr;
        window_id, cursor_x, cursor_y, width, height, x, y, active, command, title,
        border_title, group_pos, group_id, in_mode, copy_cursor_x, copy_cursor_y,
        alternate_on, mouse_any_flag, marked, history_size, pane_state, pane_ask,
        pane_widget, pane_restore, selection_present, selection_start_x,
        selection_start_y, images, cursor_shape, cursor_hidden,
    );
    delta
}

/// Delta between two snapshots of a window.
pub(super) fn window_delta(
    prev: &crate::TmuxWindow,
    curr: &crate::TmuxWindow,
) -> crate::WindowDelta {
    let mut delta = crate::WindowDelta::default();
    changed_fields!(delta, prev, curr;
        index, name, active, window_type, float_parent, float_width, float_height,
        float_drawer, float_bg, float_noheader, sidebar_cols, sidebar_hidden,
        collapsible, zoomed, active_pane_id, pane_tree,
    );
    delta
}
