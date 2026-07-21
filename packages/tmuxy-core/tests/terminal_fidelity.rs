//! Terminal emulation fidelity guardrails.
//!
//! tmuxy renders live pane content by feeding raw `%output` bytes through the
//! vt100 emulator, so any control sequence the emulator drops silently
//! corrupts what the user sees — with no error anywhere. The upstream
//! `vt100` 0.16.2 crate ignored six standard ECMA-48 sequences (HPA, HPR,
//! HVP, CHT, CBT, REP); `vendor/vt100` adds them, wired in through
//! `[patch.crates-io]`.
//!
//! The conformance matrix below is the regression net: every sequence here is
//! one that a real TUI was observed to emit, or is a close cousin of one. The
//! expected values match both xterm.js and tmux's own emulator, which were
//! used as differential references.

use tmuxy_core::{extract_cells_from_screen, parse_ansi_to_cells};

/// Render a single-row payload and return its text, trailing blanks removed.
fn row0(input: &str) -> String {
    parse_ansi_to_cells(input, 40, 1)[0]
        .iter()
        .map(|c| c.char.as_str())
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Render a payload over `h` rows and return row `r`.
fn row_at(input: &str, r: usize, h: u32) -> String {
    parse_ansi_to_cells(input, 40, h)[r]
        .iter()
        .map(|c| c.char.as_str())
        .collect::<String>()
        .trim_end()
        .to_string()
}

#[test]
fn cursor_positioning_sequences() {
    assert_eq!(row0("A\x1b[3CB"), "A   B", "CUF: cursor forward");
    assert_eq!(row0("ABC\x1b[2DX"), "AXC", "CUB: cursor back");
    assert_eq!(row0("\x1b[6GX"), "     X", "CHA: column absolute");
    assert_eq!(row0("\x1b[1;6HX"), "     X", "CUP: cursor position");

    // The four below were silently ignored by upstream vt100 0.16.2.
    assert_eq!(row0("\x1b[6`X"), "     X", "HPA: column absolute");
    assert_eq!(row0("A\x1b[3aB"), "A   B", "HPR: column relative");
    assert_eq!(
        row0("\x1b[1;6fY"),
        "     Y",
        "HVP: horizontal+vertical position"
    );
    assert_eq!(row0("A\x1b[1IB"), "A       B", "CHT: forward tabulation");
    assert_eq!(
        row0("\x1b[20G\x1b[2ZX"),
        "        X",
        "CBT: backward tabulation"
    );
}

#[test]
fn rep_repeats_preceding_character() {
    // REP (CSI Ps b) is how many TUIs emit runs cheaply. Dropping it collapses
    // a run to a single cell and shifts everything after it leftward.
    assert_eq!(row0("A\x1b[3b"), "AAAA", "REP: repeat glyph");
    assert_eq!(row0("Z \x1b[5bX"), "Z      X", "REP: repeat space");
}

#[test]
fn erase_insert_delete_sequences() {
    assert_eq!(row0("ABCDEF\x1b[1G\x1b[3X"), "   DEF", "ECH: erase chars");
    assert_eq!(row0("ABC\x1b[1G\x1b[2@"), "  ABC", "ICH: insert chars");
    assert_eq!(row0("ABCDEF\x1b[1G\x1b[2P"), "CDEF", "DCH: delete chars");
    assert_eq!(
        row0("ABCDEF\x1b[4G\x1b[K"),
        "ABC",
        "EL0: erase to end of line"
    );
    assert_eq!(
        row0("ABCDEF\x1b[3G\x1b[1K"),
        "   DEF",
        "EL1: erase to start of line"
    );
}

#[test]
fn line_and_row_sequences() {
    assert_eq!(row_at("\x1b[3dX", 2, 5), "X", "VPA: row absolute");
    assert_eq!(row_at("A\x1b[EB", 1, 5), "B", "CNL: next line");
    assert_eq!(row_at("\x1b[3;1HA\x1b[FB", 1, 5), "B", "CPL: previous line");
    assert_eq!(
        row_at("\x1b[1;1HA\x1b[2;1HB\x1b[1;1H\x1b[1L", 1, 5),
        "A",
        "IL: insert line"
    );
    assert_eq!(
        row_at("\x1b[1;1HA\x1b[2;1HB\x1b[1;1H\x1b[1M", 0, 5),
        "B",
        "DL: delete line"
    );
    assert_eq!(row0("A\tB"), "A       B", "HT: tab stop");
}

/// A double-width glyph must consume two grid cells — the second a spacer — so
/// that everything to its right keeps its column. Verified against xterm.js,
/// which puts the trailing `|` at column 28.
#[test]
fn wide_chars_consume_two_cells() {
    let row = &parse_ansi_to_cells(
        "wide:  \u{4f60}\u{597d}\u{4f60}\u{597d}\u{4f60}\u{597d}\u{4f60}\u{597d}\u{4f60}\u{597d}|",
        82,
        1,
    )[0];
    let bar = row.iter().position(|c| c.char == "|");
    assert_eq!(bar, Some(27), "wide chars must not shift following columns");
}

/// Replay of a real Antigravity CLI splash screen, captured off the pty with
/// `tmux pipe-pane`. It uses CUF, REP and CUB to lay out half-block art; before
/// the vt100 patch the space runs collapsed and the art sheared left.
///
/// Expected rows are tmux's own `capture-pane` output for the same bytes.
#[test]
fn agy_splash_matches_tmux_capture() {
    let bytes = include_bytes!("fixtures/agy-splash.bin");
    // Mirrors the live %output path: raw bytes, no capture-pane normalization.
    let mut parser = vt100::Parser::new(24, 82, 0);
    parser.process(bytes);
    let grid = extract_cells_from_screen(parser.screen());

    let rows: Vec<String> = grid
        .iter()
        .map(|l| {
            l.iter()
                .map(|c| c.char.as_str())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect();

    assert_eq!(
        rows[2],
        "      \u{2584}\u{2580}\u{2580}\u{2584}        Antigravity CLI 1.1.4"
    );
    assert_eq!(rows[3], "     \u{2580}\u{2580}\u{2580}\u{2580}\u{2580}\u{2580}       felipe.lds@live.com (Google AI Pro)");
    assert_eq!(rows[4], "    \u{2580}\u{2580}\u{2580}\u{2580}\u{2580}\u{2580}\u{2580}\u{2580}      Gemini 3.5 Flash (Medium)");
    assert_eq!(
        rows[5],
        "   \u{2584}\u{2580}\u{2580}    \u{2580}\u{2580}\u{2584}     CLI Project"
    );
    assert_eq!(
        rows[6],
        "  \u{2584}\u{2580}\u{2580}      \u{2580}\u{2580}\u{2584}"
    );
}
