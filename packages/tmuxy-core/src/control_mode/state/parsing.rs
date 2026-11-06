use super::*;
use crate::constants::tmux_formats::{Column, PaneColumn, Row, WindowColumn};
use crate::{GroupId, PaneId, WindowId, WindowType};

impl StateAggregator {
    /// Parse a line from list-panes output: one field per [`PaneColumn`], in
    /// that order, free-text fields comma-escaped by the format itself.
    /// Returns (pane_id, needs_capture) if successfully parsed.
    /// needs_capture is true if pane is new OR was resized.
    pub(super) fn parse_list_panes_line(&mut self, line: &str) -> Option<(PaneId, bool)> {
        let Some(row) = Row::<PaneColumn>::parse(line) else {
            debug!(
                expected = PaneColumn::ALL.len(),
                row = line,
                "a list-panes row with the wrong number of fields is dropped"
            );
            return None;
        };
        let number = |column: PaneColumn| row.parse_field::<u32>(column).unwrap_or(0);

        let pane_id = PaneId::parse(row.field(PaneColumn::PaneId)).ok()?;
        let (Some(width), Some(height)) = (
            row.parse_field(PaneColumn::Width),
            row.parse_field(PaneColumn::Height),
        ) else {
            debug!(row = line, "a list-panes row without a size is dropped");
            return None;
        };
        let active = row.flag(PaneColumn::Active);
        let command = normalize_pane_command(row.text(PaneColumn::Command).trim());
        let mode = number(PaneColumn::Mode);
        let in_mode = mode == 1;
        let view_mode = mode == 2;
        let window_id = WindowId::parse(row.field(PaneColumn::WindowId)).ok();
        let restore = row.text(PaneColumn::Restore).trim().to_string();

        // Check if this is a new pane
        let is_new_pane = !self.panes.contains_key(&pane_id);
        let pane = self
            .panes
            .entry(pane_id.clone())
            .or_insert_with(|| PaneState::new(pane_id.clone(), width, height));

        if is_new_pane {
            let early_bytes = pane.replay_early_output(&mut self.early_output);
            debug!(
                pane = %pane_id,
                window = ?window_id,
                cols = width,
                rows = height,
                shell = crate::constants::is_shell_name(&command),
                bytes = early_bytes,
                "pane appeared"
            );
        }

        pane.index = number(PaneColumn::PaneIndex);
        pane.x = number(PaneColumn::Left);
        pane.y = number(PaneColumn::Top);
        let was_resized = pane.resize(width, height);
        if was_resized && !is_new_pane {
            debug!(pane = %pane_id, cols = width, rows = height, "pane resized");
        }
        pane.active = active;
        pane.command = command;
        pane.set_title(row.text(PaneColumn::Title));
        pane.border_title = row.text(PaneColumn::BorderTitle);
        let was_in_mode = pane.in_mode;
        pane.in_mode = in_mode;
        if was_in_mode && !in_mode {
            pane.copy_mode_content = None;
        }
        // A view mode nobody draws: tmux opens one on the current pane for
        // whatever a `run-shell -b` prints, on every version. Every key then
        // goes to the pager, and `:` opens a prompt on this client that
        // stalls tmux. It is closed once it is known who is looking
        // (`on_clients_listed`).
        if view_mode && !pane.view_mode {
            self.view_mode_opened.push(pane_id.clone());
        }
        pane.view_mode = view_mode;
        pane.copy_cursor_x = number(PaneColumn::CopyCursorX);
        pane.copy_cursor_y = number(PaneColumn::CopyCursorY);
        pane.scroll_position = number(PaneColumn::ScrollPosition);
        // A row can report a pane's move (break-pane, swap-pane) before the
        // layout of its new window does: the same reset and capture as there.
        let moved_window = match window_id {
            Some(window) if pane.window_id.is_some() && !pane.in_window(&window) => {
                pane.move_to_window(window);
                self.panes_moved_window.insert(pane_id.clone());
                true
            }
            other => {
                pane.window_id = other;
                false
            }
        };
        // `#{pane_active}` is per window: it names each window's own active
        // pane, which %window-pane-changed only reports for later changes.
        if active {
            if let Some(w) = pane
                .window_id
                .as_ref()
                .and_then(|w| self.windows.get_mut(w))
            {
                w.active_pane_id = Some(pane.id.clone());
            }
        }
        pane.alternate_on = row.flag(PaneColumn::AlternateOn);
        pane.mouse_any_flag = row.flag(PaneColumn::MouseAnyFlag);
        pane.marked = row.flag(PaneColumn::Marked);
        pane.selection_present = row.flag(PaneColumn::SelectionPresent);
        pane.selection_start_x = number(PaneColumn::SelectionStartX);
        pane.selection_start_y = row.parse_field(PaneColumn::SelectionStartY).unwrap_or(0);
        pane.history_size = row.parse_field(PaneColumn::HistorySize).unwrap_or(0);
        pane.group_id = GroupId::parse(row.field(PaneColumn::GroupId)).ok();
        pane.group_pos = row.parse_field(PaneColumn::GroupPos);
        pane.pane_state = row.option(PaneColumn::PaneState);
        pane.pane_ask = row.option(PaneColumn::Ask);
        pane.pane_widget = row.option(PaneColumn::Widget);
        pane.pane_restore = (!restore.is_empty()).then_some(restore);
        // Global, so every row carries the same value; the last one parsed
        // wins, as `focus_request` does for the window rows.
        self.plugins_rev = row.option(PaneColumn::PluginsRev);

        // Store tmux's authoritative cursor position
        pane.tmux_cursor_x = number(PaneColumn::CursorX);
        pane.tmux_cursor_y = number(PaneColumn::CursorY);

        // Need to capture if pane is new, was resized, or just exited copy mode
        // (exiting copy mode requires re-syncing the vt100 terminal with tmux's actual content,
        // since %output events during copy mode may have desynchronized it)
        let exited_copy_mode = was_in_mode && !in_mode;
        let needs_capture = is_new_pane || was_resized || exited_copy_mode || moved_window;
        Some((pane_id, needs_capture))
    }

