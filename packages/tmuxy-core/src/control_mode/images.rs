//! Terminal image protocol support.
//!
//! Three protocols are intercepted from raw terminal output before the bytes
//! reach the vt100 emulator:
//!
//! - **iTerm2 Inline Images** — `ESC ] 1337 ; File=<args> : <base64> BEL/ST`
//! - **Kitty Graphics Protocol** — `ESC _ G<keys>;<base64-payload> ESC \`
//!   (APC sequence, supports chunked transfer via `m=1`/`m=0`)
//! - **Sixel** — `ESC P <params> q <sixel data> ESC \` (DCS), decoded to PNG
//!   via the `icy_sixel` pure-Rust decoder.
//!
//! Each parsed payload is stored as a `StoredImage` (PNG/JPEG/GIF bytes plus
//! mime type). An `ImagePlacement` records where on the terminal grid the
//! image should render. The frontend pulls the bytes via the HTTP image
//! handler keyed by `(pane_id, image_id)`.
//!
//! tmux **control mode** forwards passthrough sequences verbatim through
//! `%output`, so we get the original bytes here even when the user is inside
//! a tmux session (verified empirically — see docs/RICH-RENDERING.md).

mod kitty;
mod sixel_and_iterm;

use serde::{Deserialize, Serialize};
pub(super) use sixel_and_iterm::find_osc_end;
use sixel_and_iterm::{
    base64_decode, detect_mime_type, ends_with_cursor_home, has_escape_terminator,
    names_alternate_screen, overlaps, rgba_to_png, undouble_escapes,
};

// `std::time::Instant::now()` panics on wasm32; web-time backs it with
// performance.now() in the browser (the same arrangement as `state.rs`).
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
#[cfg(target_arch = "wasm32")]
use web_time::Instant;

/// Image protocol that produced this image.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageProtocol {
    ITerm2,
    Kitty,
    Sixel,
}

/// An image placement on the terminal grid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImagePlacement {
    /// Unique image ID (auto-incremented within this parser).
    pub id: u32,
    /// Row where the image starts (0-indexed, screen-relative).
    pub row: u16,
    /// Column where the image starts (0-indexed).
    pub col: u16,
    /// Width in terminal cells.
    pub width_cells: u16,
    /// Height in terminal cells.
    pub height_cells: u16,
    /// Which protocol produced this image.
    pub protocol: ImageProtocol,
    /// Fill the cells exactly instead of fitting inside them: iTerm2's
    /// `preserveAspectRatio=0`. A picture whose cells ARE its coordinate
    /// space (the browser pane maps a clicked cell to a page pixel) must not
    /// be letterboxed, or a click lands where the picture is not.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stretch: bool,
}

/// Stored image blob.
#[derive(Debug, Clone)]
pub struct StoredImage {
    /// Raw image data (PNG, JPEG, GIF, etc.).
    pub data: Vec<u8>,
    /// MIME type (e.g., "image/png").
    pub mime_type: String,
}

/// In-flight kitty chunked transfer (across multiple APC sequences).
///
/// Kitty splits large payloads into chunks with `m=1` (more) and `m=0` (last).
/// Subsequent chunks may omit metadata (other than `i=`/`m=`), so we cache the
/// first chunk's transmission keys on the entry.
#[derive(Debug)]
struct KittyChunked {
    /// When the transfer was opened; see `MAX_CHUNKED_AGE`.
    opened_at: Instant,
    /// Accumulated base64 payload (still encoded).
    payload: String,
    /// Image format (`f=`) from the first chunk: 32 = RGBA, 24 = RGB, 100 = PNG.
    format: u32,
    /// Source pixel width (`s=`).
    src_width: u32,
    /// Source pixel height (`v=`).
    src_height: u32,
    /// Display rows (`r=`) — 0 if unset.
    rows: u32,
    /// Display columns (`c=`) — 0 if unset.
    cols: u32,
}

