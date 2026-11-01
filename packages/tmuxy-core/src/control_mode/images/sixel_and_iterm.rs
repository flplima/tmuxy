use super::*;
use base64::Engine;

impl ImageParser {
    // -------------------------------------------------------------------
    // iTerm2 Inline Images
    // -------------------------------------------------------------------

    pub(super) fn try_parse_iterm2(
        &mut self,
        data: &[u8],
    ) -> Option<(usize, Option<(u32, StoredImage)>)> {
        let prefix = b"\x1b]1337;";
        if data.len() < prefix.len() || &data[..prefix.len()] != prefix {
            return None;
        }

        let (end, content) = find_osc_end(&data[2..])?;
        let end = end + 2;
        let content_str = String::from_utf8_lossy(content);

        if !content_str.starts_with("1337;File=") {
            return Some((end, None));
        }
        let file_part = &content_str["1337;File=".len()..];
        let colon_pos = file_part.find(':')?;
        let args_str = &file_part[..colon_pos];
        let base64_data = &file_part[colon_pos + 1..];

        let mut width_cells: u16 = 0;
        let mut height_cells: u16 = 0;
        let mut inline = false;
        let mut stretch = false;
        for arg in args_str.split(';') {
            if let Some(val) = arg.strip_prefix("width=") {
                width_cells = parse_iterm2_dim(val, 8);
            } else if let Some(val) = arg.strip_prefix("height=") {
                height_cells = parse_iterm2_dim(val, 16);
            } else if arg == "inline=1" {
                inline = true;
            } else if arg == "preserveAspectRatio=0" {
                stretch = true;
            }
        }
        if !inline || base64_data.len() > MAX_CHUNKED_IMAGE {
            return Some((end, None));
        }

        let decoded = base64_decode(base64_data);
        if decoded.is_empty() {
            return Some((end, None));
        }
        let Some(mime_type) = detect_mime_type(&decoded) else {
            return Some((end, None));
        };

        if width_cells == 0 {
            width_cells = 40;
        }
        if height_cells == 0 {
            height_cells = 20;
        }

        let id = self.next_id;
        self.next_id += 1;
        self.place(ImagePlacement {
            id,
            row: i32::from(self.cursor_row),
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::ITerm2,
            stretch,
        });
        Some((
            end,
            Some((
                id,
                StoredImage {
                    data: decoded,
                    mime_type: mime_type.to_string(),
                },
            )),
        ))
    }

    // -------------------------------------------------------------------
    // Sixel (DCS Pq...ST)
    //
    // We decode the palette-based raster using icy_sixel (pure Rust) and
    // re-encode as PNG. This keeps the frontend renderer uniform — every
    // protocol funnels through an <img src> served by /api/images.
    // -------------------------------------------------------------------

