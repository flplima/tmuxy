//! Kitty images placed by Unicode placeholder cells (`U=1`): the cells
//! are ordinary text that tmux relays like any other, so the picture's
//! position is read back off the emulated grid rather than the cursor.

use super::*;

impl ImageParser {
    /// Map a kitty id to the store's id, forgetting the oldest once over the
    /// cap so a loop of images cannot grow the map without bound (SEC-22).
    pub(super) fn remember_kitty_id(&mut self, kitty_id: u32, stored_id: u32) {
        if self.kitty_image_ids.insert(kitty_id, stored_id).is_none() {
            self.kitty_image_order.push_back(kitty_id);
        }
        while self.kitty_image_ids.len() > MAX_KITTY_IMAGE_IDS {
            let Some(oldest) = self.kitty_image_order.pop_front() else {
                break;
            };
            if let Some(stored) = self.kitty_image_ids.remove(&oldest) {
                self.kitty_virtual_images.remove(&stored);
            }
        }
    }

    /// Rebuild Kitty Unicode-placeholder placements from the emulated screen.
    /// The placeholders are ordinary terminal cells, so the terminal emulator
    /// has already applied cursor movement, wrapping and scrolling for us.
    ///
    /// Walking the grid costs rows × cols per call, on the path every output
    /// chunk takes, so it runs only when a placement can have changed: the
    /// chunk wrote a placeholder cell, or one is on screen that this chunk
    /// may have overwritten or scrolled. A pane that never shows one pays
    /// a scan of the chunk's bytes and nothing more.
    pub fn update_kitty_placeholders(&mut self, screen: &vt100::Screen, output: &[u8]) {
        let on_screen = self
            .placements
            .iter()
            .any(|placement| self.kitty_virtual_images.contains(&placement.id));
        if !on_screen && !contains_kitty_placeholder(output) {
            return;
        }
        #[cfg(test)]
        {
            self.placeholder_scans += 1;
        }
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
}

/// U+10EEEE, the placeholder character, as the bytes a pane writes it in.
const KITTY_PLACEHOLDER_UTF8: &[u8] = "\u{10eeee}".as_bytes();

/// Whether an output chunk writes at least one placeholder cell. A character
/// torn across two chunks is missed here, which costs nothing when a
/// placement is already on screen (that path rescans anyway) and is caught
/// by the image's next cell otherwise.
fn contains_kitty_placeholder(output: &[u8]) -> bool {
    output
        .windows(KITTY_PLACEHOLDER_UTF8.len())
        .any(|window| window == KITTY_PLACEHOLDER_UTF8)
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