/// Per-pane image parser state.
#[derive(Debug, Default)]
pub struct ImageParser {
    next_id: u32,
    /// Active image placements on the current screen.
    pub placements: Vec<ImagePlacement>,
    cursor_row: u16,
    cursor_col: u16,
    /// Kitty chunked transfers in progress, keyed by image id (`i=`).
    /// Single-chunk transfers (no `m=` key) bypass this map.
    kitty_chunks: std::collections::HashMap<u32, KittyChunked>,
    /// The order transfers were opened in, so the cap evicts the oldest.
    kitty_chunk_order: std::collections::VecDeque<u32>,
    /// An image escape (iTerm2/kitty/sixel) split across `%output` chunks,
    /// carried into the next `process()` call so a large payload isn't torn —
    /// its header rendered as garbage text and the image dropped.
    pending: Vec<u8>,
    /// The main screen's pictures, set aside while an application runs on the
    /// alternate screen (`Some` exactly while it does), and put back when it
    /// leaves — the way a terminal keeps the two screens apart.
    main_screen_placements: Option<Vec<ImagePlacement>>,
}

/// Upper bound on a buffered incomplete image escape. Inline images can be
/// large, so this is generous; beyond it we assume a malformed stream and stop
/// buffering rather than grow without bound.
const MAX_PENDING_IMAGE: usize = 8 * 1024 * 1024;

/// Upper bound on ONE chunked Kitty transfer, assembled.
///
/// `MAX_PENDING_IMAGE` bounds the unparsed tail of the stream, which is a
/// different thing: a chunked transfer (`m=1`) is assembled here, across many
/// well-formed escapes, and nothing was watching that total.
const MAX_CHUNKED_IMAGE: usize = MAX_PENDING_IMAGE;

/// How many chunked transfers may be in flight at once.
///
/// Each `m=1` with a fresh id opens an entry that lives until its `m=0`
/// arrives — which a program is under no obligation to send. A loop opening
/// ids and never finishing them grew the map for the life of the pane; past
/// this the oldest is dropped, which costs a hostile stream its earliest
/// transfer and a legitimate one nothing (a terminal sends one at a time).
const MAX_INFLIGHT_CHUNKED: usize = 16;

/// How long an unfinished chunked transfer is kept.
///
/// The in-flight cap bounds how MANY transfers a pane can leave open, not for
/// how long: sixteen half-sent images sat in memory for the life of the pane.
/// A real transfer streams its chunks back to back, so one that has gone
/// quiet this long is abandoned and dropped the next time any chunk arrives.
const MAX_CHUNKED_AGE: std::time::Duration = std::time::Duration::from_secs(30);

impl ImageParser {
    /// Drop every chunked transfer that has been open longer than
    /// `MAX_CHUNKED_AGE` as of `now`.
    fn expire_stale_chunked(&mut self, now: Instant) {
        if self.kitty_chunks.is_empty() {
            return;
        }
        self.kitty_chunks
            .retain(|_, entry| now.duration_since(entry.opened_at) < MAX_CHUNKED_AGE);
        let live = &self.kitty_chunks;
        self.kitty_chunk_order.retain(|id| live.contains_key(id));
    }
}

/// Result of processing raw output through the image parser.
pub struct ImageProcessResult {
    /// Bytes with image sequences stripped (for vt100).
    pub clean_bytes: Vec<u8>,
    /// Newly completed images to store.
    pub new_images: Vec<(u32, StoredImage)>,
}

