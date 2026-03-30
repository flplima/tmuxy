//! Terminal image protocol support
//!
//! Intercepts image sequences from raw terminal output before they reach vt100:
//! - iTerm2: ESC ] 1337 ; File=<args> : <base64> BEL/ST
//! - Sixel: ESC P <params> q <data> ESC \  (future)
//!
//! Images are stored in an LRU cache keyed by (pane_id, image_id).
//! The frontend fetches image blobs via a separate HTTP endpoint.

use serde::{Deserialize, Serialize};

/// Image protocol that produced this image
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageProtocol {
    ITerm2,
    Sixel,
}

/// An image placement on the terminal grid
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImagePlacement {
    /// Unique image ID (auto-incremented or from protocol)
    pub id: u32,
    /// Row where the image starts (0-indexed, screen-relative)
    pub row: u16,
    /// Column where the image starts (0-indexed)
    pub col: u16,
    /// Width in terminal cells
    pub width_cells: u16,
    /// Height in terminal cells
    pub height_cells: u16,
    /// Which protocol produced this image
    pub protocol: ImageProtocol,
}

/// Stored image blob
#[derive(Debug, Clone)]
pub struct StoredImage {
    /// Raw image data (PNG, JPEG, GIF, etc.)
    pub data: Vec<u8>,
    /// MIME type (e.g., "image/png")
    pub mime_type: String,
}

/// Per-pane image parser state
#[derive(Debug, Default)]
pub struct ImageParser {
    /// Next auto-assigned image ID
    next_id: u32,
    /// Active image placements on the current screen
    pub placements: Vec<ImagePlacement>,
    /// Current cursor position (tracked for placement)
    cursor_row: u16,
    cursor_col: u16,
}

/// Result of processing raw output through the image parser
pub struct ImageProcessResult {
    /// Bytes with image sequences stripped (for vt100)
    pub clean_bytes: Vec<u8>,
    /// Newly completed images to store
    pub new_images: Vec<(u32, StoredImage)>,
}

impl ImageParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reset state (e.g., on pane resize or full refresh)
    pub fn reset(&mut self) {
        self.placements.clear();
        self.cursor_row = 0;
        self.cursor_col = 0;
    }

    /// Update cursor position
    pub fn update_cursor(&mut self, row: u16, col: u16) {
        self.cursor_row = row;
        self.cursor_col = col;
    }

    /// Process raw output bytes, extracting image sequences.
    /// Returns cleaned bytes (image sequences stripped) and any newly completed images.
    pub fn process(&mut self, content: &[u8]) -> ImageProcessResult {
        let mut output = Vec::with_capacity(content.len());
        let mut new_images = Vec::new();
        let mut i = 0;

        while i < content.len() {
            // iTerm2: ESC ] 1337 ; File= ...
            if i + 2 < content.len() && content[i] == 0x1B && content[i + 1] == b']' {
                if let Some((consumed, image)) = self.try_parse_iterm2(&content[i..]) {
                    if let Some((id, stored)) = image {
                        new_images.push((id, stored));
                    }
                    i += consumed;
                    continue;
                }
            }

            // Sixel: ESC P ... q ... ESC \
            if i + 2 < content.len() && content[i] == 0x1B && content[i + 1] == b'P' {
                if let Some((consumed, image)) = self.try_parse_sixel(&content[i..]) {
                    if let Some((id, stored)) = image {
                        new_images.push((id, stored));
                    }
                    i += consumed;
                    continue;
                }
            }

            output.push(content[i]);
            i += 1;
        }

        ImageProcessResult {
            clean_bytes: output,
            new_images,
        }
    }

    /// Try to parse an iTerm2 image sequence starting at position.
    /// Format: ESC ] 1337 ; File=<args> : <base64_data> BEL/ST
    /// Returns (bytes_consumed, Option<(image_id, StoredImage)>)
    fn try_parse_iterm2(&mut self, data: &[u8]) -> Option<(usize, Option<(u32, StoredImage)>)> {
        // Must start with ESC ] 1337 ;
        let prefix = b"\x1b]1337;";
        if data.len() < prefix.len() || &data[..prefix.len()] != prefix {
            return None;
        }

        // Find the terminator (BEL or ESC \)
        let (end, content) = find_osc_end(&data[2..])?; // skip ESC ]
        let end = end + 2; // adjust for skipped ESC ]

        let content_str = String::from_utf8_lossy(content);

        // Must be File= command
        if !content_str.starts_with("1337;File=") {
            return Some((end, None)); // Consume but ignore non-file OSC 1337
        }

        let file_part = &content_str["1337;File=".len()..];

        // Split args:base64 at the colon
        let colon_pos = file_part.find(':')?;
        let args_str = &file_part[..colon_pos];
        let base64_data = &file_part[colon_pos + 1..];

        // Parse args
        let mut width_cells: u16 = 0;
        let mut height_cells: u16 = 0;
        let mut inline = false;
        let mut _name = String::new();

        for arg in args_str.split(';') {
            if let Some(val) = arg.strip_prefix("width=") {
                // Could be cells, pixels, or percentage
                if let Ok(n) = val.replace("px", "").parse::<u16>() {
                    width_cells = if val.contains("px") {
                        // Approximate: assume ~8px per cell
                        (n / 8).max(1)
                    } else {
                        n
                    };
                }
            } else if let Some(val) = arg.strip_prefix("height=") {
                if let Ok(n) = val.replace("px", "").parse::<u16>() {
                    height_cells = if val.contains("px") {
                        (n / 16).max(1)
                    } else {
                        n
                    };
                }
            } else if arg == "inline=1" {
                inline = true;
            } else if let Some(val) = arg.strip_prefix("name=") {
                _name = String::from_utf8_lossy(&base64_decode_simple(val)).to_string();
            }
        }

        if !inline {
            return Some((end, None)); // Not inline, ignore (file download)
        }

        // Decode base64 image data
        let decoded = match base64_decode_simple(base64_data) {
            data if data.is_empty() => return Some((end, None)),
            data => data,
        };

        // Detect MIME type from magic bytes
        let mime_type = detect_mime_type(&decoded);

        // Default dimensions if not specified
        if width_cells == 0 {
            width_cells = 40; // reasonable default
        }
        if height_cells == 0 {
            height_cells = 20;
        }

        let id = self.next_id;
        self.next_id += 1;

        self.placements.push(ImagePlacement {
            id,
            row: self.cursor_row,
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::ITerm2,
        });

        let stored = StoredImage {
            data: decoded,
            mime_type,
        };

        Some((end, Some((id, stored))))
    }

    /// Try to parse a Sixel sequence.
    /// Format: ESC P <params> q <sixel_data> ESC \
    fn try_parse_sixel(&mut self, data: &[u8]) -> Option<(usize, Option<(u32, StoredImage)>)> {
        // Must start with ESC P
        if data.len() < 3 || data[0] != 0x1B || data[1] != b'P' {
            return None;
        }

        // Find ESC \ terminator
        let mut end = 2;
        while end + 1 < data.len() {
            if data[end] == 0x1B && data[end + 1] == b'\\' {
                break;
            }
            end += 1;
        }
        if end + 1 >= data.len() {
            return None; // Incomplete
        }
        let consumed = end + 2;

        // Check for 'q' which starts sixel data
        let content = &data[2..end];
        if !content.contains(&b'q') {
            return Some((consumed, None)); // Not a sixel image
        }

        // TODO: Sixel decoding is complex (palette-based raster).
        // For now, consume and discard. Future: convert sixel → PNG in Rust.
        Some((consumed, None))
    }
}

