//! `tmuxy pane capture --format html`: a screen as `capture-pane -e` prints
//! it, read by the same vt100 parser the panes are drawn from, as one
//! `<pre class="tmuxy-capture">` with a line per screen row. A run of cells
//! in one style is a span: palette colours and attributes are classes
//! (`fg-N`, `bg-N`, `bold`, `dim`, `italic`, `underline`, `inverse`) so a
//! page can theme them, and a true colour is an inline `color`/`background`.

use crate::{CellColor, CellStyle};
use std::fmt::Write as _;

pub fn capture_to_html(capture: &str) -> String {
    let rows = capture.lines().count().max(1);
    // A line's columns: one per byte bounds every character and escape
    // sequence, and a tab advances at most eight.
    let cols = capture
        .lines()
        .map(|line| line.len() + 7 * line.matches('\t').count())
        .max()
        .unwrap_or(0);
    let mut parser = vt100::Parser::new(
        crate::grid_side(rows as u32),
        crate::grid_side(cols as u32),
        0,
    );
    parser.process(&crate::control_mode::normalize_capture_bytes(
        capture.as_bytes(),
    ));
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let mut html = String::from("<pre class=\"tmuxy-capture\">\n");
    for row in 0..rows {
        push_row(&mut html, screen, row, cols);
        html.push('\n');
    }
    html.push_str("</pre>\n");
    html
}

/// One screen row up to its last written cell: the cells past it are the
/// grid's, not the capture's.
fn push_row(html: &mut String, screen: &vt100::Screen, row: u16, cols: u16) {
    let end = (0..cols)
        .rev()
        .find(|&col| screen.cell(row, col).is_some_and(vt100::Cell::has_contents))
        .map_or(0, |col| col + 1);
    let mut open: Option<CellStyle> = None;
    for col in 0..end {
        let Some(cell) = screen.cell(row, col) else {
            continue;
        };
        if cell.is_wide_continuation() {
            continue;
        }
        let style = Some(CellStyle::of_sgr(cell)).filter(|style| !style.is_empty());
        if style != open {
            if open.is_some() {
                html.push_str("</span>");
            }
            if let Some(style) = &style {
                push_span(html, style);
            }
            open = style;
        }
        push_escaped(html, &crate::screen_cell_char(screen, row, col));
    }
    if open.is_some() {
        html.push_str("</span>");
    }
}

fn push_span(html: &mut String, style: &CellStyle) {
    let mut classes = Vec::new();
    let mut inline = String::new();
    for (on, class) in [
        (style.bold, "bold"),
        (style.dim, "dim"),
        (style.italic, "italic"),
        (style.underline, "underline"),
        (style.inverse, "inverse"),
    ] {
        if on {
            classes.push(class.to_string());
        }
    }
    for (color, class, property) in [(&style.fg, "fg", "color"), (&style.bg, "bg", "background")] {
        match color {
            Some(CellColor::Indexed(idx)) => classes.push(format!("{class}-{idx}")),
            Some(CellColor::Rgb { r, g, b }) => {
                let _ = write!(inline, "{property}:rgb({r},{g},{b});");
            }
            None => {}
        }
    }
    html.push_str("<span");
    if !classes.is_empty() {
        let _ = write!(html, " class=\"{}\"", classes.join(" "));
    }
    if !inline.is_empty() {
        let _ = write!(html, " style=\"{inline}\"");
    }
    html.push('>');
}

fn push_escaped(html: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '&' => html.push_str("&amp;"),
            '<' => html.push_str("&lt;"),
            '>' => html.push_str("&gt;"),
            '"' => html.push_str("&quot;"),
            _ => html.push(c),
        }
    }
}

#[cfg(test)]
mod tests;
