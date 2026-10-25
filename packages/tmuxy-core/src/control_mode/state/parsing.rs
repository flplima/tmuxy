use super::*;
use crate::constants::tmux_formats::{unescape_commas, PaneColumn};
use crate::{GroupId, PaneId, WindowId, WindowType};

impl StateAggregator {
    /// Parse a line from list-panes output: one field per [`PaneColumn`], in
    /// that order, free-text fields comma-escaped by the format itself.
    /// Returns (pane_id, needs_capture) if successfully parsed.
    /// needs_capture is true if pane is new OR was resized.
    pub(super) fn parse_list_panes_line(&mut self, line: &str) -> Option<(PaneId, bool)> {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() != PaneColumn::COUNT {
            debug!(
                fields = parts.len(),
                expected = PaneColumn::COUNT,
                row = line,
                "a list-panes row with the wrong number of fields is dropped"
            );
            return None;
        }
        let field = |column: PaneColumn| parts[column.index()].trim();
        let number = |column: PaneColumn| field(column).parse::<u32>().unwrap_or(0);
        let flag = |column: PaneColumn| field(column) == "1";
        let option = |column: PaneColumn| {
            let value = field(column);
            (!value.is_empty()).then(|| value.to_string())
        };
        // The two titles keep their spacing: a border format that expands to
        // a space is a space, as it was drawn.
        let text = |column: PaneColumn| unescape_commas(parts[column.index()]);

        let pane_id = PaneId::parse(field(PaneColumn::PaneId)).ok()?;
        let width = field(PaneColumn::Width).parse().unwrap_or(80);
        let height = field(PaneColumn::Height).parse().unwrap_or(24);
        let active = flag(PaneColumn::Active);
        let command = normalize_pane_command(&unescape_commas(field(PaneColumn::Command)));
        let title = text(PaneColumn::Title);
        let in_mode = flag(PaneColumn::CopyMode);
        let window_id = WindowId::parse(field(PaneColumn::WindowId)).ok();
        let restore = unescape_commas(field(PaneColumn::Restore));

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
        pane.title = if is_graphics_payload(&title) {
            String::new()
        } else {
            title
        };
        pane.border_title = text(PaneColumn::BorderTitle);
        let was_in_mode = pane.in_mode;
        pane.in_mode = in_mode;
        if was_in_mode && !in_mode {
            pane.copy_mode_content = None;
        }
        pane.copy_cursor_x = number(PaneColumn::CopyCursorX);
        pane.copy_cursor_y = number(PaneColumn::CopyCursorY);
        pane.scroll_position = number(PaneColumn::ScrollPosition);
        pane.window_id = window_id;
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
        pane.alternate_on = flag(PaneColumn::AlternateOn);
        pane.mouse_any_flag = flag(PaneColumn::MouseAnyFlag);
        pane.marked = flag(PaneColumn::Marked);
        pane.selection_present = flag(PaneColumn::SelectionPresent);
        pane.selection_start_x = number(PaneColumn::SelectionStartX);
        pane.selection_start_y = field(PaneColumn::SelectionStartY).parse().unwrap_or(0);
        pane.history_size = field(PaneColumn::HistorySize).parse().unwrap_or(0);
        pane.group_id = GroupId::parse(field(PaneColumn::GroupId)).ok();
        pane.group_pos = field(PaneColumn::GroupPos).parse().ok();
        pane.pane_state = option(PaneColumn::PaneState);
        pane.pane_ask = option(PaneColumn::Ask);
        pane.pane_widget = option(PaneColumn::Widget);
        pane.pane_restore = (!restore.is_empty()).then_some(restore);

        // Store tmux's authoritative cursor position
        pane.tmux_cursor_x = number(PaneColumn::CursorX);
        pane.tmux_cursor_y = number(PaneColumn::CursorY);

        // Need to capture if pane is new, was resized, or just exited copy mode
        // (exiting copy mode requires re-syncing the vt100 terminal with tmux's actual content,
        // since %output events during copy mode may have desynchronized it)
        let exited_copy_mode = was_in_mode && !in_mode;
        let needs_capture = is_new_pane || was_resized || exited_copy_mode;
        Some((pane_id, needs_capture))
    }

    /// Parse a line from list-windows output. Expected format (comma-separated,
    /// see constants::LIST_WINDOWS_CMD):
    /// `@id,index,active,window_type,float_parent,float_width,float_height,float_drawer,float_bg,float_noheader,focus_request,sidebar_cols,sidebar_hidden,collapsible,zoomed,sidebar_rows,name`
    /// `window_name` is LAST and free text — we `splitn` so its own commas stay
    /// in the trailing field and can't shift any parsed column. Every column
    /// after `active` is a `@tmuxy-*` user option that may be empty.
    pub(super) fn parse_list_windows_line(&mut self, line: &str) {
        // 17 fields; splitn keeps window_name (the 17th) intact even with commas.
        // The name is always the LAST field, so a row from a format that
        // predates the trailing option columns still parses.
        let parts: Vec<&str> = line.splitn(17, ',').collect();
        if parts.len() < 15 {
            return;
        }

        let Ok(window_id) = WindowId::parse(parts[0].trim()) else {
            return;
        };

        let index: u32 = parts[1].parse().unwrap_or(0);
        let active = parts[2] == "1";
        let name = parts.last().map(|s| s.to_string()).unwrap_or_default();

        let opt = |idx: usize| -> Option<String> {
            parts
                .get(idx)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        };

        let window_type = opt(3).and_then(|s| WindowType::parse(&s));
        let float_parent = opt(4).and_then(|s| WindowId::parse(&s).ok());
        let float_width = opt(5).and_then(|s| s.parse::<u32>().ok());
        let float_height = opt(6).and_then(|s| s.parse::<u32>().ok());
        let float_drawer = opt(7);
        let float_bg = opt(8);
        let float_noheader = opt(9).is_some_and(|s| s == "1");
        // Session-scoped, so every row carries the same value and the last one
        // parsed wins. Read from this poll rather than its own `show-options`
        // because the poll already runs; see `tmux_options::FOCUS_REQUEST`.
        self.focus_request = opt(10);
        // A sidebar column the user has dragged off its default width.
        let sidebar_cols = opt(11).and_then(|s| s.parse::<u32>().ok());
        // A sidebar column the user has closed (its pane is kept alive).
        let sidebar_hidden = opt(12).is_some_and(|s| s == "1");
        // Collapsible panes (see `layout.rs`): the flag turning off evens the
        // first-level rows back out.
        let collapsible = opt(13).is_some_and(|s| s == "1");
        // Authoritative zoom state. Deriving it only from `%layout-change`
        // flags loses it whenever window state is rebuilt from list-windows —
        // e.g. every fresh client connect, which is exactly when a client
        // attaching to an already-zoomed window needs it.
        let zoomed = opt(14).is_some_and(|s| s == "1");
        // The dock's own row count (see `tmux_options::SIDEBAR_ROWS`); only a
        // 17-field row carries it — in a shorter row field 15 is the name.
        let sidebar_rows = if parts.len() >= 17 {
            opt(15).and_then(|s| s.parse::<u32>().ok())
        } else {
            None
        };

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
            self.active_window_id = Some(window_id);
        }
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
