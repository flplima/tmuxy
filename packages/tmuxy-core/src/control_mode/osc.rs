//! OSC (Operating System Command) sequence parser for terminal protocols
//!
//! Parses OSC sequences from raw terminal output:
//! - OSC 8: Hyperlinks (URL associations per text region)
//! - OSC 52: Clipboard operations

use std::collections::HashMap;

/// Upper bound on a buffered incomplete OSC sequence carried across `process()`
/// calls. tmux emits `%output` in bounded chunks and a real OSC (hyperlink URL,
/// OSC 52 clipboard) completes well within this; if we somehow accumulate more
/// without a terminator the stream is malformed, so we flush rather than grow
/// without bound.
const MAX_PENDING_OSC: usize = 64 * 1024;

/// Bytes destined for vt100, plus the hyperlink spans inside them.
#[derive(Debug, Default)]
pub struct OscOutput {
    /// The input with OSC sequences stripped out.
    pub bytes: Vec<u8>,
    /// `(start, end, url)` half-open ranges into `bytes`, in order and
    /// non-overlapping, that were emitted while an OSC 8 link was open.
    pub links: Vec<(usize, usize, String)>,
}

fn push_link(links: &mut Vec<(usize, usize, String)>, start: usize, end: usize, url: String) {
    if end > start {
        links.push((start, end, url));
    }
}

