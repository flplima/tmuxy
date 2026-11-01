//! Terminal image protocol support.
//!
//! Three protocols are intercepted from raw terminal output before the bytes
//! reach the vt100 emulator:
//!
//! - **iTerm2 Inline Images** — `ESC ] 1337 ; File=<args> : <base64> BEL/ST`
//! - **Kitty Graphics Protocol** — `ESC _ G<keys>;<base64-payload> ESC \`
//!   (APC sequence, supports chunked transfer where the final chunk may omit `m=0`)
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
mod kitty_placeholders;
mod sixel_and_iterm;

use kitty::rgba_to_png;
use serde::{Deserialize, Serialize};
pub(super) use sixel_and_iterm::find_osc_end;
use sixel_and_iterm::{
    base64_decode, detect_mime_type, ends_pending_escape, last_terminator_start, overlaps,
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
    /// Row where the image starts (0-indexed, screen-relative; negative when scrolled into history).
    pub row: i32,
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
    /// space (a program that maps a clicked cell to a pixel of its picture)
    /// must not be letterboxed, or a click lands where the picture is not.
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
/// Kitty splits large payloads into chunks with `m=1` (more); the final chunk
/// may mark `m=0` or omit `m` entirely. Subsequent chunks may omit metadata
/// (other than `i=`/`m=`), so we cache the first chunk's transmission keys.
#[derive(Debug)]
struct KittyChunked {
    /// When the transfer was opened; see `MAX_CHUNKED_AGE`.
    opened_at: Instant,
    /// Accumulated base64 payload (still encoded).
    payload: String,
    /// Image format (`f=`) from the first chunk: 32 = RGBA, 24 = RGB, 100 = PNG.
    format: u32,
    /// Payload compression (`o=`); `z` is ZLIB.
    compression: Option<u8>,
    /// Source pixel width (`s=`).
    src_width: u32,
    /// Source pixel height (`v=`).
    src_height: u32,
    /// Display rows (`r=`) — 0 if unset.
    rows: u32,
    /// Display columns (`c=`) — 0 if unset.
    cols: u32,
    /// The transfer creates a virtual placement represented by Unicode cells.
    unicode_placeholder: bool,
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
    /// Kitty protocol image ids mapped to the ids used by the HTTP image store.
    kitty_image_ids: std::collections::HashMap<u32, u32>,
    /// The order kitty ids were seen in, so `MAX_KITTY_IMAGE_IDS` evicts the oldest.
    kitty_image_order: std::collections::VecDeque<u32>,
    /// Internal image ids whose screen placement comes from Unicode cells.
    kitty_virtual_images: std::collections::HashSet<u32>,
    /// How many times the screen was walked for placeholder cells. The walk
    /// is the one per-output cost that scales with the grid, so a test holds
    /// it to the chunks that can change a placement.
    #[cfg(test)]
    pub(crate) placeholder_scans: usize,
    /// An image escape (iTerm2/kitty/sixel) split across `%output` chunks,
    /// carried into the next `process()` call so a large payload isn't torn —
    /// its header rendered as garbage text and the image dropped.
    pending: Vec<u8>,
    /// `pending` is one escape whose terminator has been looked for and not
    /// found. A chunk that brings no terminator either can then only extend
    /// it, so the chunk is appended without rescanning the whole buffer —
    /// which, over an 8 MiB image in 4 KiB chunks, was gigabytes of scanning.
    pending_unterminated: bool,
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

/// Upper bound on a ZLIB-compressed Kitty payload once inflated, so a small
/// payload cannot expand into an unbounded buffer.
const MAX_DECODED_IMAGE_BYTES: usize = 64 * 1024 * 1024;

/// How many kitty image ids a pane remembers for placeholder lookup: the
/// same bound as the pane's image store, since an id whose bytes are gone
/// has nothing left to place.
const MAX_KITTY_IMAGE_IDS: usize = 256;

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
        self.kitty_image_ids.clear();
        self.kitty_image_order.clear();
        self.kitty_virtual_images.clear();
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.pending.clear();
        self.pending_unterminated = false;
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
    /// program that moves its picture — re-centring it in a pane that just
    /// changed size — otherwise left the old one on screen beside the new,
    /// and every resize stacked another.
    fn place(&mut self, placement: ImagePlacement) {
        self.placements.retain(|p| !overlaps(p, &placement));
        self.placements.push(placement);
    }

    /// Shift all active placements up by `delta` rows as the terminal scrolls,
    /// evicting only placements whose bottom edge has scrolled past the
    /// scrollback buffer (`-(max_scrollback as i32)`).
    pub fn shift_rows_up(&mut self, delta: u32, max_scrollback: usize) {
        if delta == 0 {
            return;
        }
        let d = delta as i32;
        let limit = -(max_scrollback as i32);
        for p in &mut self.placements {
            p.row = p.row.saturating_sub(d);
        }
        self.placements
            .retain(|p| p.row.saturating_add(i32::from(p.height_cells)) > limit);
    }

    /// Shift all active placements down by `delta` rows on reverse scroll.
    pub fn shift_rows_down(&mut self, delta: u32) {
        if delta == 0 {
            return;
        }
        let d = delta as i32;
        for p in &mut self.placements {
            p.row = p.row.saturating_add(d);
        }
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

    /// Reset for a pane resize: on the alternate screen, retire placements
    /// (the full-screen application will redraw on `SIGWINCH`), while on the
    /// primary screen preserve placements (CLI tools like `kitten icat`,
    /// `chafa`, `imgcat` have already exited and will not redraw on zoom or
    /// resize). Always keep in-flight transfers intact so a resize mid-frame
    /// does not spill the remaining base64 as text.
    pub fn reset_for_resize(&mut self, in_alt_screen: bool) {
        if in_alt_screen || self.main_screen_placements.is_some() {
            self.placements.clear();
        }
    }

    pub fn update_cursor(&mut self, row: u16, col: u16) {
        self.cursor_row = row;
        self.cursor_col = col;
    }

    pub fn process(&mut self, content: &[u8]) -> ImageProcessResult {
        let mut clean_bytes = Vec::with_capacity(content.len());
        let new_images = self.process_with(content, |chunk, _| {
            clean_bytes.extend_from_slice(chunk);
        });
        ImageProcessResult {
            clean_bytes,
            new_images,
        }
    }

    /// Process raw output bytes, flushing clean (non-image) byte spans through
    /// `on_clean_bytes` before each image placement or screen switch so the
    /// caller can advance its terminal emulator and update `(cursor_row,
    /// cursor_col)` and scroll offsets at the exact point in the byte stream
    /// where each image escape appears.
    pub fn process_with<F>(
        &mut self,
        content: &[u8],
        mut on_clean_bytes: F,
    ) -> Vec<(u32, StoredImage)>
    where
        F: FnMut(&[u8], &mut Self),
    {
        // Prepend any incomplete image escape carried over from the last chunk.
        // When this chunk cannot end it, it only grows the buffer.
        if self.pending_unterminated
            && self.pending.len() + content.len() <= MAX_PENDING_IMAGE
            && !ends_pending_escape(&self.pending, content)
        {
            self.pending.extend_from_slice(content);
            return Vec::new();
        }
        self.pending_unterminated = false;
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

        // Where the chunk's last terminator starts: an escape at `i` has one
        // after it exactly when that is at or past `i + 2`. Asking each escape
        // to scan the rest of the chunk made a run of unterminated ones
        // quadratic.
        let last_terminator = last_terminator_start(content);
        let terminated_after = |from: usize| last_terminator.is_some_and(|at| at >= from);

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
                    self.observe_csi(&content[i..], &mut output, &mut on_clean_bytes);
                } else if nxt == b'c' {
                    // RIS: a full reset leaves nothing behind on either screen.
                    self.placements.clear();
                    self.main_screen_placements = None;
                }

                // iTerm2: ESC ] 1337 ; File= ...
                if nxt == b']' {
                    if !output.is_empty()
                        && content[i..].starts_with(b"\x1b]1337;")
                        && find_osc_end(&content[i + 2..]).is_some()
                    {
                        let flushed = std::mem::take(&mut output);
                        on_clean_bytes(&flushed, self);
                    }
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
                    if !output.is_empty()
                        && content[i..].starts_with(b"\x1b_G")
                        && terminated_after(i + 2)
                    {
                        let flushed = std::mem::take(&mut output);
                        on_clean_bytes(&flushed, self);
                    }
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
                    if !output.is_empty() && terminated_after(i + 2) {
                        let flushed = std::mem::take(&mut output);
                        on_clean_bytes(&flushed, self);
                    }
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
                if matches!(nxt, b']' | b'_' | b'P') && !terminated_after(i + 2) {
                    let tail = &content[i..];
                    if tail.len() <= MAX_PENDING_IMAGE {
                        self.pending_unterminated = self.pending.is_empty();
                        self.pending.extend_from_slice(tail);
                        break;
                    }
                }
            }

            output.push(content[i]);
            i += 1;
        }

        if !output.is_empty() {
            on_clean_bytes(&output, self);
        }

        new_images
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_placeholders;
#[cfg(test)]
mod tests_sixel;
