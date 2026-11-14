pub mod agent_dialog;
pub mod argv;
#[cfg(feature = "cli")]
pub mod ask;
pub mod capture_html;
pub mod cli_contract;
pub mod client_size;
pub mod command_error;
pub mod constants;
pub mod control_mode;
pub mod error;
pub mod groups;
pub mod ids;

pub mod command_router;
#[cfg(feature = "cli")]
pub mod float;

#[cfg(feature = "native")]
pub mod diff_review;
#[cfg(feature = "native")]
pub mod host;
pub mod layout;
#[cfg(feature = "cli")]
pub mod list_keys;
#[cfg(feature = "native")]
pub mod logging;
pub mod mime;
pub mod pane_meta;
#[cfg(feature = "cli")]
pub mod paths;
pub mod permissions;
#[cfg(feature = "native")]
pub mod plugins;
#[cfg(feature = "native")]
pub mod ports;
#[cfg(feature = "native")]
pub mod preview;
#[cfg(feature = "cli")]
pub mod private_files;
#[cfg(feature = "cli")]
pub mod profiles;
pub mod program;
pub mod random;
#[cfg(feature = "cli")]
pub mod run_shell;
#[cfg(feature = "native")]
pub mod safe_git;
#[cfg(feature = "native")]
pub mod servers;
#[cfg(feature = "cli")]
pub mod session;
#[cfg(feature = "native")]
pub mod session_snapshot;
pub mod stamp;
#[cfg(feature = "native")]
pub mod theme;
#[cfg(feature = "native")]
pub mod tmux_check;
pub mod tmux_command;
pub mod tmux_compat;
#[cfg(feature = "native")]
pub mod trace;
#[cfg(feature = "native")]
pub mod worktrees;

pub use command_error::{CommandError, ErrorKind};
pub use error::TmuxError;
pub use ids::{GroupId, IdError, PaneId, WindowId};

use serde::{Deserialize, Serialize};

pub const DEFAULT_SESSION_NAME: &str = "tmuxy";