    /// Parse a line from list-windows output: one field per
    /// [`WindowColumn`], the name comma-escaped. Returns the window's id.
    pub(super) fn parse_list_windows_line(&mut self, line: &str) -> Option<WindowId> {
        let row = Row::<WindowColumn>::parse(line)?;
        let window_id = WindowId::parse(row.field(WindowColumn::WindowId)).ok()?;
        let index: u32 = row.parse_field(WindowColumn::Index).unwrap_or(0);
        let active = row.flag(WindowColumn::Active);
        let name = row.text(WindowColumn::Name);
        let window_type = row
            .option(WindowColumn::WindowType)
            .and_then(|s| WindowType::parse(&s));
        let float_parent = WindowId::parse(row.field(WindowColumn::FloatParent)).ok();
        let float_width = row.parse_field(WindowColumn::FloatWidth);
        let float_height = row.parse_field(WindowColumn::FloatHeight);
        let float_drawer = row.option(WindowColumn::FloatDrawer);
        let float_bg = row.option(WindowColumn::FloatBg);
        let float_noheader = row.flag(WindowColumn::FloatNoheader);
        // Session-scoped, so every row carries the same value and the last one
        // parsed wins. Read from this poll rather than its own `show-options`
        // because the poll already runs; see `tmux_options::FOCUS_REQUEST`.
        self.focus_request = row.option(WindowColumn::FocusRequest);
        // A sidebar column the user has dragged off its default width.
        let sidebar_cols = row.parse_field(WindowColumn::SidebarCols);
        // A sidebar column the user has closed (its pane is kept alive).
        let sidebar_hidden = row.flag(WindowColumn::SidebarHidden);
        // Collapsible panes (see `layout.rs`): the flag turning off evens the
        // first-level rows back out.
        let collapsible = row.flag(WindowColumn::Collapsible);
        // Authoritative zoom state. Deriving it only from `%layout-change`
        // flags loses it whenever window state is rebuilt from list-windows —
        // e.g. every fresh client connect, which is exactly when a client
        // attaching to an already-zoomed window needs it.
        let zoomed = row.flag(WindowColumn::Zoomed);
        // The dock's own row count (see `tmux_options::SIDEBAR_ROWS`).
        let sidebar_rows = row.parse_field(WindowColumn::SidebarRows);

        let window = self
            .windows
            .entry(window_id.clone())
            .or_insert_with(|| WindowState::new(window_id.clone(), index));

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
        window.sidebar_rows = sidebar_rows;
        if window.collapsible && !collapsible {
            self.even_out_pending.push(window_id.clone());
        }
        window.collapsible = collapsible;

        if active {
            self.active_window_id = Some(window_id.clone());
        }
        Some(window_id)
    }

    /// The `select-layout` commands that keep collapsible windows in shape:
    /// windows whose flag just dropped get their first-level rows evened out,
    /// and every collapsible tab keeps only the active pane's first-level row
    /// expanded (`layout::collapse_first_level`). Idempotent — a window already
    /// in shape yields nothing, so the %layout-change our own command causes
    /// does not echo another. Zoomed windows are left alone until they unzoom.
    pub(super) fn collapsible_layout_commands(
        &mut self,
        only_window: Option<&WindowId>,
    ) -> Vec<String> {
        let mut cmds = Vec::new();
        for wid in std::mem::take(&mut self.even_out_pending) {
            if let Some(w) = self.windows.get(&wid) {
                if let Some(layout) = crate::layout::even_first_level(&w.layout) {
                    cmds.push(format!("select-layout -t {wid} '{layout}'"));
                }
            }
        }
        for (wid, w) in &self.windows {
            if only_window.is_some_and(|o| o != wid) {
                continue;
            }
            if !w.collapsible || w.zoomed || w.window_type.is_some_and(|t| t != WindowType::Tab) {
                continue;
            }
            let active = self
                .panes
                .values()
                .find(|p| p.in_window(wid) && p.active)
                .map(|p| &p.id)
                .or(w.active_pane_id.as_ref());
            let Some(active) = active.map(PaneId::number) else {
                continue;
            };
            if let Some(layout) = crate::layout::collapse_first_level(&w.layout, active) {
                cmds.push(format!("select-layout -t {wid} '{layout}'"));
            }
        }
        cmds
    }
}
