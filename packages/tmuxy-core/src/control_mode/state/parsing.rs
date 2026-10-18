use super::*;
use crate::{GroupId, PaneId, WindowId, WindowType};

impl StateAggregator {
    /// Parse a line from list-panes output.
    /// Expected format: `%pane_id,pane_index,x,y,width,height,cursor_x,cursor_y,active,command,title,in_mode,copy_x,copy_y,scroll_position,window_id,border_title,alternate_on,mouse_any_flag,selection_present,selection_start_x,selection_start_y,history_size`
    /// Returns (pane_id, needs_capture) if successfully parsed.
    /// needs_capture is true if pane is new OR was resized.
    pub(super) fn parse_list_panes_line(&mut self, line: &str) -> Option<(PaneId, bool)> {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 11 {
            return None;
        }

        let pane_id = PaneId::parse(parts[0].trim()).ok()?;

        let pane_index: u32 = parts[1].parse().unwrap_or(0);
        let x: u32 = parts[2].parse().unwrap_or(0);
        let y: u32 = parts[3].parse().unwrap_or(0);
        let width: u32 = parts[4].parse().unwrap_or(80);
        let height: u32 = parts[5].parse().unwrap_or(24);
        let cursor_x: u32 = parts[6].parse().unwrap_or(0);
        let cursor_y: u32 = parts[7].parse().unwrap_or(0);
        let active = parts[8] == "1";
        let command = normalize_pane_command(parts[9]);

        // The two free-text fields — pane_title (index 10) and border_title
        // (just after window_id) — can contain commas, which shift the
        // comma-split field positions. The structured fields around them are
        // not free-text, so locate the `window_id` anchor (`@<digits>`)
        // dynamically: it is immediately preceded by in_mode, copy_cursor_x,
        // copy_cursor_y, scroll_position. Everything between command and those
        // four fields is pane_title; everything between window_id and the fixed
        // 6-field tail is border_title.
        let num_tail_fields = 14;

        // Tail fields (fixed, never free-text): alternate_on, mouse_any_flag,
        // pane_marked, selection_present, selection_start_x, selection_start_y,
        // history_size, group_id (`@tmuxy-group-id`, `g<digits>` or empty),
        // group_pos (`@tmuxy-group-pos`, a number or empty),
        // pane_state (`@tmuxy-pane-state`, a bare word or empty), pane_ask
        // (`@tmuxy-ask`, base64 or empty), pane_widget (`@tmuxy-pane-widget`,
        // a widget name or empty) and pane_restore (`@tmuxy-pane-restore`, a
        // shell line or empty, its commas sent as `%2C` so it stays one
        // field) and pane_url (`@tmuxy-pane-url`, escaped the same way). The
        // free-text title/border fields in the middle can still hold commas:
        // everything here is counted from the end.
        let (
            alternate_on,
            mouse_any_flag,
            marked,
            selection_present,
            selection_start_x,
            selection_start_y,
            history_size,
            group_id,
            group_pos,
            pane_state,
            pane_ask,
            pane_widget,
            pane_restore,
            pane_url,
        ) = if parts.len() >= 25 {
            let last = parts.len() - 1;
            let url = parts[last].trim().replace("%2C", ",");
            let restore = parts[last - 1].trim().replace("%2C", ",");
            let widget = parts[last - 2].trim();
            let ask = parts[last - 3].trim();
            let state = parts[last - 4].trim();
            let pos = parts[last - 5].trim();
            let gid = parts[last - 6].trim();
            (
                parts[last - 13] == "1",
                parts[last - 12] == "1",
                parts[last - 11] == "1",
                parts[last - 10] == "1",
                parts[last - 9].parse::<u32>().unwrap_or(0),
                parts[last - 8].parse::<u64>().unwrap_or(0),
                parts[last - 7].parse::<u64>().unwrap_or(0),
                GroupId::parse(gid).ok(),
                pos.parse::<u32>().ok(),
                (!state.is_empty()).then(|| state.to_string()),
                (!ask.is_empty()).then(|| ask.to_string()),
                (!widget.is_empty()).then(|| widget.to_string()),
                (!restore.is_empty()).then_some(restore),
                (!url.is_empty()).then_some(url),
            )
        } else {
            (
                false, false, false, false, 0u32, 0u64, 0u64, None, None, None, None, None, None,
                None,
            )
        };

        let mut title = String::new();
        let mut in_mode = false;
        let mut copy_cursor_x: u32 = 0;
        let mut copy_cursor_y: u32 = 0;
        let mut scroll_position: u32 = 0;
        let mut window_id = None;
        let mut border_title = String::new();
        let mut found_boundary = false;

        if parts.len() > num_tail_fields {
            let is_intlike = |s: &str| s.is_empty() || s.parse::<u32>().is_ok();
            // window_id sits at index >= 15 (command=9, title>=1 field at 10,
            // then 4 structured fields, then window_id). Scan the middle region.
            for i in 15..(parts.len() - num_tail_fields) {
                let val = parts[i];
                let Ok(anchor) = WindowId::parse(val) else {
                    continue;
                };
                if (parts[i - 4] == "0" || parts[i - 4] == "1")
                    && is_intlike(parts[i - 3])
                    && is_intlike(parts[i - 2])
                    && is_intlike(parts[i - 1])
                {
                    title = parts[10..i - 4].join(",");
                    in_mode = parts[i - 4] == "1";
                    copy_cursor_x = parts[i - 3].parse().unwrap_or(0);
                    copy_cursor_y = parts[i - 2].parse().unwrap_or(0);
                    scroll_position = parts[i - 1].parse().unwrap_or(0);
                    window_id = Some(anchor);
                    border_title = parts[i + 1..parts.len() - num_tail_fields].join(",");
                    found_boundary = true;
                    break;
                }
            }
        }

        // Fallback to fixed-offset parsing when the anchor wasn't found (e.g. a
        // truncated line or a future format change). border_title is still
        // recovered from the region before the fixed tail.
        if !found_boundary {
            title = parts.get(10).map(|s| s.to_string()).unwrap_or_default();
            in_mode = parts.get(11).map(|s| *s == "1").unwrap_or(false);
            copy_cursor_x = parts.get(12).and_then(|s| s.parse().ok()).unwrap_or(0);
            copy_cursor_y = parts.get(13).and_then(|s| s.parse().ok()).unwrap_or(0);
            scroll_position = parts.get(14).and_then(|s| s.parse().ok()).unwrap_or(0);
            window_id = parts.get(15).and_then(|s| WindowId::parse(s).ok());
            border_title = if parts.len() > 16 + num_tail_fields {
                parts[16..parts.len() - num_tail_fields].join(",")
            } else {
                parts.get(16).map(|s| s.to_string()).unwrap_or_default()
            };
        }

        // Check if this is a new pane
        let is_new_pane = !self.panes.contains_key(&pane_id);
        let scrollback_rows = self.scrollback_rows;

        let pane = self.panes.entry(pane_id.clone()).or_insert_with(|| {
            PaneState::new(pane_id.clone(), width, height).with_scrollback_rows(scrollback_rows)
        });

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

        pane.index = pane_index;
        pane.x = x;
        pane.y = y;
        let was_resized = pane.resize(width, height);
        if was_resized && !is_new_pane {
            debug!(pane = %pane_id, cols = width, rows = height, "pane resized");
        }
        pane.active = active;
        pane.command = pane_command(command, pane_widget.as_deref());
        pane.title = if is_graphics_payload(&title) {
            String::new()
        } else {
            title
        };
        pane.border_title = border_title;
        let was_in_mode = pane.in_mode;
        pane.in_mode = in_mode;
        if was_in_mode && !in_mode {
            pane.copy_mode_content = None;
        }
        pane.copy_cursor_x = copy_cursor_x;
        pane.copy_cursor_y = copy_cursor_y;
        pane.scroll_position = scroll_position;
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
        pane.alternate_on = alternate_on;
        pane.mouse_any_flag = mouse_any_flag;
        pane.marked = marked;
        pane.selection_present = selection_present;
        pane.selection_start_x = selection_start_x;
        pane.selection_start_y = selection_start_y;
        pane.history_size = history_size;
        pane.group_id = group_id;
        pane.group_pos = group_pos;
        pane.pane_state = pane_state;
        pane.pane_ask = pane_ask;
        pane.pane_widget = pane_widget;
        pane.pane_restore = pane_restore;
        pane.pane_url = pane_url;

        // Store tmux's authoritative cursor position
        pane.tmux_cursor_x = cursor_x;
        pane.tmux_cursor_y = cursor_y;

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
