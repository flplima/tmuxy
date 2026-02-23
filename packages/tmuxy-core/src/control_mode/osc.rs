//! OSC (Operating System Command) sequence parser for terminal protocols
//!
//! Parses OSC sequences from raw terminal output:
//! - OSC 8: Hyperlinks (URL associations per text region)
//! - OSC 52: Clipboard operations

use std::collections::HashMap;

/// Parsed OSC 8 hyperlink region
#[derive(Debug, Clone)]
pub struct HyperlinkRegion {
    /// Row where hyperlink starts (0-indexed)
    pub start_row: u32,
    /// Column where hyperlink starts (0-indexed)
    pub start_col: u32,
    /// Row where hyperlink ends (0-indexed)
    pub end_row: u32,
    /// Column where hyperlink ends (0-indexed)
    pub end_col: u32,
    /// The URL for this hyperlink
    pub url: String,
    /// Optional ID for linking split regions
    pub id: Option<String>,
}

/// OSC parser state for a single pane
#[derive(Debug, Default)]
pub struct OscParser {
    /// Active hyperlink (URL currently being applied to output)
    active_hyperlink: Option<(String, Option<String>)>, // (url, id)
    /// Start position of active hyperlink
    hyperlink_start: Option<(u32, u32)>, // (row, col)
    /// Current cursor position (tracked for hyperlink regions)
    cursor_row: u32,
    cursor_col: u32,
    /// Collected hyperlink regions
    pub hyperlinks: Vec<HyperlinkRegion>,
    /// Pending clipboard content (from OSC 52)
    pub pending_clipboard: Option<String>,
    /// Hyperlink URL per cell coordinate: (row, col) -> url
    pub cell_urls: HashMap<(u32, u32), String>,
}

impl OscParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reset parser state (e.g., on pane resize or full refresh)
    pub fn reset(&mut self) {
        self.active_hyperlink = None;
        self.hyperlink_start = None;
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.hyperlinks.clear();
        self.pending_clipboard = None;
        self.cell_urls.clear();
    }

    /// Update cursor position (call when vt100 cursor moves)
    pub fn update_cursor(&mut self, row: u32, col: u32) {
        self.cursor_row = row;
        self.cursor_col = col;
    }

    /// Process raw output bytes, extracting OSC sequences
    /// Returns bytes with OSC sequences removed for vt100 processing
    pub fn process(&mut self, content: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(content.len());
        let mut i = 0;

        while i < content.len() {
            // Check for ESC sequence start
            if content[i] == 0x1B && i + 1 < content.len() && content[i + 1] == b']' {
                // OSC sequence: ESC ] ... ST or ESC ] ... BEL
                if let Some((osc_end, osc_content)) = self.find_osc_end(&content[i..]) {
                    self.parse_osc(osc_content);
                    i += osc_end;
                    continue;
                }
            }

            // Track cursor movement for hyperlink cell mapping
            // Note: vt100 handles actual cursor positioning, we just track for URL mapping
            if content[i] == b'\n' {
                // Newline advances row
                self.finalize_hyperlink_line();
                self.cursor_row += 1;
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
            self.finalize_hyperlink();
        } else {
            // Start of hyperlink
            // Parse optional id from params (id=value)
            let id = params
                .split(':')
                .find_map(|p| p.strip_prefix("id=").map(|v| v.to_string()));

            // Close any existing hyperlink first
            self.finalize_hyperlink();

            // Start new hyperlink
            self.active_hyperlink = Some((url.to_string(), id));
            self.hyperlink_start = Some((self.cursor_row, self.cursor_col));
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

    /// Finalize current hyperlink (called when hyperlink ends or at line boundary)
    fn finalize_hyperlink(&mut self) {
        if let (Some((url, id)), Some((start_row, start_col))) =
            (self.active_hyperlink.take(), self.hyperlink_start.take())
        {
            self.hyperlinks.push(HyperlinkRegion {
                start_row,
                start_col,
                end_row: self.cursor_row,
                end_col: self.cursor_col,
                url,
                id,
            });
        }
    }

    /// Called at line boundary to handle hyperlinks that span multiple lines
    fn finalize_hyperlink_line(&mut self) {
        // If we have an active hyperlink, we track it across lines via cell_urls
        // No special handling needed here since cell_urls persists
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