    pub(super) fn try_parse_sixel(
        &mut self,
        data: &[u8],
    ) -> Option<(usize, Option<(u32, StoredImage)>)> {
        if data.len() < 4 || data[0] != 0x1B || data[1] != b'P' {
            return None;
        }
        let mut end = 2;
        while end + 1 < data.len() {
            if data[end] == 0x1B && data[end + 1] == b'\\' {
                break;
            }
            end += 1;
        }
        if end + 1 >= data.len() {
            return None;
        }
        let consumed = end + 2;
        let body = &data[2..end];

        // Sixel data starts after the `q` introducer, and all that may come
        // before it is the introducer's numeric parameters (`P1;P2;P3`). Other
        // DCS strings can hold a `q` too without being pictures: nvim asks the
        // terminal about its capabilities with XTGETTCAP (`ESC P + q <hex>`)
        // when it starts, and DECRQSS is `ESC P $ q`. Decoded as Sixel, those
        // left a few black pixels wherever the cursor happened to be.
        let q_pos = match body.iter().position(|&b| b == b'q') {
            Some(p) if body[..p].iter().all(|&b| b.is_ascii_digit() || b == b';') => p,
            _ => return Some((consumed, None)),
        };
        let sixel_payload = &body[q_pos + 1..];

        // The decoder allocates the whole canvas, sized by what the payload
        // declares or draws; a 30-byte raster attribute can ask for gigabytes.
        let (max_width, max_height) = sixel_extent(sixel_payload);
        if max_width.saturating_mul(max_height).saturating_mul(4) > MAX_DECODED_IMAGE_BYTES {
            return Some((consumed, None));
        }

        // icy_sixel's full-DCS decoder expects the whole envelope including
        // ESC P ... ESC \. Hand it the full slice.
        let full = &data[..consumed];
        let img = match icy_sixel::SixelImage::decode(full) {
            Ok(img) => img,
            Err(_) => {
                // Fall back to payload-only decode in case the wrapper rejects
                // some non-standard parameter strings.
                let settings = icy_sixel::decoder::DcsSettings::new(None, None, None);
                match icy_sixel::SixelImage::decode_from_dcs(sixel_payload, settings) {
                    Ok(img) => img,
                    Err(_) => return Some((consumed, None)),
                }
            }
        };

        let png = match rgba_to_png(&img.pixels, 32, img.width as u32, img.height as u32) {
            Some(b) => b,
            None => return Some((consumed, None)),
        };

        // Approximate grid placement from pixel dims; cells are ~8x16.
        let width_cells = (img.width as u32 / 8).clamp(1, 200) as u16;
        let height_cells = (img.height as u32 / 16).clamp(1, 100) as u16;

        let id = self.next_id;
        self.next_id += 1;
        self.place(ImagePlacement {
            id,
            row: i32::from(self.cursor_row),
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::Sixel,
            stretch: false,
        });

        Some((
            consumed,
            Some((
                id,
                StoredImage {
                    data: png,
                    mime_type: "image/png".to_string(),
                },
            )),
        ))
    }

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
    pub(super) fn unwrap_passthrough(&mut self, content: &[u8]) -> Option<Vec<u8>> {
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

    /// Retire pictures for the CSI sequences that empty a screen.
    ///
    /// A placement is anchored to cells, not drawn into them, so vt100 clearing
    /// the grid never touched it: after `clear`, or after an editor quit, the
    /// picture stayed on screen over whatever came next. `emitted` is the clean
    /// output so far, to see whether an erase-below starts from the top left.
    pub(super) fn observe_csi<F>(&mut self, data: &[u8], emitted: &mut Vec<u8>, on_flush: &mut F)
    where
        F: FnMut(&[u8], &mut Self),
    {
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
                if !emitted.is_empty() {
                    let flushed = std::mem::take(emitted);
                    on_flush(&flushed, self);
                }
                match self.main_screen_placements {
                    None => {
                        self.main_screen_placements = Some(std::mem::take(&mut self.placements))
                    }
                    // Entering again clears the alternate screen.
                    Some(_) => self.placements.clear(),
                }
            }
            (true, b'l') if names_alternate_screen(params) => {
                if !emitted.is_empty() {
                    let flushed = std::mem::take(emitted);
                    on_flush(&flushed, self);
                }
                if let Some(main) = self.main_screen_placements.take() {
                    self.placements = main;
                }
            }
            _ => {}
        }
    }
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/// Whether the bytes end with a cursor move to the top left (CUP to 1;1).
/// Whether two placements share a cell.
pub(super) fn overlaps(a: &ImagePlacement, b: &ImagePlacement) -> bool {
    let span_u16 = |start: u16, len: u16| (start, start.saturating_add(len.max(1)));
    let span_i32 = |start: i32, len: u16| (start, start.saturating_add(i32::from(len.max(1))));
    let (a_left, a_right) = span_u16(a.col, a.width_cells);
    let (b_left, b_right) = span_u16(b.col, b.width_cells);
    let (a_top, a_bottom) = span_i32(a.row, a.height_cells);
    let (b_top, b_bottom) = span_i32(b.row, b.height_cells);
    a_left < b_right && b_left < a_right && a_top < b_bottom && b_top < a_bottom
}

pub(super) fn ends_with_cursor_home(bytes: &[u8]) -> bool {
    [
        &b"\x1b[H"[..],
        b"\x1b[1;1H",
        b"\x1b[;H",
        b"\x1b[1H",
        b"\x1b[f",
        b"\x1b[1;1f",
    ]
    .iter()
    .any(|home| bytes.ends_with(home))
}

/// Whether DECSET/DECRST parameters name an alternate-screen mode.
pub(super) fn names_alternate_screen(params: &[u8]) -> bool {
    params
        .split(|&b| b == b';')
        .any(|p| p == b"1049" || p == b"1047" || p == b"47")
}

fn parse_iterm2_dim(raw: &str, px_per_cell: u16) -> u16 {
    // iTerm2 dimensions can be cells (`10`), pixels (`100px`), or percent
    // (`50%`). Percent without a viewport is ambiguous; clamp it to a
    // reasonable default.
    if let Some(px) = raw.strip_suffix("px") {
        return px
            .parse::<u16>()
            .map(|n| (n / px_per_cell).max(1))
            .unwrap_or(0);
    }
    if let Some(pct) = raw.strip_suffix('%') {
        return pct
            .parse::<u16>()
            .map(|n| ((n as u32 * 80 / 100) as u16).max(1))
            .unwrap_or(0);
    }
    raw.parse::<u16>().unwrap_or(0)
}

/// True if `content` contains a string-sequence terminator (BEL or ST `ESC \`).
/// Used to tell an *incomplete* image escape (none present → split across the
/// %output boundary) from a complete one that simply isn't an image.
/// Read a tmux passthrough body up to its terminating `ESC \`, restoring every
/// doubled `ESC` on the way. Returns the payload and how many bytes it spanned,
/// or `None` when the terminator has not arrived yet.
pub(super) fn undouble_escapes(body: &[u8]) -> Option<(Vec<u8>, usize)> {
    let mut payload = Vec::with_capacity(body.len());
    let mut i = 0;
    while i < body.len() {
        if body[i] == 0x1B {
            match body.get(i + 1) {
                None => return None,
                Some(0x1B) => {
                    payload.push(0x1B);
                    i += 2;
                }
                Some(b'\\') => return Some((payload, i + 2)),
                Some(_) => {
                    payload.push(body[i]);
                    i += 1;
                }
            }
        } else {
            payload.push(body[i]);
            i += 1;
        }
    }
    None
}

