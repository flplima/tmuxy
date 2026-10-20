use super::*;
use std::io::Read;

// -------------------------------------------------------------------
// Kitty Graphics Protocol
//
// Format:  ESC _ G<comma-separated keys>;<base64-payload> ESC \
//
// Keys we honour:
//   a   action (T=transmit+display, t=transmit only, p=display, d=delete)
//   f   format (24=RGB, 32=RGBA, 100=PNG); default 32 per spec
//   o   optional compression (`z` = ZLIB)
//   t   transmission medium (d=direct base64; only direct supported here)
//   i   image id (used to coalesce chunked transfers)
//   m   more-chunks flag (1=more, 0=last); absent = single-chunk
//   U   1 = the placement is drawn by Unicode placeholder cells
//   s,v source image pixel width/height (required for RGB/RGBA)
//   r,c display rows/cols on the terminal grid
//
// Everything else (X, Y, w, h, q, etc.) is parsed-and-ignored for
// now — we render the full image at the cursor position without
// sub-region cropping.
// -------------------------------------------------------------------

impl ImageParser {
    pub(super) fn try_parse_kitty(
        &mut self,
        data: &[u8],
    ) -> Option<(usize, Option<(u32, StoredImage)>)> {
        if data.len() < 4 || data[0] != 0x1B || data[1] != b'_' || data[2] != b'G' {
            return None;
        }

        // Locate the ESC \ terminator that ends the APC.
        let mut end = 3;
        while end + 1 < data.len() {
            if data[end] == 0x1B && data[end + 1] == b'\\' {
                break;
            }
            end += 1;
        }
        if end + 1 >= data.len() {
            return None; // Incomplete; wait for more bytes.
        }
        let consumed = end + 2;
        let body = &data[3..end];

        // Split on the first ';': keys ; payload
        let (keys_part, payload_part) = match body.iter().position(|&b| b == b';') {
            Some(idx) => (&body[..idx], &body[idx + 1..]),
            None => (body, &[][..]),
        };
        let keys_str = String::from_utf8_lossy(keys_part);

        let mut action = b'T';
        let mut format: u32 = 32;
        let mut compression = None;
        let mut transmission = b'd';
        let mut image_id: Option<u32> = None;
        let mut more_chunks: Option<bool> = None;
        let mut src_w: u32 = 0;
        let mut src_h: u32 = 0;
        let mut rows: u32 = 0;
        let mut cols: u32 = 0;
        let mut delete_what: u8 = b'a';
        let mut unicode_placeholder = false;

        for kv in keys_str.split(',') {
            let mut it = kv.splitn(2, '=');
            let k = it.next().unwrap_or("");
            let v = it.next().unwrap_or("");
            match k {
                "a" => action = v.bytes().next().unwrap_or(b'T'),
                "f" => format = v.parse().unwrap_or(32),
                "o" => compression = v.bytes().next(),
                "t" => transmission = v.bytes().next().unwrap_or(b'd'),
                "i" => image_id = v.parse().ok(),
                "m" => more_chunks = Some(v == "1"),
                "s" => src_w = v.parse().unwrap_or(0),
                "v" => src_h = v.parse().unwrap_or(0),
                "r" => rows = v.parse().unwrap_or(0),
                "c" => cols = v.parse().unwrap_or(0),
                "d" => delete_what = v.bytes().next().unwrap_or(b'a'),
                "U" => unicode_placeholder = v == "1",
                _ => {}
            }
        }

        // a=d deletes placements, which is how an application repaints in place
        // rather than stacking frames: a live preview (ranger, zellij, a
        // screenshot loop) clears before each new frame, and ignoring it left
        // the pane accumulating one placement per frame until the tab crawled.
        // `d` says WHICH to drop; its default 'a' (and 'A', which also frees
        // the data) means all of them. The narrower selectors address images by
        // the kitty id, which we do not keep, so those are left alone rather
        // than guessed at — dropping the wrong picture is worse than keeping it.
        if action == b'd' {
            if delete_what == b'a' || delete_what == b'A' {
                self.placements.clear();
            }
            return Some((consumed, None));
        }

        // We only support direct (base64-inline) transmission. File / shm
        // transmission would need filesystem access we don't grant here.
        if transmission != b'd' {
            return Some((consumed, None));
        }
        // We only render on transmit-and-display actions for now.
        if action != b'T' && action != b'p' {
            return Some((consumed, None));
        }

        let payload_str = std::str::from_utf8(payload_part).ok()?;

        // Kitty only requires `i=` on the first chunk. Later chunks can carry
        // just `m=` (and `q=`), including the final chunk, so associate an
        // id-less packet with the sole transfer in flight. The protocol does
        // not interleave transfers; if malformed input leaves several open,
        // consuming an ambiguous continuation is safer than corrupting one.
        let image_id = match image_id {
            Some(id) => id,
            None if self.kitty_chunks.len() == 1 => *self.kitty_chunks.keys().next()?,
            None if self.kitty_chunks.is_empty() => 0,
            None => return Some((consumed, None)),
        };

        // Chunked transfer: accumulate while m=1, then finish on m=0 or on a
        // metadata-light final packet that omits `m`. Kitty 0.48 emits `m=1`
        // on the first chunk and omits `m=0` from the final one, so a packet
        // without `m` that matches an in-flight image id ends that transfer;
        // otherwise it is a standalone image as usual.
        let is_chunked = more_chunks.is_some() || self.kitty_chunks.contains_key(&image_id);
        let entry = if is_chunked {
            // SEC-03: the payload comes from pane output, so the number of
            // open transfers, the size of each and how long one may stay open
            // are all bounded.
            self.expire_stale_chunked(Instant::now());
            if !self.kitty_chunks.contains_key(&image_id)
                && self.kitty_chunks.len() >= MAX_INFLIGHT_CHUNKED
            {
                if let Some(oldest) = self.kitty_chunk_order.pop_front() {
                    self.kitty_chunks.remove(&oldest);
                }
            }
            if !self.kitty_chunks.contains_key(&image_id) {
                self.kitty_chunk_order.push_back(image_id);
            }
            let entry = self
                .kitty_chunks
                .entry(image_id)
                .or_insert_with(|| KittyChunked {
                    opened_at: Instant::now(),
                    payload: String::new(),
                    format,
                    compression,
                    src_width: src_w,
                    src_height: src_h,
                    rows,
                    cols,
                    unicode_placeholder,
                });
            if entry.payload.len().saturating_add(payload_str.len()) > MAX_CHUNKED_IMAGE {
                // Over the cap: drop the transfer rather than keep growing it.
                // A real image never reaches this; a stream that does is not
                // one we can finish anyway.
                self.kitty_chunks.remove(&image_id);
                self.kitty_chunk_order.retain(|id| *id != image_id);
                return Some((consumed, None));
            }
            entry.payload.push_str(payload_str);
            if more_chunks == Some(true) {
                return Some((consumed, None));
            }
            self.kitty_chunk_order.retain(|id| *id != image_id);
            self.kitty_chunks.remove(&image_id)?
        } else {
            KittyChunked {
                opened_at: Instant::now(),
                payload: payload_str.to_string(),
                format,
                compression,
                src_width: src_w,
                src_height: src_h,
                rows,
                cols,
                unicode_placeholder,
            }
        };

        let encoded = base64_decode(&entry.payload);
        let raw = match entry.compression {
            None => encoded,
            Some(b'z') => match zlib_decompress_bounded(&encoded) {
                Some(decoded) => decoded,
                None => return Some((consumed, None)),
            },
            Some(_) => return Some((consumed, None)),
        };
        if raw.is_empty() {
            return Some((consumed, None));
        }

        // Convert RGB/RGBA -> PNG so the frontend can render via <img>.
        let stored = match entry.format {
            100 => StoredImage {
                mime_type: detect_mime_type(&raw),
                data: raw,
            },
            24 | 32 => match rgba_to_png(&raw, entry.format, entry.src_width, entry.src_height) {
                Some(png) => StoredImage {
                    data: png,
                    mime_type: "image/png".to_string(),
                },
                None => return Some((consumed, None)),
            },
            _ => return Some((consumed, None)),
        };

        // Decide grid placement size.
        let (width_cells, height_cells) = self.kitty_cell_dims(&entry);
        let id = self.next_id;
        self.next_id += 1;
        self.kitty_image_ids.insert(image_id, id);
        if entry.unicode_placeholder {
            self.kitty_virtual_images.insert(id);
        } else {
            self.place(ImagePlacement {
                id,
                row: i32::from(self.cursor_row),
                col: self.cursor_col,
                width_cells,
                height_cells,
                protocol: ImageProtocol::Kitty,
                stretch: false,
            });
        }

        Some((consumed, Some((id, stored))))
    }