/// Find the end of an OSC sequence (BEL or ESC \)
/// Input starts after ESC ] (i.e., content[0] is first byte after ])
/// Returns (bytes consumed from input including terminator, content slice)
fn find_osc_end(content: &[u8]) -> Option<(usize, &[u8])> {
    for i in 0..content.len() {
        if content[i] == 0x07 {
            // BEL
            return Some((i + 1, &content[..i]));
        }
        if i + 1 < content.len() && content[i] == 0x1B && content[i + 1] == b'\\' {
            return Some((i + 2, &content[..i]));
        }
    }
    None
}

/// Simple base64 decoder
fn base64_decode_simple(input: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut output = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;

    for c in input.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' {
            if c == b'=' {
                break;
            }
            continue;
        }
        let value = match ALPHABET.iter().position(|&x| x == c) {
            Some(v) => v as u32,
            None => continue, // skip invalid chars
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    output
}

/// Detect MIME type from magic bytes
fn detect_mime_type(data: &[u8]) -> String {
    if data.starts_with(b"\x89PNG") {
        "image/png".to_string()
    } else if data.starts_with(b"\xFF\xD8\xFF") {
        "image/jpeg".to_string()
    } else if data.starts_with(b"GIF8") {
        "image/gif".to_string()
    } else if data.starts_with(b"RIFF") && data.len() > 12 && &data[8..12] == b"WEBP" {
        "image/webp".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_iterm2_inline_image() {
        let mut parser = ImageParser::new();

        // Minimal iTerm2 inline image (1x1 red pixel PNG as fake base64)
        let b64_data = "iVBORw0KGgo="; // truncated PNG header
        let input = format!("\x1b]1337;File=inline=1;width=10;height=5:{}\x07", b64_data);

        let result = parser.process(input.as_bytes());

        // Image sequence should be stripped from output
        assert!(result.clean_bytes.is_empty());

        // Should have one placement
        assert_eq!(parser.placements.len(), 1);
        assert_eq!(parser.placements[0].width_cells, 10);
        assert_eq!(parser.placements[0].height_cells, 5);
        assert_eq!(parser.placements[0].protocol, ImageProtocol::ITerm2);

        // Should have produced one stored image
        assert_eq!(result.new_images.len(), 1);
    }

    #[test]
    fn test_iterm2_not_inline() {
        let mut parser = ImageParser::new();

        // File download (no inline=1), should be consumed but no image stored
        let input = b"\x1b]1337;File=name=dGVzdA==:AAAA\x07";
        let result = parser.process(input);

        assert!(result.clean_bytes.is_empty());
        assert!(parser.placements.is_empty());
        assert!(result.new_images.is_empty());
    }

    #[test]
    fn test_mixed_content() {
        let mut parser = ImageParser::new();

        // Normal text + iTerm2 image + more text
        let input = b"Hello \x1b]1337;File=inline=1;width=5;height=3:AAAA\x07 World";
        let result = parser.process(input);

        // Only text should remain
        assert_eq!(result.clean_bytes, b"Hello  World");
        assert_eq!(parser.placements.len(), 1);
    }

    #[test]
    fn test_detect_mime() {
        assert_eq!(detect_mime_type(b"\x89PNG\r\n\x1a\n"), "image/png");
        assert_eq!(detect_mime_type(b"\xFF\xD8\xFF\xE0"), "image/jpeg");
        assert_eq!(detect_mime_type(b"GIF89a"), "image/gif");
        assert_eq!(detect_mime_type(b"unknown"), "application/octet-stream");
    }
}
