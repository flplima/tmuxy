use super::*;
use crate::{PaneId, WindowId};

/// What a pane's emulator reset keeps (`PaneState::reset`).
enum Reset {
    /// A capture refill: the history and the pictures stay.
    Capture,
    /// A move to another window: nothing stays.
    Moved,
}

impl PaneState {
    /// Replay the `%output` that arrived for this pane before it existed —
    /// during a split, `%output` often lands before the `%layout-change` or
    /// list-panes row that creates the pane. Returns how many bytes it was.
    pub(in crate::control_mode::state) fn replay_early_output(
        &mut self,
        early_output: &mut HashMap<PaneId, Vec<u8>>,
    ) -> usize {
        let Some(early) = early_output.remove(&self.id) else {
            return 0;
        };
        self.output_bytes += early.len() as u64;
        self.process_output(&early);
        early.len()
    }

    pub fn process_output(&mut self, content: &[u8]) {
        self.content_dirty = true;

        let (init_row, init_col) = self.terminal.screen().cursor_position();
        self.image_parser.update_cursor(init_row, init_col);

        let mut image_parser = std::mem::take(&mut self.image_parser);
        let new_images = image_parser.process_with(content, |clean_bytes, parser| {
            // Put placements on `self.image_parser` while vt100 runs so
            // `sync_image_scroll` shifts them by any scroll delta caused by
            // `clean_bytes`.
            std::mem::swap(&mut self.image_parser.placements, &mut parser.placements);
            self.terminal.process(clean_bytes);
            self.sync_image_scroll();
            std::mem::swap(&mut self.image_parser.placements, &mut parser.placements);
            let (row, col) = self.terminal.screen().cursor_position();
            parser.update_cursor(row, col);
        });
        self.image_parser = image_parser;

        // The cursor style the output asked for (DECSCUSR), read off the
        // parser that saw it. A screen that never saw one says nothing, so a
        // pane keeps its shape across a resize that rebuilds the parser.
        if let Some(shape) = self.terminal.screen().cursor_shape() {
            self.cursor_shape = shape;
        }

        for (id, stored) in new_images {
            self.image_store.insert(id, stored);
            self.image_store_order.push_back(id);
        }
        // The server's own store is trimmed only for DEAD panes, so this is
        // what bounds a live one (`MAX_STORED_IMAGES_PER_PANE`).
        while self.image_store.len() > MAX_STORED_IMAGES_PER_PANE {
            match self.image_store_order.pop_front() {
                Some(oldest) => {
                    self.image_store.remove(&oldest);
                }
                // The order log and the store disagree (an id was removed
                // elsewhere): drop the store's own oldest rather than spin.
                None => {
                    if let Some(&any) = self.image_store.keys().next() {
                        self.image_store.remove(&any);
                    } else {
                        break;
                    }
                }
            }
        }

        // From the parser, not the list-panes poll: it changes the moment the
        // program sends the escape.
        self.alternate_on = self.terminal.screen().alternate_screen();
        self.mouse_any_flag = !matches!(
            self.terminal.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::None
        );
        self.cursor_hidden = self.terminal.screen().hide_cursor();
        // An OSC 0/2 title, applied now: tmux reports `pane_title` only on
        // the next list-panes, which can be the idle heartbeat seconds later.
        // tmux sees the same escape and agrees at that poll.
        if let Some(title) = self.terminal.callbacks_mut().take_title() {
            self.set_title(title);
        }
        let status = self.terminal.callbacks_mut().take_status();
        self.program_status.read(status, Instant::now());

        let screen = self.terminal.screen();
        let (row, col) = screen.cursor_position();
        self.image_parser.update_cursor(row, col);
        // Kitty's tmux passthrough places images with Unicode cells.
        self.image_parser.update_kitty_placeholders(screen, content);
    }