    /// Rebuild Kitty Unicode-placeholder placements from the emulated screen.
    /// The placeholders are ordinary terminal cells, so the terminal emulator
    /// has already applied cursor movement, wrapping and scrolling for us.
    pub fn update_kitty_placeholders(&mut self, screen: &vt100::Screen) {
        self.placements
            .retain(|placement| !self.kitty_virtual_images.contains(&placement.id));

        let (rows, cols) = screen.size();
        let mut bounds: std::collections::HashMap<u32, (u16, u16, u16, u16)> =
            std::collections::HashMap::new();
        for row in 0..rows {
            for col in 0..cols {
                let Some(cell) = screen.cell(row, col) else {
                    continue;
                };
                let Some(image_id) = kitty_placeholder_image_id(cell) else {
                    continue;
                };
                let Some(&stored_id) = self.kitty_image_ids.get(&image_id) else {
                    continue;
                };
                bounds
                    .entry(stored_id)
                    .and_modify(|(top, left, bottom, right)| {
                        *top = (*top).min(row);
                        *left = (*left).min(col);
                        *bottom = (*bottom).max(row);
                        *right = (*right).max(col);
                    })
                    .or_insert((row, col, row, col));
            }
        }

        for (id, (top, left, bottom, right)) in bounds {
            self.kitty_virtual_images.insert(id);
            self.place(ImagePlacement {
                id,
                row: i32::from(top),
                col: left,
                width_cells: right.saturating_sub(left) + 1,
                height_cells: bottom.saturating_sub(top) + 1,
                protocol: ImageProtocol::Kitty,
                stretch: false,
            });
        }
    }