/// OSC parser state for a single pane
#[derive(Debug, Default)]
pub struct OscParser {
    /// Active hyperlink (URL currently being applied to output)
    active_hyperlink: Option<(String, Option<String>)>, // (url, id)
    /// Visible height of the pane, in rows. Bounds `cell_urls` to the screen:
    /// a mark shifted above row 0 by scrolling is dropped.
    viewport_height: u32,
    /// Pending clipboard content (from OSC 52)
    pub pending_clipboard: Option<String>,
    /// Hyperlink URL per cell coordinate: (row, col) -> url.
    ///
    /// Written by the caller via [`OscParser::mark_cell`] once vt100 has told
    /// it where a byte actually landed — this parser deliberately keeps no
    /// cursor of its own. It used to, advancing on `\n` / `\r` / printable
    /// ASCII only, which made it blind to every CSI cursor movement (most of
    /// what a shell prompt emits) and drifted the whole map off the text.
    pub cell_urls: HashMap<(u32, u32), String>,
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
        if rows == 0 || self.cell_urls.is_empty() {
            return;
        }
        self.cell_urls = self
            .cell_urls
            .drain()
            .filter_map(|((row, col), url)| row.checked_sub(rows).map(|r| ((r, col), url)))
            .collect();
    }

    /// Shift every mark down by `rows`, dropping what falls off the bottom.
    /// The reverse-scroll counterpart of [`shift_rows_up`].
    pub fn shift_rows_down(&mut self, rows: u32) {
        if rows == 0 || self.cell_urls.is_empty() {
            return;
        }
        let height = self.viewport_height;
        self.cell_urls = self
            .cell_urls
            .drain()
            .map(|((row, col), url)| ((row + rows, col), url))
            .filter(|((row, _), _)| height == 0 || *row < height)
            .collect();
    }

    /// Record that the cell at `(row, col)` carries `url`. Called once vt100
    /// has been asked where the byte landed, so wrapping, scrolling, and every
    /// cursor-moving escape are already accounted for.
    pub fn mark_cell(&mut self, row: u32, col: u32, url: &str) {
        if self.viewport_height > 0 && row >= self.viewport_height {
            return;
        }
        self.cell_urls.insert((row, col), url.to_string());
    }

    /// Drop every cell mark, keeping the open-hyperlink state. Used when the
    /// grid the marks referred to is replaced wholesale (alternate screen).
    pub fn clear_cells(&mut self) {
        self.cell_urls.clear();
    }

    /// The URL currently open, if the stream is inside an OSC 8 pair.
    pub fn active_url(&self) -> Option<&str> {
        self.active_hyperlink.as_ref().map(|(url, _)| url.as_str())
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
                        let before = self.active_url().map(str::to_string);
                        self.parse_osc(osc_content);
                        let after = self.active_url().map(str::to_string);
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
        if let (Some(start), Some(url)) = (open_at, self.active_url().map(str::to_string)) {
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

        if url.is_empty() {
            // End of hyperlink
            self.active_hyperlink = None;
        } else {
            // Start of hyperlink. Parse optional id from params (id=value).
            let id = params
                .split(':')
                .find_map(|p| p.strip_prefix("id=").map(|v| v.to_string()));
            self.active_hyperlink = Some((url.to_string(), id));
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
        if let Ok(decoded) = base64_decode(base64_data) {
            if let Ok(text) = String::from_utf8(decoded) {
                self.pending_clipboard = Some(text);
            }
        }
    }

    /// Get URL for a specific cell coordinate
    pub fn get_url(&self, row: u32, col: u32) -> Option<&String> {
        self.cell_urls.get(&(row, col))
    }

    /// Take pending clipboard content (clears it)
    pub fn take_clipboard(&mut self) -> Option<String> {
        self.pending_clipboard.take()
    }
}

/// Simple base64 decoder (standard alphabet)
fn base64_decode(input: &str) -> Result<Vec<u8>, &'static str> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut output = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;

    for c in input.bytes() {
        if c == b'=' {
            // Padding
            break;
        }
        if c == b'\n' || c == b'\r' || c == b' ' {
            // Skip whitespace
            continue;
        }

        let value = match ALPHABET.iter().position(|&x| x == c) {
            Some(v) => v as u32,
            None => return Err("Invalid base64 character"),
        };

        buffer = (buffer << 6) | value;
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(output)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn osc8_strips_the_escapes_and_reports_the_linked_span() {
        let mut parser = OscParser::new();

        let input = b"\x1b]8;;https://example.com\x07hello\x1b]8;;\x07";
        let out = parser.process(input);

        // Output has the OSC sequences stripped...
        assert_eq!(out.bytes, b"hello");
        // ...and the caller is told exactly which of those bytes were linked,
        // so it can ask vt100 where they landed. This parser maps no cells
        // itself — it has no cursor to map them with.
        assert_eq!(out.links, vec![(0, 5, "https://example.com".to_string())]);
    }

    #[test]
    fn text_outside_the_link_is_not_in_the_span() {
        let mut parser = OscParser::new();
        let out = parser.process(b"before\x1b]8;;http://x\x07IN\x1b]8;;\x07after");
        assert_eq!(out.bytes, b"beforeINafter");
        assert_eq!(out.links, vec![(6, 8, "http://x".to_string())]);
    }

    #[test]
    fn two_links_in_one_chunk_get_one_span_each() {
        let mut parser = OscParser::new();
        let out =
            parser.process(b"\x1b]8;;http://a\x07A\x1b]8;;\x07 \x1b]8;;http://b\x07B\x1b]8;;\x07");
        assert_eq!(out.bytes, b"A B");
        assert_eq!(
            out.links,
            vec![
                (0, 1, "http://a".to_string()),
                (2, 3, "http://b".to_string()),
            ]
        );
    }

    #[test]
    fn a_link_left_open_spans_to_the_end_of_the_chunk_and_resumes() {
        let mut parser = OscParser::new();
        // Link opened but not closed before the chunk ends.
        let first = parser.process(b"\x1b]8;;http://x\x07AB");
        assert_eq!(first.bytes, b"AB");
        assert_eq!(first.links, vec![(0, 2, "http://x".to_string())]);

        // Still open: the next chunk's bytes are linked from offset 0.
        let second = parser.process(b"CD\x1b]8;;\x07EF");
        assert_eq!(second.bytes, b"CDEF");
        assert_eq!(second.links, vec![(0, 2, "http://x".to_string())]);
    }

    #[test]
    fn shift_rows_up_moves_marks_and_drops_what_scrolls_off() {
        let mut parser = OscParser::new();
        parser.set_viewport_height(3);
        parser.mark_cell(0, 0, "http://gone");
        parser.mark_cell(2, 1, "http://kept");

        parser.shift_rows_up(1);

        assert_eq!(parser.get_url(0, 0), None);
        assert_eq!(parser.get_url(1, 1), Some(&"http://kept".to_string()));
    }

    #[test]
    fn marks_past_the_bottom_row_are_refused() {
        let mut parser = OscParser::new();
        parser.set_viewport_height(3);
        parser.mark_cell(3, 0, "http://offscreen");
        assert!(parser.cell_urls.is_empty());
    }

    #[test]
    fn osc_sequence_split_across_chunks_is_not_torn() {
        let mut parser = OscParser::new();
        // The hyperlink start sequence is cut mid-URL between two process() calls.
        let out1 = parser.process(b"\x1b]8;;https://exa");
        // Nothing emitted yet — the incomplete escape is buffered, not leaked.
        assert!(out1.bytes.is_empty());
        let out2 = parser.process(b"mple.com\x07hi\x1b]8;;\x07");
        assert_eq!(out2.bytes, b"hi");
        assert_eq!(out2.links, vec![(0, 2, "https://example.com".to_string())]);
    }

    #[test]
    fn test_osc52_clipboard() {
        let mut parser = OscParser::new();

        // OSC 52 with base64-encoded "hello"
        let input = b"\x1b]52;c;aGVsbG8=\x07";
        let _ = parser.process(input);

        assert_eq!(parser.take_clipboard(), Some("hello".to_string()));
    }

    #[test]
    fn test_base64_decode() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("dGVzdA==").unwrap(), b"test");
    }
}