    /// Replace the screen with a `capture-pane` of it and put the cursor where
    /// tmux reports it. capture-pane returns plain text with ANSI colors but
    /// no cursor positioning, so the grid is reset to top-left before it is
    /// written, and the cursor is placed after.
    pub fn apply_capture(&mut self, content: &[u8]) {
        // Snapshot the sizes before the grid is rebuilt: tmux strips
        // `ESC # 3..6` and `OSC 66` from `capture-pane` output, so a row's
        // DEC line size comes back where the row's trimmed text still
        // matches, and a cell's OSC 66 size where its character does.
        let prev_screen = self.terminal.screen();
        let (prev_rows, prev_cols) = prev_screen.size();
        let saved_line_sizes: Vec<(u16, vt100::LineSize, String)> = (0..prev_rows)
            .filter_map(|r| {
                let ls = prev_screen.row_line_size(r);
                if ls == vt100::LineSize::Single {
                    return None;
                }
                let text: String = (0..prev_cols)
                    .map(|c| crate::screen_cell_char(prev_screen, r, c))
                    .collect::<String>()
                    .trim_end()
                    .to_string();
                Some((r, ls, text))
            })
            .collect();
        let saved_text_sizes: Vec<(u16, u16, vt100::TextSize, String)> = (0..prev_rows)
            .flat_map(|r| (0..prev_cols).map(move |c| (r, c)))
            .filter_map(|(r, c)| {
                let size = prev_screen.cell(r, c)?.text_size();
                (size != vt100::TextSize::Normal)
                    .then(|| (r, c, size, crate::screen_cell_char(prev_screen, r, c)))
            })
            .collect();

        self.reset(Reset::Capture);
        let normalized = normalize_capture_bytes(content);
        self.terminal.process(&normalized);
        // `capture-pane -e` writes the screen's OSC 8 links and vt100 reads
        // them as it does live output's; one the capture leaves open is
        // closed here so it does not run on into later output.
        self.terminal.process(b"\x1b]8;;\x1b\\");
        for (r, ls, prev_text) in saved_line_sizes {
            let screen = self.terminal.screen();
            let (_, cols) = screen.size();
            let cur_text: String = (0..cols)
                .map(|c| crate::screen_cell_char(screen, r, c))
                .collect::<String>()
                .trim_end()
                .to_string();
            if cur_text == prev_text {
                self.terminal.screen_mut().set_row_line_size(r, ls);
            }
        }
        for (r, c, size, prev_char) in saved_text_sizes {
            if crate::screen_cell_char(self.terminal.screen(), r, c) == prev_char {
                self.terminal.screen_mut().set_cell_text_size(r, c, size);
            }
        }
        // The capture leaves vt100's cursor at the end of the content (the
        // last row); tmux's is where the program left it.
        let cursor = format!(
            "\x1b[{};{}H",
            self.tmux_cursor_y + 1,
            self.tmux_cursor_x + 1
        );
        self.terminal.process(cursor.as_bytes());
        self.rebaseline_scroll();
        let (row, col) = self.terminal.screen().cursor_position();
        self.image_parser.update_cursor(row, col);
    }

    /// The pane is now in `window_id` (a break-pane, a swap-pane). Nothing of
    /// its old grid is its own any more — not the screen, not the history,
    /// not a picture — so it is blank until its capture lands.
    pub(in crate::control_mode::state) fn move_to_window(&mut self, window_id: WindowId) {
        self.window_id = Some(window_id);
        self.reset(Reset::Moved);
    }

    fn reset(&mut self, kind: Reset) {
        let history = match kind {
            // A capture is the screen as it is now, and the rows that scrolled
            // off it before are still the rows that scrolled off it, which a
            // later reflow pulls back down.
            Reset::Capture => Some(self.terminal.screen_mut().take_scrollback()),
            Reset::Moved => None,
        };
        self.terminal = self.fresh_terminal();
        if let Some(history) = history {
            self.terminal.screen_mut().restore_scrollback(history);
        }
        match kind {
            // The capture text can't recreate image placements (tmux strips
            // image escapes from captured history).
            Reset::Capture => self.image_parser.reset_for_capture(),
            Reset::Moved => self.image_parser.reset(),
        }
        self.content_dirty = true;
        self.cached_content = None;
        self.rebaseline_scroll();
        let (row, col) = self.terminal.screen().cursor_position();
        self.image_parser.update_cursor(row, col);
    }

    /// A parser for this pane's size, already in the modes tmux reports.
    ///
    /// The alternate screen (`?1049h`) and mouse tracking (`?1000h`) are modes
    /// the program set once, maybe long before this client attached, and
    /// capture-pane replays the screen, not the modes. A rebuilt parser that
    /// reported neither while list-panes reported both made the flags flap on
    /// every %output / list-panes pair: the pane re-rendered a few times a
    /// second, and one scroll gesture went to a mouse-tracking program partly
    /// as SGR mouse reports and partly as arrow keys (`sendScrollLines` in
    /// tmuxy-ui/src/components/terminal/scrollUtils.ts treats the two as
    /// exclusive).
    ///
    /// Any tracking mode makes the flag true, so plain `?1000h` restores it
    /// whichever variant (1000/1002/1003) the program chose; a later `?1000l`
    /// still clears it.
    fn fresh_terminal(&self) -> vt100::Parser<super::osc::OscRequests> {
        let mut terminal = vt100::Parser::new_with_callbacks(
            crate::grid_side(self.height),
            crate::grid_side(self.width),
            crate::constants::REFLOW_SCROLLBACK_ROWS,
            super::osc::OscRequests::default(),
        );
        if self.alternate_on {
            terminal.process(b"\x1b[?1049h");
        }
        if self.mouse_any_flag {
            terminal.process(b"\x1b[?1000h");
        }
        // A hidden cursor is a mode too: rebuilt without it, a full-screen
        // program that hid its cursor long ago (an image viewer, a pager)
        // grew a block cursor over its picture after every capture refill.
        if self.cursor_hidden {
            terminal.process(b"\x1b[?25l");
        }
        terminal
    }

