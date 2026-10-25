use super::*;
use crate::PaneId;

/// Split bytes into whole UTF-8 characters, so a hyperlinked run can be fed to
/// vt100 one character at a time without tearing a multi-byte sequence. Any
/// byte that is not a continuation byte (`10xxxxxx`) starts a new chunk, which
/// also keeps a stray escape inside a link on its own chunk.
fn utf8_chunks(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts: Vec<usize> = (0..data.len())
        .filter(|&i| data[i] & 0xC0 != 0x80)
        .collect();
    starts.push(data.len());
    (0..starts.len().saturating_sub(1)).map(move |i| &data[starts[i]..starts[i + 1]])
}

impl PaneState {
    /// Feed vt100 the OSC-stripped bytes, recording which cells a hyperlink
    /// covers as they are written.
    ///
    /// Output with no hyperlink in it takes one bulk `process()` call, exactly
    /// as before. Only the bytes *inside* an OSC 8 pair take the slow path:
    /// they go in one character at a time and vt100 is asked where the cursor
    /// sat before and after each one, so the mark lands on the cell the
    /// character actually occupies. That is the whole point — the parser used
    /// to derive those coordinates from its own newline counting, which is
    /// blind to CSI cursor movement and drifted the map onto unrelated text.
    fn feed_terminal(&mut self, osc: super::osc::OscOutput) {
        if osc.links.is_empty() && osc.sized.is_empty() {
            self.terminal.process(&osc.bytes);
            self.sync_url_scroll();
            return;
        }

        if osc.sized.is_empty() {
            let mut at = 0usize;
            for (start, end, url) in &osc.links {
                if *start > at {
                    self.terminal.process(&osc.bytes[at..*start]);
                    self.sync_url_scroll();
                }
                self.feed_linked(&osc.bytes[*start..*end], url);
                at = *end;
            }
            if at < osc.bytes.len() {
                self.terminal.process(&osc.bytes[at..]);
                self.sync_url_scroll();
            }
            return;
        }

        let mut at = 0usize;
        for (start, end, size, mirror_bottom) in &osc.sized {
            if *start > at {
                self.terminal.process(&osc.bytes[at..*start]);
                self.sync_url_scroll();
            }
            let active_url = osc
                .links
                .iter()
                .find(|(ls, le, _)| *ls <= *start && *end <= *le)
                .map(|(_, _, u)| u);
            for chunk in utf8_chunks(&osc.bytes[*start..*end]) {
                let (mark_row, marks) = self.write_and_collect_marks(chunk);
                for (c, ch) in marks {
                    self.osc_parser.mark_sized_cell(
                        u32::from(mark_row),
                        u32::from(c),
                        *size,
                        &ch,
                        *mirror_bottom,
                    );
                    if let Some(url) = active_url {
                        self.osc_parser
                            .mark_cell(u32::from(mark_row), u32::from(c), url, &ch);
                    }
                }
            }
            at = *end;
        }
        if at < osc.bytes.len() {
            self.terminal.process(&osc.bytes[at..]);
            self.sync_url_scroll();
        }
    }

    fn write_and_collect_marks(&mut self, chunk: &[u8]) -> (u16, Vec<(u16, String)>) {
        let (row, col) = self.terminal.screen().cursor_position();
        self.terminal.process(chunk);
        let scrolled = self.sync_url_scroll();
        let (row2, col2) = self.terminal.screen().cursor_position();
        let row_before = i64::from(row) - scrolled;
        let (mark_row, from, to) = if i64::from(row2) == row_before {
            (row2, col, col2)
        } else {
            (row2, 0, col2)
        };
        let marks = (from..to)
            .map(|c| {
                (
                    c,
                    crate::screen_cell_char(self.terminal.screen(), mark_row, c),
                )
            })
            .collect();
        (mark_row, marks)
    }

