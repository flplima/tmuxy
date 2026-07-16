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

/// OSC parser state for a single pane
#[derive(Debug, Default)]
pub struct OscParser {
    /// Active hyperlink (URL currently being applied to output)
    active_hyperlink: Option<(String, Option<String>)>, // (url, id)
    /// Current cursor position (tracked for hyperlink cell mapping). `cursor_row`
    /// is screen-relative: it scrolls with the viewport so it stays aligned with
    /// the vt100 rows `extract_cells_with_urls` queries.
    cursor_row: u32,
    cursor_col: u32,
    /// Visible height of the pane, in rows. Used to scroll `cell_urls` when
    /// output pushes the cursor past the bottom row, keeping the map aligned
    /// with the vt100 screen and bounded to the viewport.
    viewport_height: u32,
    /// Pending clipboard content (from OSC 52)
    pub pending_clipboard: Option<String>,
    /// Hyperlink URL per cell coordinate: (row, col) -> url
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
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.pending_clipboard = None;
        self.cell_urls.clear();
        self.pending.clear();
    }

    /// Set the pane's visible height (rows). Enables scroll-compensation of the
    /// cell→URL map so hyperlinks keep working past the first screenful.
    pub fn set_viewport_height(&mut self, height: u32) {
        self.viewport_height = height;
    }

    /// Scroll the cell→URL map up by one row: row 0 falls off, every other row
    /// shifts up one. Mirrors what the vt100 screen does when output overflows
    /// the bottom, keeping `cell_urls` aligned with visible rows and bounded.
    fn scroll_up(&mut self) {
        self.cell_urls = self
            .cell_urls
            .drain()
            .filter_map(|((row, col), url)| (row > 0).then(|| ((row - 1, col), url)))
            .collect();
    }

    /// Process raw output bytes, extracting OSC sequences
    /// Returns bytes with OSC sequences removed for vt100 processing
    pub fn process(&mut self, content: &[u8]) -> Vec<u8> {
        // Prepend any incomplete OSC sequence carried over from the last chunk.
        let buffered;
        let content: &[u8] = if self.pending.is_empty() {
            content
        } else {
            self.pending.extend_from_slice(content);
            buffered = std::mem::take(&mut self.pending);
            &buffered
        };

        let mut output = Vec::with_capacity(content.len());
        let mut i = 0;

        while i < content.len() {
            // Check for ESC sequence start
            if content[i] == 0x1B && i + 1 < content.len() && content[i + 1] == b']' {
                // OSC sequence: ESC ] ... ST or ESC ] ... BEL
                match self.find_osc_end(&content[i..]) {
                    Some((osc_end, osc_content)) => {
                        self.parse_osc(osc_content);
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

            // Track cursor movement for hyperlink cell mapping
            // Note: vt100 handles actual cursor positioning, we just track for URL mapping
            if content[i] == b'\n' {
                // Newline advances the row; scroll the map when it would pass the
                // bottom visible row so mappings stay aligned with vt100 rows.
                self.cursor_row += 1;
                if self.viewport_height > 0 && self.cursor_row >= self.viewport_height {
                    self.scroll_up();
                    self.cursor_row = self.viewport_height - 1;
                }
                self.cursor_col = 0;
            } else if content[i] == b'\r' {
                // Carriage return resets column
                self.cursor_col = 0;
            } else if content[i] >= 0x20 && content[i] < 0x7F {
                // Printable character - map URL if active hyperlink
                if let Some((ref url, _)) = self.active_hyperlink {
                    self.cell_urls
                        .insert((self.cursor_row, self.cursor_col), url.clone());
                }
                self.cursor_col += 1;
            }

            output.push(content[i]);
            i += 1;
        }

        output
    }

    /// Find the end of an OSC sequence starting at the given position
    /// Returns (length including terminator, content slice)
    fn find_osc_end<'a>(&self, content: &'a [u8]) -> Option<(usize, &'a [u8])> {
        if content.len() < 2 || content[0] != 0x1B || content[1] != b']' {
            return None;
        }

        let start = 2; // Skip ESC ]
        for i in start..content.len() {
            // ST (String Terminator): ESC \
            if i + 1 < content.len() && content[i] == 0x1B && content[i + 1] == b'\\' {
                return Some((i + 2, &content[start..i]));
            }
            // BEL (alternative terminator)
            if content[i] == 0x07 {
                return Some((i + 1, &content[start..i]));
            }
        }

        None
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
    fn test_osc8_hyperlink() {
        let mut parser = OscParser::new();

        // OSC 8 start with URL
        let input = b"\x1b]8;;https://example.com\x07hello\x1b]8;;\x07";
        let output = parser.process(input);

        // Output should have OSC sequences stripped
        assert_eq!(output, b"hello");

        // Should have URL mapped for "hello" characters (cols 0-4)
        assert_eq!(
            parser.get_url(0, 0),
            Some(&"https://example.com".to_string())
        );
        assert_eq!(
            parser.get_url(0, 4),
            Some(&"https://example.com".to_string())
        );
        assert_eq!(parser.get_url(0, 5), None);
    }

    #[test]
    fn hyperlink_still_maps_after_scrolling_past_a_screenful() {
        // Regression: cursor_row used to grow unbounded while the vt100 screen
        // scrolled, so URLs recorded past `height` never matched a screen row.
        let mut parser = OscParser::new();
        parser.set_viewport_height(3);

        // Fill more than the viewport with plain lines, then a hyperlink.
        let mut input = Vec::new();
        for _ in 0..10 {
            input.extend_from_slice(b"x\n");
        }
        input.extend_from_slice(b"\x1b]8;;https://example.com\x07link\x1b]8;;\x07");
        parser.process(&input);

        // The link lands on the bottom visible row (2), not row 10.
        assert_eq!(
            parser.get_url(2, 0),
            Some(&"https://example.com".to_string())
        );
        // cell_urls is bounded to the viewport, not the total output.
        assert!(parser.cell_urls.keys().all(|(r, _)| *r < 3));
    }

    #[test]
    fn osc_sequence_split_across_chunks_is_not_torn() {
        let mut parser = OscParser::new();
        // The hyperlink start sequence is cut mid-URL between two process() calls.
        let out1 = parser.process(b"\x1b]8;;https://exa");
        // Nothing emitted yet — the incomplete escape is buffered, not leaked.
        assert!(out1.is_empty());
        let out2 = parser.process(b"mple.com\x07hi\x1b]8;;\x07");
        assert_eq!(out2, b"hi");
        assert_eq!(
            parser.get_url(0, 0),
            Some(&"https://example.com".to_string())
        );
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