    /// The commands that tell tmux what the pane's program last reported
    /// (OSC 7501), when that changed what the pane shows: its state, the
    /// record behind it, or both. They are the pane's at once; tmux's next
    /// `list-panes` agrees. The text goes first, so nothing reads the new
    /// state with the old one's text.
    pub(in crate::control_mode::state) fn status_commands(&mut self, now: Instant) -> Vec<String> {
        use crate::constants::tmux_options::{PANE_STATE, PANE_STATUS};
        let Some(due) = self.program_status.due(self.pane_state.as_deref(), now) else {
            return Vec::new();
        };
        let id = &self.id;
        let mut commands = Vec::new();
        if due.write_status {
            // A report body holds no quote: its bytes are the protocol's
            // value set, which the parser held it to.
            commands.push(match &due.status {
                Some(status) => format!("set-option -p -t {id} {PANE_STATUS} '{status}'"),
                None => format!("set-option -pu -t {id} {PANE_STATUS}"),
            });
            self.pane_status = due.status;
        }
        if due.write_state {
            commands.push(match due.state {
                Some(state) => format!("set-option -p -t {id} {PANE_STATE} {}", state.as_str()),
                None => format!("set-option -pu -t {id} {PANE_STATE}"),
            });
            self.pane_state = due.state.map(|state| state.as_str().to_string());
        }
        commands
    }

    /// The OSC 52 clipboard write the output since the last call asked for.
    pub(in crate::control_mode::state) fn take_clipboard(&mut self) -> Option<String> {
        self.terminal.callbacks_mut().take_clipboard()
    }

    /// Returns whether the size changed.
    pub fn resize(&mut self, width: u32, height: u32) -> bool {
        if self.width != width || self.height != height {
            self.width = width;
            self.height = height;
            self.content_dirty = true;
            self.cached_content = None;
            // Reflowed IN PLACE, the way a terminal does on SIGWINCH: `set_size`
            // rewraps each row and grows/shrinks the grid from the bottom, so
            // top-anchored content stays put. Replaying the raw output through a
            // fresh grid left short content BOTTOM-anchored in the client-side
            // (v86) path, which has no capture to correct it.
            self.terminal
                .screen_mut()
                .set_size(crate::grid_side(height), crate::grid_side(width));
            self.image_parser.reset_for_resize(self.alternate_on);
            self.rebaseline_scroll();
            let (row, col) = self.terminal.screen().cursor_position();
            self.image_parser.update_cursor(row, col);
            true
        } else {
            false
        }
    }

    /// Take the current grid's scroll counter as the new zero point, without
    /// shifting anything. Called after the grid is replaced or reflowed, when
    /// no delta is meaningful.
    fn rebaseline_scroll(&mut self) {
        let screen = self.terminal.screen();
        self.scroll_baseline_alt = screen.alternate_screen();
        self.last_scroll_delta = screen.scroll_delta();
    }

    /// Shift image placements by however far vt100 actually scrolled since
    /// the last check, so a picture stays on the lines it was drawn on.
    fn sync_image_scroll(&mut self) {
        let screen = self.terminal.screen();
        let alt = screen.alternate_screen();
        let now = screen.scroll_delta();

        if alt != self.scroll_baseline_alt {
            // A different grid entirely: its counter is unrelated to the one
            // the placements were taken against, so re-base rather than shift
            // by a meaningless delta.
            self.scroll_baseline_alt = alt;
            self.last_scroll_delta = now;
            return;
        }

        let delta = now - self.last_scroll_delta;
        self.last_scroll_delta = now;
        match delta.cmp(&0) {
            std::cmp::Ordering::Greater => self
                .image_parser
                .shift_rows_up(delta as u32, crate::constants::IMAGE_HISTORY_ROWS),
            std::cmp::Ordering::Less => self
                .image_parser
                .shift_rows_down(delta.unsigned_abs() as u32),
            std::cmp::Ordering::Equal => {}
        }
    }
}
