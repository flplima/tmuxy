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

    /// Process new output for this pane (appends to existing buffer)
    pub fn process_output(&mut self, content: &[u8]) {
        self.content_dirty = true;

        // Ensure image parser starts with the current vt100 cursor position.
        let (init_row, init_col) = self.terminal.screen().cursor_position();
        self.image_parser.update_cursor(init_row, init_col);

        // Temporarily take `image_parser` so the clean-bytes callback can
        // mutate `self` (feeding `osc_parser` and `vt100` and shifting image
        // placements on scroll) right before each image escape is placed.
        let mut image_parser = std::mem::take(&mut self.image_parser);
        let new_images = image_parser.process_with(content, |clean_bytes, parser| {
            // Put placements on `self.image_parser` while `feed_terminal`
            // runs so `sync_url_scroll` shifts them by any scroll delta
            // caused by `clean_bytes`.
            std::mem::swap(&mut self.image_parser.placements, &mut parser.placements);
            let osc = self.osc_parser.process(clean_bytes);
            self.feed_terminal(osc);
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
        // SEC-22: nothing evicted while the pane lived, so a loop printing
        // images grew the process without bound — the server's own store is
        // trimmed only for DEAD panes. The images a pane can actually be
        // showing are bounded by its screen; this is far above that and
        // bounded, which is the point.
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

        // Derive alternate_on and mouse_any_flag from the vt100 parser state.
        // This is more reliable than polling list-panes, as it updates immediately
        // when the application sends the escape sequence.
        self.alternate_on = self.terminal.screen().alternate_screen();
        self.mouse_any_flag = !matches!(
            self.terminal.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::None
        );
        self.cursor_hidden = self.terminal.screen().hide_cursor();
        // An OSC 0/2 title, applied here rather than waiting for tmux to
        // report `pane_title` on the next list-panes. That only happens on a
        // metadata sync or the 15-second idle heartbeat, so a program
        // announcing a new title left the header showing the old one for up
        // to fifteen seconds. tmux sees the same escape and agrees at the
        // next poll; this only removes the lag.
        if let Some(title) = self.osc_parser.take_title() {
            self.set_title(title);
        }

        // Update image parser cursor position from vt100 state
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
        // Snapshot DEC line-size attributes before the grid is rebuilt:
        // tmux strips `ESC # 3..6` from `capture-pane` output, so we re-apply
        // the line size on any row whose trimmed text still matches.
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

        self.reset(Reset::Capture);
        let normalized = normalize_capture_bytes(content);
        self.terminal.process(&normalized);
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

    /// Rebuild the emulator for this pane's size, in the modes tmux reports
    /// (`fresh_terminal`). Every reset clears the same set: the grid, the
    /// hyperlink marks, the content cache and the scroll baseline. What it
    /// keeps depends on `kind`.
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
            // image escapes from captured history), and OSC 66 `sized_cells`
            // are validated against live characters (`OscParser::row_sizes`).
            Reset::Capture => {
                self.image_parser.reset_for_capture();
                self.osc_parser.reset_for_capture();
            }
            Reset::Moved => {
                self.image_parser.reset();
                self.osc_parser.reset();
            }
        }
        self.osc_parser.set_viewport_height(self.height);
        self.content_dirty = true;
        self.cached_content = None;
        self.rebaseline_scroll();
        let (row, col) = self.terminal.screen().cursor_position();
        self.image_parser.update_cursor(row, col);
    }

    /// A parser for this pane's size, already in the modes tmux reports.
    ///
    /// The alternate screen (`?1049h`) and mouse tracking (`?1000h`) are state
    /// the application set once, possibly long before this client attached. A
    /// parser rebuilt for a capture refill (or a window move) never saw those
    /// sequences — capture-pane replays screen contents, not the modes — so it
    /// reported neither, while list-panes kept reporting both. The derived
    /// flags then flapped between the two sources on every %output /
    /// list-panes pair.
    ///
    /// For `alternate_on` that showed up as the pane re-rendering a few times
    /// a second (the "blinking" pane running Claude Code). For
    /// `mouse_any_flag` it split a single scroll gesture in two: wheel events
    /// that landed while the flag read true were sent to the application as
    /// SGR mouse reports, and the ones in between — the flag momentarily false
    /// with the alternate screen still on — went as arrow keys, so a
    /// mouse-tracking app received both for one flick of the trackpad (see
    /// `sendScrollLines` in tmuxy-ui/src/hooks/scrollUtils.ts, where mouse
    /// tracking and alt-screen are deliberately exclusive).
    ///
    /// Entering the modes up front keeps the captured screen in the grid tmux
    /// drew it on and the two sources in agreement. Any tracking mode makes
    /// the flag true, so plain `?1000h` restores it whichever variant
    /// (1000/1002/1003) the application actually chose; a later `?1000l` from
    /// the application still clears it.
    fn fresh_terminal(&self) -> vt100::Parser {
        let w = (self.width as u16).max(1);
        let h = (self.height as u16).max(1);
        let mut terminal = vt100::Parser::new(h, w, crate::constants::REFLOW_SCROLLBACK_ROWS);
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

    /// The OSC 52 clipboard write the output since the last call asked for.
    pub(in crate::control_mode::state) fn take_clipboard(&mut self) -> Option<String> {
        self.osc_parser.take_clipboard()
    }

    /// Resize the terminal.
    /// Returns true if the dimensions actually changed.
    pub fn resize(&mut self, width: u32, height: u32) -> bool {
        if self.width != width || self.height != height {
            self.width = width;
            self.height = height;
            self.content_dirty = true;
            self.cached_content = None;
            // Guard: vt100 panics on zero dimensions (subtract overflow in grid.rs)
            let w = (width as u16).max(1);
            let h = (height as u16).max(1);
            // Reflow the existing grid IN PLACE, preserving content and cursor
            // anchoring. The previous approach recreated the parser and replayed
            // the whole accumulated raw %output buffer, which re-scrolled that
            // output through a fresh grid — leaving short content BOTTOM-anchored
            // (blank rows prepended, prompt glued to the last row) after a
            // swap/resize in the fully client-side (v86) path, where there is no
            // authoritative capture-pane pass to correct the replay. vt100's
            // `set_size` rewraps each row to the new width and grows/shrinks the
            // grid from the bottom, so top-anchored content stays where it is and
            // the cursor is clamped — matching what a real terminal does on
            // SIGWINCH. This also subsumes the original %layout-change case the
            // replay was added for (content is reflowed, never lost).
            self.terminal.screen_mut().set_size(h, w);
            self.image_parser.reset_for_resize(self.alternate_on);
            // Drop stale hyperlink cell mappings (reflowed coordinates no longer
            // match) and realign the scroll compensation to the new height.
            self.osc_parser.reset();
            self.osc_parser.set_viewport_height(height);
            self.rebaseline_scroll();
            let (row, col) = self.terminal.screen().cursor_position();
            self.image_parser.update_cursor(row, col);
            true
        } else {
            false
        }
    }
}