    fn kitty_cell_dims(&self, entry: &KittyChunked) -> (u16, u16) {
        // Caller-specified rows/cols win; otherwise approximate from pixel
        // dims using 8x16 cell heuristics so the placement isn't wildly off.
        let cols = if entry.cols > 0 {
            entry.cols as u16
        } else if entry.src_width > 0 {
            (entry.src_width / 8).clamp(1, 200) as u16
        } else {
            40
        };
        let rows = if entry.rows > 0 {
            entry.rows as u16
        } else if entry.src_height > 0 {
            (entry.src_height / 16).clamp(1, 100) as u16
        } else {
            20
        };
        (cols, rows)
    }
}

fn kitty_placeholder_image_id(cell: &vt100::Cell) -> Option<u32> {
    let mut chars = cell.contents().chars();
    if chars.next()? != '\u{10eeee}' {
        return None;
    }
    let marks: Vec<u32> = chars.filter_map(kitty_diacritic_value).collect();
    let low = match cell.fgcolor() {
        vt100::Color::Rgb(r, g, b) => (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b),
        vt100::Color::Idx(id) => u32::from(id),
        vt100::Color::Default => return None,
    };
    Some(low | (marks.get(2).copied().unwrap_or(0) << 24))
}

/// Kitty's rowcolumn-diacritics.txt, in order: a mark's position is the row,
/// column or image-id high byte it encodes. The ids kitten picks use the whole
/// 32-bit range, so every one of the 297 entries has to be here.
fn kitty_diacritic_value(ch: char) -> Option<u32> {
    const MARKS: &[char] = &[
        '\u{0305}',
        '\u{030d}',
        '\u{030e}',
        '\u{0310}',
        '\u{0312}',
        '\u{033d}',
        '\u{033e}',
        '\u{033f}',
        '\u{0346}',
        '\u{034a}',
        '\u{034b}',
        '\u{034c}',
        '\u{0350}',
        '\u{0351}',
        '\u{0352}',
        '\u{0357}',
        '\u{035b}',
        '\u{0363}',
        '\u{0364}',
        '\u{0365}',
        '\u{0366}',
        '\u{0367}',
        '\u{0368}',
        '\u{0369}',
        '\u{036a}',
        '\u{036b}',
        '\u{036c}',
        '\u{036d}',
        '\u{036e}',
        '\u{036f}',
        '\u{0483}',
        '\u{0484}',
        '\u{0485}',
        '\u{0486}',
        '\u{0487}',
        '\u{0592}',
        '\u{0593}',
        '\u{0594}',
        '\u{0595}',
        '\u{0597}',
        '\u{0598}',
        '\u{0599}',
        '\u{059c}',
        '\u{059d}',
        '\u{059e}',
        '\u{059f}',
        '\u{05a0}',
        '\u{05a1}',
        '\u{05a8}',
        '\u{05a9}',
        '\u{05ab}',
        '\u{05ac}',
        '\u{05af}',
        '\u{05c4}',
        '\u{0610}',
        '\u{0611}',
        '\u{0612}',
        '\u{0613}',
        '\u{0614}',
        '\u{0615}',
        '\u{0616}',
        '\u{0617}',
        '\u{0657}',
        '\u{0658}',
        '\u{0659}',
        '\u{065a}',
        '\u{065b}',
        '\u{065d}',
        '\u{065e}',
        '\u{06d6}',
        '\u{06d7}',
        '\u{06d8}',
        '\u{06d9}',
        '\u{06da}',
        '\u{06db}',
        '\u{06dc}',
        '\u{06df}',
        '\u{06e0}',
        '\u{06e1}',
        '\u{06e2}',
        '\u{06e4}',
        '\u{06e7}',
        '\u{06e8}',
        '\u{06eb}',
        '\u{06ec}',
        '\u{0730}',
        '\u{0732}',
        '\u{0733}',
        '\u{0735}',
        '\u{0736}',
        '\u{073a}',
        '\u{073d}',
        '\u{073f}',
        '\u{0740}',
        '\u{0741}',
        '\u{0743}',
        '\u{0745}',
        '\u{0747}',
        '\u{0749}',
        '\u{074a}',
        '\u{07eb}',
        '\u{07ec}',
        '\u{07ed}',
        '\u{07ee}',
        '\u{07ef}',
        '\u{07f0}',
        '\u{07f1}',
        '\u{07f3}',
        '\u{0816}',
        '\u{0817}',
        '\u{0818}',
        '\u{0819}',
        '\u{081b}',
        '\u{081c}',
        '\u{081d}',
        '\u{081e}',
        '\u{081f}',
        '\u{0820}',
        '\u{0821}',
        '\u{0822}',
        '\u{0823}',
        '\u{0825}',
        '\u{0826}',
        '\u{0827}',
        '\u{0829}',
        '\u{082a}',
        '\u{082b}',
        '\u{082c}',
        '\u{082d}',
        '\u{0951}',
        '\u{0953}',
        '\u{0954}',
        '\u{0f82}',
        '\u{0f83}',
        '\u{0f86}',
        '\u{0f87}',
        '\u{135d}',
        '\u{135e}',
        '\u{135f}',
        '\u{17dd}',
        '\u{193a}',
        '\u{1a17}',
        '\u{1a75}',
        '\u{1a76}',
        '\u{1a77}',
        '\u{1a78}',
        '\u{1a79}',
        '\u{1a7a}',
        '\u{1a7b}',
        '\u{1a7c}',
        '\u{1b6b}',
        '\u{1b6d}',
        '\u{1b6e}',
        '\u{1b6f}',
        '\u{1b70}',
        '\u{1b71}',
        '\u{1b72}',
        '\u{1b73}',
        '\u{1cd0}',
        '\u{1cd1}',
        '\u{1cd2}',
        '\u{1cda}',
        '\u{1cdb}',
        '\u{1ce0}',
        '\u{1dc0}',
        '\u{1dc1}',
        '\u{1dc3}',
        '\u{1dc4}',
        '\u{1dc5}',
        '\u{1dc6}',
        '\u{1dc7}',
        '\u{1dc8}',
        '\u{1dc9}',
        '\u{1dcb}',
        '\u{1dcc}',
        '\u{1dd1}',
        '\u{1dd2}',
        '\u{1dd3}',
        '\u{1dd4}',
        '\u{1dd5}',
        '\u{1dd6}',
        '\u{1dd7}',
        '\u{1dd8}',
        '\u{1dd9}',
        '\u{1dda}',
        '\u{1ddb}',
        '\u{1ddc}',
        '\u{1ddd}',
        '\u{1dde}',
        '\u{1ddf}',
        '\u{1de0}',
        '\u{1de1}',
        '\u{1de2}',
        '\u{1de3}',
        '\u{1de4}',
        '\u{1de5}',
        '\u{1de6}',
        '\u{1dfe}',
        '\u{20d0}',
        '\u{20d1}',
        '\u{20d4}',
        '\u{20d5}',
        '\u{20d6}',
        '\u{20d7}',
        '\u{20db}',
        '\u{20dc}',
        '\u{20e1}',
        '\u{20e7}',
        '\u{20e9}',
        '\u{20f0}',
        '\u{2cef}',
        '\u{2cf0}',
        '\u{2cf1}',
        '\u{2de0}',
        '\u{2de1}',
        '\u{2de2}',
        '\u{2de3}',
        '\u{2de4}',
        '\u{2de5}',
        '\u{2de6}',
        '\u{2de7}',
        '\u{2de8}',
        '\u{2de9}',
        '\u{2dea}',
        '\u{2deb}',
        '\u{2dec}',
        '\u{2ded}',
        '\u{2dee}',
        '\u{2def}',
        '\u{2df0}',
        '\u{2df1}',
        '\u{2df2}',
        '\u{2df3}',
        '\u{2df4}',
        '\u{2df5}',
        '\u{2df6}',
        '\u{2df7}',
        '\u{2df8}',
        '\u{2df9}',
        '\u{2dfa}',
        '\u{2dfb}',
        '\u{2dfc}',
        '\u{2dfd}',
        '\u{2dfe}',
        '\u{2dff}',
        '\u{a66f}',
        '\u{a67c}',
        '\u{a67d}',
        '\u{a6f0}',
        '\u{a6f1}',
        '\u{a8e0}',
        '\u{a8e1}',
        '\u{a8e2}',
        '\u{a8e3}',
        '\u{a8e4}',
        '\u{a8e5}',
        '\u{a8e6}',
        '\u{a8e7}',
        '\u{a8e8}',
        '\u{a8e9}',
        '\u{a8ea}',
        '\u{a8eb}',
        '\u{a8ec}',
        '\u{a8ed}',
        '\u{a8ee}',
        '\u{a8ef}',
        '\u{a8f0}',
        '\u{a8f1}',
        '\u{aab0}',
        '\u{aab2}',
        '\u{aab3}',
        '\u{aab7}',
        '\u{aab8}',
        '\u{aabe}',
        '\u{aabf}',
        '\u{aac1}',
        '\u{fe20}',
        '\u{fe21}',
        '\u{fe22}',
        '\u{fe23}',
        '\u{fe24}',
        '\u{fe25}',
        '\u{fe26}',
        '\u{10a0f}',
        '\u{10a38}',
        '\u{1d185}',
        '\u{1d186}',
        '\u{1d187}',
        '\u{1d188}',
        '\u{1d189}',
        '\u{1d1aa}',
        '\u{1d1ab}',
        '\u{1d1ac}',
        '\u{1d1ad}',
        '\u{1d242}',
        '\u{1d243}',
        '\u{1d244}',
    ];
    MARKS
        .iter()
        .position(|&mark| mark == ch)
        .map(|value| value as u32)
}

fn zlib_decompress_bounded(compressed: &[u8]) -> Option<Vec<u8>> {
    let decoder = flate2::read::ZlibDecoder::new(compressed);
    let mut decoded = Vec::new();
    decoder
        .take((MAX_DECODED_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut decoded)
        .ok()?;
    (decoded.len() <= MAX_DECODED_IMAGE_BYTES).then_some(decoded)
}
