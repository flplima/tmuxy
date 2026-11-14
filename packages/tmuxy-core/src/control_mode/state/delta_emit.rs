use super::*;
use crate::PaneId;

impl StateAggregator {
    /// The next update for the stream: `Full` first and whenever over half
    /// the panes changed, a `Delta` of the changed fields otherwise, `None`
    /// when nothing changed or the initial sync has not landed.
    pub fn to_state_update(&mut self) -> Option<crate::StateUpdate> {
        self.to_state_update_at(Instant::now())
    }

    /// When a pane held back by [`hidden_panes`] is due: the monitor asks
    /// for an update then, so its last frame is never left behind.
    pub fn hidden_panes_due(&self) -> Option<Instant> {
        self.hidden_panes.due()
    }

    /// The state a client joining now is handed (`GetState`): the
    /// aggregator's, with a pane held back by [`hidden_panes`] as the stream
    /// last sent it, since the stream's next delta is computed from that copy.
    /// Handed the newer screen, the client would keep any line of it that
    /// changed back before the delta went, which that delta does not carry.
    pub fn to_client_state(&mut self) -> crate::TmuxState {
        let mut state = self.to_tmux_state();
        if let Some(prev) = &self.prev_state {
            self.hidden_panes.restore_held(&mut state, prev);
        }
        state
    }

    /// [`Self::to_state_update`] at `now`, the clock hidden panes are held by.
    pub fn to_state_update_at(&mut self, now: Instant) -> Option<crate::StateUpdate> {
        let mut current = self.to_tmux_state();
        // A Full emitted before the initial sync has landed has no panes,
        // windows or content: a client reconnecting to a restarted monitor
        // saw its page blanked by it until the captures arrived. The stream
        // opens with the same complete picture `GetState` waits for.
        let prev = match self.prev_state.take() {
            None if !self.initial_state_ready() => return None,
            None => {
                self.delta_seq = 1;
                current.seq = 1;
                self.prev_state = Some(current.clone());
                return Some(crate::StateUpdate::Full { state: current });
            }
            Some(prev) => prev,
        };
        self.hidden_panes.start_update(&current.panes);

        let mut delta = crate::TmuxDelta::default();

        if current.total_width != prev.total_width {
            delta.total_width = Some(current.total_width);
        }
        if current.total_height != prev.total_height {
            delta.total_height = Some(current.total_height);
        }

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

        let prev_panes: HashMap<&PaneId, &crate::TmuxPane> =
            prev.panes.iter().map(|p| (&p.tmux_id, p)).collect();
        let curr_panes: HashMap<&PaneId, &crate::TmuxPane> =
            current.panes.iter().map(|p| (&p.tmux_id, p)).collect();

        let prev_windows: HashMap<&WindowId, &crate::TmuxWindow> =
            prev.windows.iter().map(|w| (&w.id, w)).collect();
        let curr_windows: HashMap<&WindowId, &crate::TmuxWindow> =
            current.windows.iter().map(|w| (&w.id, w)).collect();

        let mut pane_deltas: HashMap<PaneId, Option<crate::PaneDelta>> = HashMap::new();
        let mut new_panes: Vec<crate::TmuxPane> = Vec::new();

        for (id, curr_pane) in &curr_panes {
            match prev_panes.get(id) {
                None => {
                    new_panes.push((*curr_pane).clone());
                }
                Some(prev_pane) => {
                    let pane_delta = pane_delta(prev_pane, curr_pane);
                    if pane_delta.is_empty() {
                        continue;
                    }
                    let hidden = hidden_panes::is_hidden(&current, curr_pane);
                    if self.hidden_panes.send_now(id, hidden, &pane_delta, now) {
                        pane_deltas.insert((*id).clone(), Some(pane_delta));
                    }
                }
            }
        }

        for id in prev_panes.keys() {
            if !curr_panes.contains_key(id) {
                pane_deltas.insert((*id).clone(), None); // None: removed
            }
        }

        let mut window_deltas: HashMap<WindowId, Option<crate::WindowDelta>> = HashMap::new();
        let mut new_windows: Vec<crate::TmuxWindow> = Vec::new();

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

        for id in prev_windows.keys() {
            if !curr_windows.contains_key(id) {
                window_deltas.insert((*id).clone(), None);
            }
        }

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

        if delta.is_empty() {
            self.prev_state = Some(prev);
            return None;
        }

        // A Full sent in the delta's place carries the same number.
        self.delta_seq += 1;
        delta.seq = self.delta_seq;
        current.seq = self.delta_seq;

        let total_panes = current.panes.len();
        let changed_panes = delta.panes.as_ref().map(|p| p.len()).unwrap_or(0)
            + delta.new_panes.as_ref().map(|p| p.len()).unwrap_or(0);

        if total_panes > 0 && changed_panes > total_panes / 2 {
            // A Full carries every pane as it is, held ones too.
            self.hidden_panes = hidden_panes::HiddenPanes::default();
            self.prev_state = Some(current.clone());
            Some(crate::StateUpdate::Full { state: current })
        } else {
            // A held pane stays as the client last had it, so the delta that
            // carries it holds everything since.
            let mut sent = current;
            self.hidden_panes.restore_held(&mut sent, &prev);
            self.prev_state = Some(sent);
            Some(crate::StateUpdate::Delta { delta })
        }
    }
}

macro_rules! changed_fields {
    ($delta:ident, $prev:ident, $curr:ident; $($field:ident),+ $(,)?) => {
        $(
            if $prev.$field != $curr.$field {
                $delta.$field = Some(Clone::clone(&$curr.$field));
            }
        )+
    };
}

pub(super) fn pane_delta(prev: &crate::TmuxPane, curr: &crate::TmuxPane) -> crate::PaneDelta {
    let mut delta = crate::PaneDelta::default();
    // Untouched content shares one Arc between snapshots, so `ptr_eq`
    // skips the per-line walk.
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
