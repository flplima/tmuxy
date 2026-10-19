//! OSC (Operating System Command) sequence parser for terminal protocols
//!
//! Parses OSC sequences from raw terminal output:
//! - OSC 8: Hyperlinks (URL associations per text region)
//! - OSC 52: Clipboard operations

use std::collections::HashMap;
use std::sync::Arc;

/// Upper bound on a buffered incomplete OSC sequence carried across `process()`
/// calls. tmux emits `%output` in bounded chunks and a real OSC (hyperlink URL,
/// OSC 52 clipboard) completes well within this; if we somehow accumulate more
/// without a terminator the stream is malformed, so we flush rather than grow
/// without bound.
const MAX_PENDING_OSC: usize = 64 * 1024;

/// Bytes destined for vt100, plus the hyperlink and OSC 66 sized spans inside them.
#[derive(Debug, Default)]
pub struct OscOutput {
    /// The input with OSC sequences stripped out (except OSC 66 text payloads).
    pub bytes: Vec<u8>,
    /// `(start, end, url)` half-open ranges into `bytes`, in order and
    /// non-overlapping, that were emitted while an OSC 8 link was open.
    pub links: Vec<(usize, usize, Arc<str>)>,
    /// `(start, end, size, mirror_bottom)` half-open ranges into `bytes` emitted by OSC 66.
    pub sized: Vec<(usize, usize, crate::CellSize, bool)>,
}

fn push_link(links: &mut Vec<(usize, usize, Arc<str>)>, start: usize, end: usize, url: Arc<str>) {
    if end > start {
        links.push((start, end, url));
    }
}

/// A recorded hyperlink, and the character that was under it when it was
/// recorded.
///
/// The character is the mark's proof of freshness. vt100 carries no per-cell
/// hyperlink attribute, so a cell being overwritten is invisible to this map;
/// without something to check against, a mark stayed on its coordinates and
/// re-attached to whatever text a later frame drew there.
#[derive(Debug, Clone)]
pub struct CellMark {
    /// SEC-22: shared by every cell the same OSC 8 pair covered, and with the
    /// open hyperlink itself, so a screen full of linked text holds one copy
    /// of each URL rather than one per cell — pane output could otherwise
    /// multiply a long URL by every cell on the screen.
    url: Arc<str>,
    ch: String,
}

#[derive(Debug, Clone)]
pub struct SizedMark {
    pub size: crate::CellSize,
    pub ch: String,
}

/// The longest OSC 8 URL honoured. Longer ones open no link and their text is
/// drawn plain: the URL comes from pane output, and a link the size of the
/// screen is not one anybody follows.
pub const MAX_HYPERLINK_URL_BYTES: usize = 8 * 1024;

/// OSC parser state for a single pane
#[derive(Debug, Default)]
pub struct OscParser {
    /// Active hyperlink (URL currently being applied to output)
    active_hyperlink: Option<(Arc<str>, Option<String>)>, // (url, id)
    /// Visible height of the pane, in rows. Bounds `cell_urls` to the screen:
    /// a mark shifted above row 0 by scrolling is dropped.
    viewport_height: u32,
    /// Pending clipboard content (from OSC 52)
    pub pending_clipboard: Option<String>,
    /// Pending pane title (from OSC 0 / OSC 2), waiting to be drained.
    ///
    /// Read straight off the pane's own output stream rather than waiting for
    /// tmux to report `pane_title` back on the next `list-panes`: that only
    /// happens on a metadata sync or the 15-second idle heartbeat, so a program
    /// announcing a new title left the header showing the old one for as long
    /// as fifteen seconds.
    pub pending_title: Option<String>,
    /// Hyperlink per cell coordinate: (row, col) -> [`CellMark`].
    ///
    /// Written by the caller via [`OscParser::mark_cell`] once vt100 has told
    /// it where a byte actually landed — this parser deliberately keeps no
    /// cursor of its own. It used to, advancing on `\n` / `\r` / printable
    /// ASCII only, which made it blind to every CSI cursor movement (most of
    /// what a shell prompt emits) and drifted the whole map off the text.
    ///
    /// Read back through [`OscParser::row_urls`], never by coordinate alone:
    /// a mark is only good while the character it was written on is still
    /// there.
    cell_urls: HashMap<(u32, u32), CellMark>,
    /// Kitty OSC 66 text-sizing marks per cell coordinate: (row, col) -> [`SizedMark`].
    sized_cells: HashMap<(u32, u32), SizedMark>,
    /// An incomplete OSC sequence split across `%output` chunks, carried into
    /// the next `process()` call so the sequence isn't torn (header rendered as
    /// garbage, payload lost).
    pending: Vec<u8>,
}