/// The largest canvas a Sixel payload can make the decoder allocate, in
/// pixels: the raster attributes' `Ph;Pv`, or the furthest column a sixel
/// (with its `!n` repeat) reaches and six rows per band, whichever is larger.
///
/// A repeat is held the way icy_sixel holds it: `!n` sets it, and the next
/// sixel byte spends it, however many other bytes come between.
pub(super) fn sixel_extent(payload: &[u8]) -> (usize, usize) {
    let mut width = 0usize;
    let mut bands = 1usize;
    let mut declared_height = 0usize;
    let mut x = 0usize;
    let mut repeat = 1usize;
    let mut i = 0;
    let number = |i: &mut usize| {
        let mut n = 0usize;
        while let Some(d) = payload.get(*i).filter(|b| b.is_ascii_digit()) {
            n = n.saturating_mul(10).saturating_add(usize::from(d - b'0'));
            *i += 1;
        }
        n
    };
    while i < payload.len() {
        match payload[i] {
            b'"' => {
                i += 1;
                let mut params = [0usize; 4];
                for (k, slot) in params.iter_mut().enumerate() {
                    *slot = number(&mut i);
                    if k < 3 && payload.get(i) == Some(&b';') {
                        i += 1;
                    } else {
                        break;
                    }
                }
                width = width.max(params[2]);
                declared_height = declared_height.max(params[3]);
            }
            b'!' => {
                i += 1;
                repeat = number(&mut i).max(1);
            }
            b'$' => {
                x = 0;
                i += 1;
            }
            b'-' => {
                x = 0;
                bands = bands.saturating_add(1);
                i += 1;
            }
            0x3F..=0x7E => {
                x = x.saturating_add(std::mem::replace(&mut repeat, 1));
                width = width.max(x);
                i += 1;
            }
            _ => i += 1,
        }
    }
    (width, bands.saturating_mul(6).max(declared_height))
}

/// Where the last escape terminator (BEL, or the ESC of ESC \\) in `content`
/// starts.
pub(super) fn last_terminator_start(content: &[u8]) -> Option<usize> {
    (0..content.len())
        .rev()
        .find(|&i| content[i] == 0x07 || (content[i] == 0x1B && content.get(i + 1) == Some(&b'\\')))
}

/// Whether `next` holds a terminator for the escape buffered in `pending`,
/// counting an ESC \\ split between the two.
pub(super) fn ends_pending_escape(pending: &[u8], next: &[u8]) -> bool {
    (pending.last() == Some(&0x1B) && next.first() == Some(&b'\\'))
        || last_terminator_start(next).is_some()
}

/// Find the end of an OSC sequence (BEL or ESC \).
/// Input starts after `ESC ]` (so `content[0]` is the first byte after `]`).
/// Returns (bytes consumed from input INCLUDING terminator, content slice).
/// Find the terminator of an OSC body (BEL or ESC \\). `content` starts
/// AFTER the `ESC ]` prefix; returns (bytes consumed from `content`, body).
/// Shared with `OscParser` — the two modules used to carry near-identical
/// copies with different slicing conventions.
pub(crate) fn find_osc_end(content: &[u8]) -> Option<(usize, &[u8])> {
    for i in 0..content.len() {
        if content[i] == 0x07 {
            return Some((i + 1, &content[..i]));
        }
        if i + 1 < content.len() && content[i] == 0x1B && content[i + 1] == b'\\' {
            return Some((i + 2, &content[..i]));
        }
    }
    None
}

/// Decode standard base64 (and url-safe), tolerating embedded whitespace.
pub(super) fn base64_decode(input: &str) -> Vec<u8> {
    // Strip whitespace that real-world payloads often inject for readability.
    let cleaned: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if let Ok(b) = base64::engine::general_purpose::STANDARD.decode(&cleaned) {
        return b;
    }
    if let Ok(b) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(&cleaned) {
        return b;
    }
    if let Ok(b) = base64::engine::general_purpose::URL_SAFE.decode(&cleaned) {
        return b;
    }
    if let Ok(b) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&cleaned) {
        return b;
    }
    Vec::new()
}

/// Detect a raster image MIME type from known magic bytes. Non-image payloads
/// (HTML, SVG, arbitrary octet streams) are rejected so they can never be
/// served back from the app's image endpoints.
pub(super) fn detect_mime_type(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if data.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF8") {
        Some("image/gif")
    } else if data.starts_with(b"RIFF") && data.len() >= 12 && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
