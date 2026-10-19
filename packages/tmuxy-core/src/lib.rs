pub mod command_error;
pub mod constants;
pub mod control_mode;
pub mod error;
pub mod groups;
pub mod ids;

// The synchronous tmux-command layer (`cli`), and the native async transport
// on top of it (`native`, which includes `cli`). Neither builds for wasm.
#[cfg(feature = "native")]
pub mod command_router;
#[cfg(feature = "cli")]
pub mod executor;

pub mod layout;
pub mod mime;
#[cfg(feature = "native")]
pub mod paths;
#[cfg(feature = "native")]
pub mod servers;
#[cfg(feature = "cli")]
pub mod session;
#[cfg(feature = "native")]
pub mod session_snapshot;
#[cfg(feature = "native")]
pub mod theme;
#[cfg(feature = "native")]
pub mod tmux_check;
#[cfg(feature = "native")]
pub mod trace;
#[cfg(feature = "native")]
pub mod transport;
#[cfg(feature = "native")]
pub mod worktrees;

pub use command_error::{CommandError, ErrorKind};
pub use error::{Result as TmuxResult, TmuxError};
pub use ids::{GroupId, IdError, PaneId, WindowId};

use serde::{Deserialize, Serialize};

// Re-export the key binding type
#[cfg(feature = "native")]
pub use transport::KeyBinding;

/// Default session name for tmuxy
pub const DEFAULT_SESSION_NAME: &str = "tmuxy";

/// Single-quote a value for interpolation into a tmux command string.
///
/// Session and buffer names come from outside tmuxy (`servers.json`, the
/// connect form, `set-buffer -b`), so they can contain whitespace (which would
/// silently truncate the target), a quote, or `;` (which would append extra
/// commands to the list). Built for wasm too: the control-mode state machine
/// writes commands of its own.
pub fn tmux_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

// ============================================
// Structured Cell Types (for eliminating double ANSI parsing)
// ============================================

/// Color representation for terminal cells
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum CellColor {
    /// Indexed color (0-255)
    Indexed(u8),
    /// RGB color
    Rgb { r: u8, g: u8, b: u8 },
}

/// Line/character size multiplier (`ESC # 3..6` DEC line sizes or `OSC 66` text sizing).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CellSize {
    #[serde(rename = "dwl")]
    DoubleWidth,
    #[serde(rename = "dhl-top")]
    DoubleHeightTop,
    #[serde(rename = "dhl-bottom")]
    DoubleHeightBottom,
}

/// Cell style attributes (only present if cell has non-default styling)
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CellStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<CellColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<CellColor>,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub bold: bool,
    /// SGR 2: faint/dim text. Apps like Claude Code use this for autosuggestions.
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub dim: bool,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub italic: bool,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub underline: bool,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub inverse: bool,
    /// OSC 8 hyperlink URL (if cell is part of a hyperlink)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Double-width / double-height cell size (`dwl`, `dhl-top`, `dhl-bottom`)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub size: Option<CellSize>,
}

pub(crate) fn is_false(b: &bool) -> bool {
    !*b
}

impl CellStyle {
    pub fn is_empty(&self) -> bool {
        self.fg.is_none()
            && self.bg.is_none()
            && !self.bold
            && !self.dim
            && !self.italic
            && !self.underline
            && !self.inverse
            && self.url.is_none()
            && self.size.is_none()
    }
}

/// A single terminal cell with character and optional styling
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalCell {
    /// The character(s) in this cell (usually single char, but can be multi-byte)
    #[serde(rename = "c")]
    pub char: String,
    /// Style attributes (only present if cell has styling)
    #[serde(rename = "s", skip_serializing_if = "Option::is_none")]
    pub style: Option<CellStyle>,
}

impl TerminalCell {
    pub fn new(char: String) -> Self {
        Self { char, style: None }
    }

    pub fn with_style(char: String, style: CellStyle) -> Self {
        let style = if style.is_empty() { None } else { Some(style) };
        Self { char, style }
    }
}

/// A line of terminal cells
pub type TerminalLine = Vec<TerminalCell>;

/// Pane content as structured cells (pre-parsed from ANSI)
pub type PaneContent = Vec<TerminalLine>;

/// One cell's character, as everything downstream spells it.
///
/// vt100 gives an unwritten cell — and the continuation half of a wide one —
/// an empty string; a space keeps the joined line on the column grid. Shared
/// so a hyperlink mark and the extraction that validates it are comparing the
/// same spelling of the same cell.
pub fn screen_cell_char(screen: &vt100::Screen, row: u16, col: u16) -> String {
    let raw = screen
        .cell(row, col)
        .map(|c| c.contents())
        .unwrap_or_default();
    if raw.is_empty() {
        " ".to_string()
    } else {
        raw.to_string()
    }
}