/// Single-quote a value for interpolation into a tmux command string.
///
/// Session and buffer names come from outside tmuxy (`servers.json`, the
/// `tmuxy session connect`, `set-buffer -b`), so they can contain whitespace (which would
/// silently truncate the target), a quote, or `;` (which would append extra
/// commands to the list). Built for wasm too: the control-mode state machine
/// writes commands of its own.
///
/// Control mode reads one command per line, and nothing escapes inside single
/// quotes: a value holding a newline (a multi-line clipboard, say) would end
/// the command there and run the rest as commands of its own. Such a value
/// goes double-quoted instead ([`tmux_double_quoted`]).
pub fn tmux_quote(value: &str) -> String {
    if value.chars().any(char::is_control) {
        return tmux_double_quoted(value);
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// `value` as one double-quoted tmux argument on one command line: the
/// characters tmux's parser reads inside double quotes (`"`, `\`, `$`, and
/// the backtick) escaped, leading `~` octal-escaped so tmux does not
/// tilde-expand it, and every control character (C0, DEL, and C1) encoded as
/// UTF-8 octal byte escapes so a newline cannot end the command.
pub fn tmux_double_quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for (idx, c) in value.chars().enumerate() {
        match c {
            '~' if idx == 0 => out.push_str("\\176"),
            '"' | '\\' | '$' | '`' => {
                out.push('\\');
                out.push(c);
            }
            c if c.is_control() => {
                let mut buf = [0u8; 4];
                for &b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("\\{:03o}", b));
                }
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum CellColor {
    Indexed(u8),
    Rgb { r: u8, g: u8, b: u8 },
}

impl CellColor {
    /// A vt100 colour, `None` for the terminal's default.
    fn of(color: vt100::Color) -> Option<Self> {
        match color {
            vt100::Color::Default => None,
            vt100::Color::Idx(idx) => Some(Self::Indexed(idx)),
            vt100::Color::Rgb(r, g, b) => Some(Self::Rgb { r, g, b }),
        }
    }
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CellStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<CellColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<CellColor>,
    #[serde(skip_serializing_if = "is_false")]
    #[serde(default)]
    pub bold: bool,
    /// SGR 2 (faint).
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
    /// OSC 8 hyperlink URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub size: Option<CellSize>,
}

pub(crate) fn is_false(b: &bool) -> bool {
    !*b
}

impl CellStyle {
    /// No attribute set: the default style, so a field added to the struct
    /// counts the moment it exists.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// What SGR set on a vt100 cell: its colours and attributes, with no
    /// hyperlink or size, which the screen and its rows hold.
    pub(crate) fn of_sgr(cell: &vt100::Cell) -> Self {
        Self {
            fg: CellColor::of(cell.fgcolor()),
            bg: CellColor::of(cell.bgcolor()),
            bold: cell.bold(),
            dim: cell.dim(),
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
            url: None,
            size: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalCell {
    /// A grapheme: can be more than one char.
    #[serde(rename = "c")]
    pub char: String,
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

pub type TerminalLine = Vec<TerminalCell>;

pub type PaneContent = Vec<TerminalLine>;

/// vt100 gives an unwritten cell, and the continuation half of a wide one, an
/// empty string; a kitty image placeholder (U+10EEEE) is no text either. A
/// space keeps the joined line on the column grid.
pub fn screen_cell_char(screen: &vt100::Screen, row: u16, col: u16) -> String {
    let raw = screen
        .cell(row, col)
        .map(|c| c.contents())
        .unwrap_or_default();
    if raw.is_empty() || raw.starts_with('\u{10eeee}') {
        " ".to_string()
    } else {
        raw.to_string()
    }
}

pub fn extract_cells_from_screen(screen: &vt100::Screen) -> PaneContent {
    let (rows, cols) = screen.size();
    let mut lines: Vec<TerminalLine> = Vec::with_capacity(rows as usize);

    for row in 0..rows {
        let mut line: Vec<TerminalCell> = Vec::with_capacity(cols as usize);

        let row_line_size = match screen.row_line_size(row) {
            vt100::LineSize::Single => None,
            vt100::LineSize::DoubleWidth => Some(CellSize::DoubleWidth),
            vt100::LineSize::DoubleHeightTop => Some(CellSize::DoubleHeightTop),
            vt100::LineSize::DoubleHeightBottom => Some(CellSize::DoubleHeightBottom),
        };

        for col in 0..cols {
            let Some(cell) = screen.cell(row, col) else {
                continue;
            };
            let mut char_content = screen_cell_char(screen, row, col);

            // An `OSC 66 ; s=2` character covers the cell below its own too:
            // that cell shows the character's bottom half while it holds
            // nothing else.
            let size = match cell.text_size() {
                vt100::TextSize::DoubleHeight => Some(CellSize::DoubleHeightTop),
                vt100::TextSize::DoubleWidth => Some(CellSize::DoubleWidth),
                vt100::TextSize::Normal => {
                    let above = row
                        .checked_sub(1)
                        .filter(|&up| {
                            screen
                                .cell(up, col)
                                .is_some_and(|c| c.text_size() == vt100::TextSize::DoubleHeight)
                        })
                        .map(|up| screen_cell_char(screen, up, col))
                        .filter(|top| char_content == " " || char_content == *top);
                    match above {
                        Some(top) => {
                            char_content = top;
                            Some(CellSize::DoubleHeightBottom)
                        }
                        None => row_line_size,
                    }
                }
            };

            let style = CellStyle {
                url: screen.hyperlink(cell).map(str::to_string),
                size,
                ..CellStyle::of_sgr(cell)
            };

            line.push(TerminalCell::with_style(char_content, style));
        }

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
        // Kept per pane between updates, a blank row would otherwise hold a
        // row's worth of cells (64 B each) for nothing.
        line.shrink_to_fit();

        lines.push(line);
    }

    lines
}

pub fn parse_scrollback_to_cells(content: &str, width: u32) -> PaneContent {
    let line_count = content.lines().count().max(1) as u32;
    parse_ansi_to_cells(content, width, line_count)
}

/// A pane side as a vt100 grid side, saturated at `u16::MAX`: a capture of a
/// pane with a deep history can run past 65,535 lines, and a taller capture
/// keeps its last 65,535. vt100 itself makes a zero side one.
pub(crate) fn grid_side(n: u32) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

pub fn parse_ansi_to_cells(content: &str, width: u32, height: u32) -> PaneContent {
    let mut parser = vt100::Parser::new(grid_side(height), grid_side(width), 0);

    let normalized = control_mode::normalize_capture_bytes(content.as_bytes());
    parser.process(&normalized);
    extract_cells_from_screen(parser.screen())
}

mod delta_types;
mod state_types;
pub use delta_types::*;
pub use state_types::*;

#[cfg(test)]
mod lib_tests;