impl OscParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reset parser state (called on pane resize and full capture refresh so
    /// stale URL mappings don't attach to new content at the same coordinates,
    /// and `cell_urls` can't grow across a reflow). Preserves `viewport_height`,
    /// which is a property of the pane, not the content.
    pub fn reset(&mut self) {
        self.active_hyperlink = None;
        self.pending_clipboard = None;
        self.pending_title = None;
        self.cell_urls.clear();
        self.sized_cells.clear();
        self.pending.clear();
    }

    /// Reset parser state for a `capture-pane` refresh while preserving
    /// `sized_cells` (validated against live characters in [`OscParser::row_sizes`]).
    pub fn reset_for_capture(&mut self) {
        self.active_hyperlink = None;
        self.pending_clipboard = None;
        self.pending_title = None;
        self.cell_urls.clear();
        self.pending.clear();
    }

    /// Set the pane's visible height (rows). Enables scroll-compensation of the
    /// cell→URL map so hyperlinks keep working past the first screenful.
    pub fn set_viewport_height(&mut self, height: u32) {
        self.viewport_height = height;
    }

    /// Shift every mark up by `rows`, dropping what falls off the top.
    ///
    /// Driven by the vt100 screen's own `scroll_delta`, not by counting
    /// newlines: a mark has to travel with the line it was written on however
    /// that line moved — a bare `\n` at the bottom, an `ESC M`, a `CSI S`, or
    /// an application repainting itself.
    pub fn shift_rows_up(&mut self, rows: u32) {
        if rows == 0 {
            return;
        }
        if !self.cell_urls.is_empty() {
            self.cell_urls = self
                .cell_urls
                .drain()
                .filter_map(|((row, col), url)| row.checked_sub(rows).map(|r| ((r, col), url)))
                .collect();
        }
        if !self.sized_cells.is_empty() {
            self.sized_cells = self
                .sized_cells
                .drain()
                .filter_map(|((row, col), m)| row.checked_sub(rows).map(|r| ((r, col), m)))
                .collect();
        }
    }

    /// Shift every mark down by `rows`, dropping what falls off the bottom.
    /// The reverse-scroll counterpart of [`shift_rows_up`].
    pub fn shift_rows_down(&mut self, rows: u32) {
        if rows == 0 {
            return;
        }
        let height = self.viewport_height;
        if !self.cell_urls.is_empty() {
            self.cell_urls = self
                .cell_urls
                .drain()
                .map(|((row, col), url)| ((row + rows, col), url))
                .filter(|((row, _), _)| height == 0 || *row < height)
                .collect();
        }
        if !self.sized_cells.is_empty() {
            self.sized_cells = self
                .sized_cells
                .drain()
                .map(|((row, col), m)| ((row + rows, col), m))
                .filter(|((row, _), _)| height == 0 || *row < height)
                .collect();
        }
    }

    /// Record that the cell at `(row, col)` carries `url`. Called once vt100
    /// has been asked where the byte landed, so wrapping, scrolling, and every
    /// cursor-moving escape are already accounted for.
    /// Record `url` on the cell at (`row`, `col`), which currently holds `ch`.
    pub fn mark_cell(&mut self, row: u32, col: u32, url: &Arc<str>, ch: &str) {
        if self.viewport_height > 0 && row >= self.viewport_height {
            return;
        }
        self.cell_urls.insert(
            (row, col),
            CellMark {
                url: Arc::clone(url),
                ch: ch.to_string(),
            },
        );
    }

    /// Record an OSC 66 sized cell at `(row, col)` (and `(row + 1, col)` when `mirror_bottom` is true).
    pub fn mark_sized_cell(
        &mut self,
        row: u32,
        col: u32,
        size: crate::CellSize,
        ch: &str,
        mirror_bottom: bool,
    ) {
        if self.viewport_height == 0 || row < self.viewport_height {
            self.sized_cells.insert(
                (row, col),
                SizedMark {
                    size,
                    ch: ch.to_string(),
                },
            );
        }
        if mirror_bottom && (self.viewport_height == 0 || row + 1 < self.viewport_height) {
            self.sized_cells.insert(
                (row + 1, col),
                SizedMark {
                    size: crate::CellSize::DoubleHeightBottom,
                    ch: ch.to_string(),
                },
            );
        }
    }

    /// Drop every cell mark, keeping the open-hyperlink state. Used when the
    /// grid the marks referred to is replaced wholesale (alternate screen).
    pub fn clear_cells(&mut self) {
        self.cell_urls.clear();
        self.sized_cells.clear();
    }

    /// Return valid OSC 66 `(CellSize, &str)` marks for `row`.
    pub fn row_sizes<'a>(
        &'a self,
        row: u32,
        chars: &[String],
        prev_chars: &[String],
    ) -> Vec<Option<(crate::CellSize, &'a str)>> {
        let mut out = vec![None; chars.len()];
        if self.sized_cells.is_empty() {
            return out;
        }
        for (col, slot) in out.iter_mut().enumerate() {
            let Some(mark) = self.sized_cells.get(&(row, col as u32)) else {
                continue;
            };
            let valid = if mark.size == crate::CellSize::DoubleHeightBottom {
                (chars[col] == " " || chars[col] == mark.ch)
                    && prev_chars.get(col).is_some_and(|up| *up == mark.ch)
            } else {
                chars[col] == mark.ch
            };
            if valid {
                *slot = Some((mark.size, mark.ch.as_str()));
            }
        }
        out
    }

    /// The hyperlink on each column of `row`, with stale marks dropped.
    ///
    /// `chars` is the row as it stands now, one entry per column, normalised
    /// the way [`crate::screen_cell_char`] normalises it.
    ///
    /// A run of adjacent cells carrying the same URL was written as one label,
    /// so it is validated as one: if any character under it has changed since
    /// it was written, the whole run goes. Anything less leaves a link on the
    /// cells a redraw happened to fill with the same character — and anything
    /// per-cell-only would keep a stray underline under each of them.
    ///
    /// This is the only way out of the map. Reading it by coordinate alone is
    /// what put a long underline over unrelated text in an application that
    /// repaints in place (Claude Code, vim, htop): the link's coordinates
    /// outlived the link's text.
    pub fn row_urls(&self, row: u32, chars: &[String]) -> Vec<Option<&str>> {
        let mut out: Vec<Option<&str>> = vec![None; chars.len()];
        if self.cell_urls.is_empty() {
            return out;
        }
        let mark_at = |col: usize| self.cell_urls.get(&(row, col as u32));
        let mut col = 0usize;
        while col < chars.len() {
            let Some(mark) = mark_at(col) else {
                col += 1;
                continue;
            };
            let mut end = col + 1;
            while end < chars.len() && mark_at(end).is_some_and(|m| m.url == mark.url) {
                end += 1;
            }
            let intact = (col..end).all(|c| mark_at(c).is_some_and(|m| m.ch == chars[c]));
            if intact {
                for slot in out[col..end].iter_mut() {
                    *slot = Some(&*mark.url);
                }
            }
            col = end;
        }
        out
    }

    /// The URL currently open, if the stream is inside an OSC 8 pair.
    pub fn active_url(&self) -> Option<&Arc<str>> {
        self.active_hyperlink.as_ref().map(|(url, _)| url)
    }

    /// Process raw output bytes, extracting OSC sequences.
    ///
    /// Returns the bytes with OSC sequences removed (for vt100) plus the ranges
    /// within them that were written while a hyperlink was open. The caller
    /// feeds those ranges to vt100 a character at a time and marks the cells
    /// vt100 reports — see `PaneState::process_output`.
    pub fn process(&mut self, content: &[u8]) -> OscOutput {
        // Prepend any incomplete OSC sequence carried over from the last chunk.
        let buffered;
        let content: &[u8] = if self.pending.is_empty() {
            content
        } else {
            self.pending.extend_from_slice(content);
            buffered = std::mem::take(&mut self.pending);
            &buffered
        };

        let mut out = OscOutput {
            bytes: Vec::with_capacity(content.len()),
            links: Vec::new(),
            sized: Vec::new(),
        };
        // Offset in `out.bytes` where the open hyperlink started. A link still
        // open at the end of a chunk closes at that end and reopens at 0 in the
        // next call, so a hyperlink split across `%output` chunks survives.
        let mut open_at: Option<usize> = self.active_hyperlink.as_ref().map(|_| 0);
        let mut i = 0;

        while i < content.len() {
            // Check for ESC sequence start
            if content[i] == 0x1B && i + 1 < content.len() && content[i + 1] == b']' {
                // OSC sequence: ESC ] ... ST or ESC ] ... BEL
                match self.find_osc_end(&content[i..]) {
                    Some((osc_end, osc_content)) => {
                        if let Some(rest) = osc_content.strip_prefix(b"66;") {
                            helpers::emit_osc66(rest, &mut out);
                            i += osc_end;
                            continue;
                        }
                        let before = self.active_url().cloned();
                        self.parse_osc(osc_content);
                        let after = self.active_url().cloned();
                        if before != after {
                            let here = out.bytes.len();
                            if let (Some(start), Some(url)) = (open_at.take(), before) {
                                push_link(&mut out.links, start, here, url);
                            }
                            open_at = after.map(|_| here);
                        }
                        i += osc_end;
                        continue;
                    }
                    None => {
                        // Terminator not in this chunk — the sequence is split.
                        // Buffer the tail and resume next call rather than
                        // pushing the raw ESC ] bytes into the vt100 stream
                        // (which renders the header as garbage).
                        let tail = &content[i..];
                        if tail.len() <= MAX_PENDING_OSC {
                            self.pending.extend_from_slice(tail);
                            break;
                        }
                        // Malformed / oversized: fall through and emit as-is.
                    }
                }
            }

            out.bytes.push(content[i]);
            i += 1;
        }

        let here = out.bytes.len();
        if let (Some(start), Some(url)) = (open_at, self.active_url().cloned()) {
            push_link(&mut out.links, start, here, url);
        }

        out
    }

    /// Find the end of an OSC sequence starting at the given position
    /// Returns (length including terminator, content slice)
    fn find_osc_end<'a>(&self, content: &'a [u8]) -> Option<(usize, &'a [u8])> {
        if content.len() < 2 || content[0] != 0x1B || content[1] != b']' {
            return None;
        }
        // Delegate the terminator scan to the shared implementation in
        // `images.rs`; offsets are body-relative there, so shift by the
        // 2-byte `ESC ]` prefix this method consumed.
        super::images::find_osc_end(&content[2..]).map(|(consumed, body)| (consumed + 2, body))
    }

    /// Parse an OSC sequence content
    fn parse_osc(&mut self, content: &[u8]) {
        let content_str = String::from_utf8_lossy(content);

        // OSC 8 (Hyperlinks): 8 ; params ; url
        if let Some(rest) = content_str.strip_prefix("8;") {
            self.parse_osc8(rest);
            return;
        }

        // OSC 52 (Clipboard): 52 ; Pc ; Pd
        if let Some(rest) = content_str.strip_prefix("52;") {
            self.parse_osc52(rest);
            return;
        }

        // OSC 0 (icon + title) and OSC 2 (title). OSC 1 is the icon name only
        // and is deliberately ignored — it is not what a window is called.
        for prefix in ["0;", "2;"] {
            if let Some(title) = content_str.strip_prefix(prefix) {
                self.pending_title = Some(title.to_string());
                return;
            }
        }
    }

    /// Parse OSC 8 hyperlink sequence
    /// Format: 8 ; params ; url (to start) or 8 ; ; (to end)
    fn parse_osc8(&mut self, content: &str) {
        let parts: Vec<&str> = content.splitn(2, ';').collect();
        if parts.len() < 2 {
            return;
        }

        let params = parts[0];
        let url = parts[1];

        if url.is_empty() || url.len() > MAX_HYPERLINK_URL_BYTES {
            // End of hyperlink — or one too long to be honoured, which closes
            // whatever was open and opens nothing.
            self.active_hyperlink = None;
        } else {
            // Start of hyperlink. Parse optional id from params (id=value).
            let id = params
                .split(':')
                .find_map(|p| p.strip_prefix("id=").map(|v| v.to_string()));
            self.active_hyperlink = Some((Arc::from(url), id));
        }
    }

    /// Parse OSC 52 clipboard sequence
    /// Format: Pc ; Pd where Pd is base64-encoded
    fn parse_osc52(&mut self, content: &str) {
        let parts: Vec<&str> = content.splitn(2, ';').collect();
        if parts.len() < 2 {
            return;
        }

        // Pc is clipboard selection (c = primary, p = clipboard, etc.)
        // We treat all selections the same
        let base64_data = parts[1];

        // Decode base64
        if let Ok(decoded) = helpers::base64_decode(base64_data) {
            if let Ok(text) = String::from_utf8(decoded) {
                self.pending_clipboard = Some(text);
            }
        }
    }

    /// Take pending clipboard content (clears it)
    pub fn take_clipboard(&mut self) -> Option<String> {
        self.pending_clipboard.take()
    }

    /// Take the pending pane title (clears it).
    pub fn take_title(&mut self) -> Option<String> {
        self.pending_title.take()
    }
}

mod helpers;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