/// Extract structured cells from a vt100 screen.
/// This is the single source of truth for cell extraction, used by both
/// parse_ansi_to_cells (polling mode) and PaneState::get_content (control mode).
pub fn extract_cells_from_screen(screen: &vt100::Screen) -> PaneContent {
    extract_cells_with_urls(screen, None)
}

/// Extract structured cells from a vt100 screen with optional OSC parser for hyperlinks.
/// When osc_parser is provided, URL information is included in cell styles.
pub fn extract_cells_with_urls(
    screen: &vt100::Screen,
    osc_parser: Option<&control_mode::OscParser>,
) -> PaneContent {
    let (rows, cols) = screen.size();
    let mut lines: Vec<TerminalLine> = Vec::with_capacity(rows as usize);
    let mut prev_chars: Vec<String> = Vec::new();

    for row in 0..rows {
        let mut line: Vec<TerminalCell> = Vec::with_capacity(cols as usize);

        // The row's text first, as a unit: a hyperlink is only still a
        // hyperlink if the text it was written on is still there, and that is
        // judged per run rather than per cell (see `OscParser::row_urls`).
        let chars: Vec<String> = (0..cols)
            .map(|col| screen_cell_char(screen, row, col))
            .collect();
        let row_urls = osc_parser.map(|p| p.row_urls(row as u32, &chars));
        let row_sizes = osc_parser.map(|p| p.row_sizes(row as u32, &chars, &prev_chars));
        let row_line_size = match screen.row_line_size(row) {
            vt100::LineSize::Single => None,
            vt100::LineSize::DoubleWidth => Some(CellSize::DoubleWidth),
            vt100::LineSize::DoubleHeightTop => Some(CellSize::DoubleHeightTop),
            vt100::LineSize::DoubleHeightBottom => Some(CellSize::DoubleHeightBottom),
        };
        prev_chars.clone_from(&chars);

        // `chars` is consumed here, so collecting the row up front costs no
        // allocation over building each cell's string in place.
        for (col, mut char_content) in chars.into_iter().enumerate() {
            let col = col as u16;
            // `screen.cell` only returns None when row/col exceed the grid bounds,
            // which the `0..rows` / `0..cols` loops guarantee against.
            let Some(cell) = screen.cell(row, col) else {
                continue;
            };

            let fg = match cell.fgcolor() {
                vt100::Color::Default => None,
                vt100::Color::Idx(idx) => Some(CellColor::Indexed(idx)),
                vt100::Color::Rgb(r, g, b) => Some(CellColor::Rgb { r, g, b }),
            };

            let bg = match cell.bgcolor() {
                vt100::Color::Default => None,
                vt100::Color::Idx(idx) => Some(CellColor::Indexed(idx)),
                vt100::Color::Rgb(r, g, b) => Some(CellColor::Rgb { r, g, b }),
            };

            let url = row_urls
                .as_ref()
                .and_then(|urls| urls[col as usize].map(str::to_string));

            let osc_size = row_sizes.as_ref().and_then(|sizes| sizes[col as usize]);
            if let Some((_, ch)) = osc_size {
                if char_content == " " {
                    char_content = ch.to_string();
                }
            }
            let size = osc_size.map(|(sz, _)| sz).or(row_line_size);

            let style = CellStyle {
                fg,
                bg,
                bold: cell.bold(),
                dim: cell.dim(),
                italic: cell.italic(),
                underline: cell.underline(),
                inverse: cell.inverse(),
                url,
                size,
            };

            line.push(TerminalCell::with_style(char_content, style));
        }

        // Trim trailing empty cells (ignoring line-wide `row_line_size` on blank tail cells)
        while let Some(last) = line.last() {
            let unstyled_or_line_size_only = last.style.as_ref().is_none_or(|s| {
                s.fg.is_none()
                    && s.bg.is_none()
                    && !s.bold
                    && !s.dim
                    && !s.italic
                    && !s.underline
                    && !s.inverse
                    && s.url.is_none()
                    && s.size == row_line_size
            });
            if last.char.trim().is_empty() && unstyled_or_line_size_only {
                line.pop();
            } else {
                break;
            }
        }

        lines.push(line);
    }

    lines
}

/// Parse scrollback content into structured cells.
/// Uses the line count from the content itself as the height.
pub fn parse_scrollback_to_cells(content: &str, width: u32) -> PaneContent {
    let line_count = content.lines().count().max(1) as u32;
    parse_ansi_to_cells(content, width, line_count)
}

/// Parse ANSI content into structured cells using vt100 terminal emulation
pub fn parse_ansi_to_cells(content: &str, width: u32, height: u32) -> PaneContent {
    let mut parser = vt100::Parser::new(height as u16, width as u16, 0);

    let normalized = control_mode::normalize_capture_bytes(content.as_bytes());
    parser.process(&normalized);
    extract_cells_from_screen(parser.screen())
}

mod delta_types;
mod state_types;
pub use delta_types::*;
pub use state_types::*;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod lib_tests;
