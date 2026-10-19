use super::*;

// -------------------------------------------------------------------
// Kitty Graphics Protocol
//
// Format:  ESC _ G<comma-separated keys>;<base64-payload> ESC \
//
// Keys we honour:
//   a   action (T=transmit+display, t=transmit only, p=display, d=delete)
//   f   format (24=RGB, 32=RGBA, 100=PNG); default 32 per spec
//   t   transmission medium (d=direct base64; only direct supported here)
//   i   image id (used to coalesce chunked transfers)
//   m   more-chunks flag (1=more, 0=last); absent = single-chunk
//   s,v source image pixel width/height (required for RGB/RGBA)
//   r,c display rows/cols on the terminal grid
//
// Everything else (z, X, Y, w, h, q, etc.) is parsed-and-ignored for
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
        let mut transmission = b'd';
        let mut image_id: u32 = 0;
        let mut more_chunks: Option<bool> = None;
        let mut src_w: u32 = 0;
        let mut src_h: u32 = 0;
        let mut rows: u32 = 0;
        let mut cols: u32 = 0;
        let mut delete_what: u8 = b'a';

        for kv in keys_str.split(',') {
            let mut it = kv.splitn(2, '=');
            let k = it.next().unwrap_or("");
            let v = it.next().unwrap_or("");
            match k {
                "a" => action = v.bytes().next().unwrap_or(b'T'),
                "f" => format = v.parse().unwrap_or(32),
                "t" => transmission = v.bytes().next().unwrap_or(b'd'),
                "i" => image_id = v.parse().unwrap_or(0),
                "m" => more_chunks = Some(v == "1"),
                "s" => src_w = v.parse().unwrap_or(0),
                "v" => src_h = v.parse().unwrap_or(0),
                "r" => rows = v.parse().unwrap_or(0),
                "c" => cols = v.parse().unwrap_or(0),
                "d" => delete_what = v.bytes().next().unwrap_or(b'a'),
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

        // Chunked transfer (m=1 / m=0): accumulate; only finish on m=0 or
        // when no `m` key is present (single-chunk).
        let entry = if let Some(more) = more_chunks {
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
                    src_width: src_w,
                    src_height: src_h,
                    rows,
                    cols,
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
            if more {
                return Some((consumed, None));
            }
            self.kitty_chunk_order.retain(|id| *id != image_id);
            self.kitty_chunks.remove(&image_id)?
        } else {
            KittyChunked {
                opened_at: Instant::now(),
                payload: payload_str.to_string(),
                format,
                src_width: src_w,
                src_height: src_h,
                rows,
                cols,
            }
        };

        let raw = base64_decode(&entry.payload);
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
        self.place(ImagePlacement {
            id,
            row: i32::from(self.cursor_row),
            col: self.cursor_col,
            width_cells,
            height_cells,
            protocol: ImageProtocol::Kitty,
            stretch: false,
        });

        Some((consumed, Some((id, stored))))
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
