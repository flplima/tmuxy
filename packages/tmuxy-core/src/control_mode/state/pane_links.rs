//! Feeding a pane's emulator output that carries OSC 8 hyperlinks, and
//! keeping the link marks on the lines they were written on.

use super::*;

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
    pub(super) fn feed_terminal(&mut self, osc: super::osc::OscOutput) {
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
    pub(super) fn rebaseline_scroll(&mut self) {
        let screen = self.terminal.screen();
        self.scroll_baseline_alt = screen.alternate_screen();
        self.last_scroll_delta = screen.scroll_delta();
    }

    /// Shift recorded URL marks by however far vt100 actually scrolled since
    /// the last check, and return that delta so a caller can re-base a cursor
    /// position it read before the write.
    pub(super) fn sync_url_scroll(&mut self) -> i64 {
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
}
