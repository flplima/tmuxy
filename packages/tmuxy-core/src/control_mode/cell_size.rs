//! The size of a cell in CSS pixels, as the client that measured it last
//! announced it (`@tmuxy-cell-px`), and the two queries a program in a pane
//! can ask it with: `CSI 16 t` (the cell) and `CSI 14 t` (the text area).
//!
//! A program that reads the mouse in pixels (SGR-Pixels, docs/MOUSE.md) needs
//! the cell's size to turn a pixel into a cell. tmux cannot give it: a
//! control-mode client has no way to tell tmux its pixel size, so tmux 3.4 and
//! later answer the queries themselves with their default 16 by 32, and 3.2
//! and 3.3 do not answer at all. On those two, tmuxy answers.
//!
//! What a pane's output may cause here is bounded: a reply holds only digits,
//! `;` and fixed bytes, and a pane gets at most [`MAX_REPLIES`] a second.

use super::state::Instant;
use crate::PaneId;

/// The largest side a cell may be announced with, in CSS pixels: a value past
/// it is not a cell size, and a reply built from it would be no use.
const MAX_SIDE_PX: f64 = 1000.0;

/// How many replies one pane may be sent in [`REPLY_WINDOW`]. A program asks
/// for both sizes together, and may ask again after a font change; a loop, or
/// a `cat` of a file full of queries, gets this many and then nothing.
pub(crate) const MAX_REPLIES: u8 = 4;
pub(crate) const REPLY_WINDOW: std::time::Duration = std::time::Duration::from_secs(1);

/// A cell's width and height in CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CellPx {
    pub width: f64,
    pub height: f64,
}

impl CellPx {
    /// `<width>x<height>`, each a positive number of up to two decimals, as
    /// the client writes it (`9x24`, `8.5x17`). Anything else is no size.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let (width, height) = value.trim().split_once('x')?;
        let side = |text: &str| -> Option<f64> {
            let (whole, decimals) = text.split_once('.').unwrap_or((text, ""));
            let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
            if whole.is_empty() || whole.len() > 4 || decimals.len() > 2 {
                return None;
            }
            if !digits(whole) || !digits(decimals) || (text.contains('.') && decimals.is_empty()) {
                return None;
            }
            let px: f64 = text.parse().ok()?;
            (px > 0.0 && px <= MAX_SIDE_PX).then_some(px)
        };
        Some(Self {
            width: side(width)?,
            height: side(height)?,
        })
    }

    /// The value the client wrote, normalized: up to two decimals, no
    /// trailing zeros (`9x24`, `8.5x17`).
    pub(crate) fn to_option_value(self) -> String {
        format!("{}x{}", decimal(self.width), decimal(self.height))
    }
}

fn decimal(px: f64) -> String {
    let text = format!("{px:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// A window-operations query tmuxy may answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SizeQuery {
    /// `CSI 16 t`: one cell.
    Cell,
    /// `CSI 14 t`: the pane's text area.
    TextArea,
}

impl SizeQuery {
    /// The query a `CSI … t` with these parameters is, if one tmuxy answers.
    /// Only the bare forms: `CSI 14 ; 2 t` asks for the window, which tmuxy
    /// does not know.
    pub(crate) fn from_params(params: &[&[u16]]) -> Option<Self> {
        match params {
            [[16]] => Some(Self::Cell),
            [[14]] => Some(Self::TextArea),
            _ => None,
        }
    }

    /// The bytes of the reply, as xterm has it: height before width, whole
    /// pixels, rounded.
    pub(crate) fn reply(self, cell: CellPx, cols: u32, rows: u32) -> String {
        let px = |n: f64| n.round() as u64;
        match self {
            Self::Cell => format!("\x1b[6;{};{}t", px(cell.height), px(cell.width)),
            Self::TextArea => format!(
                "\x1b[4;{};{}t",
                px(cell.height * f64::from(rows)),
                px(cell.width * f64::from(cols))
            ),
        }
    }
}

/// The command that types `reply` into `pane`. Typed with `send-keys -H`, as
/// a mouse report is (docs/TMUX-VERSION-BUGS.md), and only by the first
/// member of a session group: every session in a group sees the pane's
/// output, so every monitor on it reads the query, and one answer is enough.
pub(crate) fn reply_command(pane: &PaneId, reply: &str) -> String {
    let hex: Vec<String> = reply.bytes().map(|b| format!("{b:02x}")).collect();
    format!(
        "if-shell -F '#{{||:#{{==:#{{session_group}},}},#{{==:#{{s/,.*//:session_group_list}},#{{session_name}}}}}}' {{ send-keys -t {pane} -H {} }}",
        hex.join(" ")
    )
}

/// How many replies a pane has been sent in the current window.
#[derive(Debug, Default)]
pub(crate) struct ReplyBudget {
    window_start: Option<Instant>,
    sent: u8,
}

impl ReplyBudget {
    /// Whether one more reply may go at `now`, counting it when it may.
    pub(crate) fn take(&mut self, now: Instant) -> bool {
        let fresh = self
            .window_start
            .is_none_or(|start| now.duration_since(start) >= REPLY_WINDOW);
        if fresh {
            self.window_start = Some(now);
            self.sent = 0;
        }
        if self.sent >= MAX_REPLIES {
            return false;
        }
        self.sent += 1;
        true
    }
}

#[cfg(test)]
mod tests;