impl ImageParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.placements.clear();
        self.main_screen_placements = None;
        self.kitty_chunks.clear();
        self.kitty_chunk_order.clear();
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.pending.clear();
    }

    /// Record a placement, replacing any already anchored at the same cell.
    ///
    /// A live preview repaints in place: it homes the cursor and sends the next
    /// frame at the same spot, once a second. Appending each one stacked the
    /// pane full of dead frames, and the protocol's own `a=d` only avoids that
    /// by emptying the pane first — which, over control mode, leaves the frame
    /// visibly missing for as long as the next one takes to arrive. Swapping
    /// the picture at that anchor keeps exactly one frame on screen with no gap
    /// in between.
    ///
    /// Not only the same anchor: a picture drawn OVER another covers it. A
    /// program that moves its picture — a browser pane centring a phone-sized
    /// page in a pane that just changed size — otherwise left the old one on
    /// screen beside the new, and every resize stacked another.
    fn place(&mut self, placement: ImagePlacement) {
        self.placements.retain(|p| !overlaps(p, &placement));
        self.placements.push(placement);
    }

    /// Reset for a capture-pane refill: clear in-flight transfer state but
    /// PRESERVE placements. capture-pane output never contains the original
    /// image escapes (tmux strips them from history), so clearing placements
    /// here would permanently erase every on-screen image each time a capture
    /// refreshes the pane — visible as images flickering out (or, with a
    /// periodic pane re-sync, never surviving at all).
    pub fn reset_for_capture(&mut self) {
        self.kitty_chunks.clear();
        self.kitty_chunk_order.clear();
        self.cursor_row = 0;
        self.cursor_col = 0;
    }

    /// Reset for a pane resize: retire the placements (their cells were just
    /// reflowed) but KEEP the transfer in flight. The bytes still to come are
    /// the rest of an escape the application already started writing; a
    /// program that redraws on SIGWINCH is mid-frame at exactly this moment,
    /// and dropping the head made vt100 print the remaining base64 as text.
    pub fn reset_for_resize(&mut self) {
        self.placements.clear();
        self.main_screen_placements = None;
    }

    pub fn update_cursor(&mut self, row: u16, col: u16) {
        self.cursor_row = row;
        self.cursor_col = col;
    }

    /// Process raw output bytes, extracting image sequences from any of the
    /// three supported protocols. Returns cleaned bytes (image sequences
    /// stripped) and any newly completed images to store.
    /// Undo tmux's DCS passthrough — `ESC P tmux; <payload, every ESC doubled>
    /// ESC \` — so the payload is parsed as if the application had written it
    /// to the terminal itself. Returns `None` when there is nothing wrapped.
    ///
    /// An application inside tmux is meant to wrap any escape tmux does not
    /// understand; that is how the image protocols reach a terminal sitting
    /// behind tmux. tmuxy is not behind tmux — it reads the pane stream — so
    /// the wrapper arrives here intact and has to be undone. Reading it also
    /// keeps the pane's title intact: tmux takes a bare APC string for a title
    /// (its `input_exit_apc`), so a Kitty frame sent unwrapped turns the pane
    /// title into base64 while it draws.
    fn unwrap_passthrough(&mut self, content: &[u8]) -> Option<Vec<u8>> {
        const PREFIX: &[u8] = b"\x1bPtmux;";
        if !content.windows(PREFIX.len()).any(|w| w == PREFIX) {
            return None;
        }
        let mut out = Vec::with_capacity(content.len());
        let mut i = 0;
        while i < content.len() {
            if content[i..].starts_with(PREFIX) {
                match undouble_escapes(&content[i + PREFIX.len()..]) {
                    Some((payload, consumed)) => {
                        out.extend_from_slice(&payload);
                        i += PREFIX.len() + consumed;
                    }
                    None => {
                        // Truncated at the chunk boundary: hold the tail so the
                        // next call sees the whole wrapper.
                        let tail = &content[i..];
                        if tail.len() <= MAX_PENDING_IMAGE {
                            self.pending.extend_from_slice(tail);
                        } else {
                            out.extend_from_slice(tail);
                        }
                        return Some(out);
                    }
                }
            } else {
                out.push(content[i]);
                i += 1;
            }
        }
        Some(out)
    }

    pub fn process(&mut self, content: &[u8]) -> ImageProcessResult {
        // Prepend any incomplete image escape carried over from the last chunk.
        let buffered;
        let content: &[u8] = if self.pending.is_empty() {
            content
        } else {
            self.pending.extend_from_slice(content);
            buffered = std::mem::take(&mut self.pending);
            &buffered
        };

        // Payloads tmux was asked to relay verbatim are unwrapped first, so
        // everything below sees the escapes the application actually wrote.
        let unwrapped;
        let content: &[u8] = match self.unwrap_passthrough(content) {
            Some(bytes) => {
                unwrapped = bytes;
                &unwrapped
            }
            None => content,
        };

        let mut output = Vec::with_capacity(content.len());
        let mut new_images = Vec::new();
        let mut i = 0;

        while i < content.len() {
            if i + 1 < content.len() && content[i] == 0x1B {
                let nxt = content[i + 1];

                // A screen clear or a screen switch takes the pictures on that
                // screen with it. Only watched, never consumed: vt100 still has
                // to clear its own grid.
                if nxt == b'[' {
                    self.observe_csi(&content[i..], &output);
                } else if nxt == b'c' {
                    // RIS: a full reset leaves nothing behind on either screen.
                    self.placements.clear();
                    self.main_screen_placements = None;
                }

                // iTerm2: ESC ] 1337 ; File= ...
                if nxt == b']' {
                    if let Some((consumed, image)) = self.try_parse_iterm2(&content[i..]) {
                        if let Some((id, stored)) = image {
                            new_images.push((id, stored));
                        }
                        i += consumed;
                        continue;
                    }
                }

                // Kitty Graphics Protocol: ESC _ G ... ESC \
                if nxt == b'_' {
                    if let Some((consumed, image)) = self.try_parse_kitty(&content[i..]) {
                        if let Some((id, stored)) = image {
                            new_images.push((id, stored));
                        }
                        i += consumed;
                        continue;
                    }
                }

                // Sixel: ESC P ... q ... ESC \
                if nxt == b'P' {
                    if let Some((consumed, image)) = self.try_parse_sixel(&content[i..]) {
                        if let Some((id, stored)) = image {
                            new_images.push((id, stored));
                        }
                        i += consumed;
                        continue;
                    }
                }

                // An image-capable escape (ESC ] / ESC _ / ESC P) that didn't
                // parse AND has no terminator in the rest of the chunk is split
                // across the %output boundary — buffer the tail and resume next
                // call rather than leaking the torn header into vt100. (A
                // complete-but-non-image ESC ] — e.g. OSC 8 — DOES have a
                // terminator here, so it falls through to pass-through below and
                // reaches the OSC parser as before.)
                if matches!(nxt, b']' | b'_' | b'P') && !has_escape_terminator(&content[i + 2..]) {
                    let tail = &content[i..];
                    if tail.len() <= MAX_PENDING_IMAGE {
                        self.pending.extend_from_slice(tail);
                        break;
                    }
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

    /// Retire pictures for the CSI sequences that empty a screen.
    ///
    /// A placement is anchored to cells, not drawn into them, so vt100 clearing
    /// the grid never touched it: after `clear`, or after an editor quit, the
    /// picture stayed on screen over whatever came next. `emitted` is the clean
    /// output so far, to see whether an erase-below starts from the top left.
    fn observe_csi(&mut self, data: &[u8], emitted: &[u8]) {
        let mut j = 2;
        let private = data.get(j) == Some(&b'?');
        if private {
            j += 1;
        }
        let start = j;
        while j < data.len() && (data[j].is_ascii_digit() || data[j] == b';') {
            j += 1;
        }
        let Some(&final_byte) = data.get(j) else {
            return;
        };
        let params = &data[start..j];
        match (private, final_byte) {
            // ED 2 erases the whole screen; ED 0 (the default) erases from the
            // cursor down, which is the whole screen right after a home — the
            // `ESC [ H ESC [ J` pair curses applications clear with.
            (false, b'J') => {
                let erase_below = params.is_empty() || params == b"0";
                if params == b"2" || (erase_below && ends_with_cursor_home(emitted)) {
                    self.placements.clear();
                }
            }
            (true, b'h') if names_alternate_screen(params) => {
                match self.main_screen_placements {
                    None => {
                        self.main_screen_placements = Some(std::mem::take(&mut self.placements))
                    }
                    // Entering again clears the alternate screen.
                    Some(_) => self.placements.clear(),
                }
            }
            (true, b'l') if names_alternate_screen(params) => {
                if let Some(main) = self.main_screen_placements.take() {
                    self.placements = main;
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_sixel;