    /// Write one hyperlinked run, marking every cell it paints.
    fn feed_linked(&mut self, bytes: &[u8], url: &std::sync::Arc<str>) {
        for chunk in utf8_chunks(bytes) {
            let (mark_row, marks) = self.write_and_collect_marks(chunk);
            for (c, ch) in marks {
                self.osc_parser
                    .mark_cell(u32::from(mark_row), u32::from(c), url, &ch);
            }
        }
    }

    /// Take the current grid's scroll counter as the new zero point, without
    /// shifting anything. Called after the grid is replaced or reflowed, when
    /// the marks have just been cleared and no delta is meaningful.
    fn rebaseline_scroll(&mut self) {
        let screen = self.terminal.screen();
        self.scroll_baseline_alt = screen.alternate_screen();
        self.last_scroll_delta = screen.scroll_delta();
    }

    /// Shift recorded URL marks by however far vt100 actually scrolled since
    /// the last check, and return that delta so a caller can re-base a cursor
    /// position it read before the write.
    fn sync_url_scroll(&mut self) -> i64 {
        let screen = self.terminal.screen();
        let alt = screen.alternate_screen();
        let now = screen.scroll_delta();

        if alt != self.scroll_baseline_alt {
            // A different grid entirely: its counter is unrelated to the one
            // the marks were taken against, and the text under them is not on
            // screen. Re-base and drop the marks rather than shift by a
            // meaningless delta — a stale URL landing on the alternate screen's
            // content is the exact failure this whole path exists to prevent.
            self.scroll_baseline_alt = alt;
            self.last_scroll_delta = now;
            self.osc_parser.clear_cells();
            return 0;
        }

        let delta = now - self.last_scroll_delta;
        self.last_scroll_delta = now;
        match delta.cmp(&0) {
            std::cmp::Ordering::Greater => {
                let d = delta as u32;
                self.osc_parser.shift_rows_up(d);
                self.image_parser
                    .shift_rows_up(d, crate::constants::IMAGE_HISTORY_ROWS);
            }
            std::cmp::Ordering::Less => {
                let d = delta.unsigned_abs() as u32;
                self.osc_parser.shift_rows_down(d);
                self.image_parser.shift_rows_down(d);
            }
            std::cmp::Ordering::Equal => {}
        }
        delta
    }

    /// Replay the `%output` that arrived for this pane before it existed —
    /// during a split, `%output` often lands before the `%layout-change` or
    /// list-panes row that creates the pane. Returns how many bytes it was.
    pub(super) fn replay_early_output(
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

        // Update image parser cursor position from vt100 state
        let screen = self.terminal.screen();
        let (row, col) = screen.cursor_position();
        self.image_parser.update_cursor(row, col);
        // Kitty's tmux passthrough places images with Unicode cells.
        self.image_parser.update_kitty_placeholders(screen, content);
    }

    /// Reset terminal and process capture-pane output.
    /// capture-pane returns plain text with ANSI colors but no cursor positioning,
    /// so we need to reset to top-left before processing.
    pub fn reset_and_process_capture(&mut self, content: &[u8]) {
        self.content_dirty = true;
        self.cached_content = None;

        // Snapshot DEC line-size attributes before rebuilding `self.terminal`:
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

        // A fresh terminal clears every mode and attribute the capture cannot
        // carry; the history is kept across it. A capture is the screen as it
        // is now, and the rows that scrolled off it before are still the rows
        // that scrolled off it, which a later reflow pulls back down.
        let history = self.terminal.screen_mut().take_scrollback();
        self.terminal = self.fresh_terminal();
        self.terminal.screen_mut().restore_scrollback(history);
        // Keep image placements: the capture text can't recreate them (tmux
        // strips image escapes from captured history).
        self.image_parser.reset_for_capture();
        // Clear stale hyperlink mappings while preserving OSC 66 `sized_cells`
        // (validated against live characters in `OscParser::row_sizes`).
        self.osc_parser.reset_for_capture();

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
    pub(super) fn fresh_terminal(&self) -> vt100::Parser {
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
