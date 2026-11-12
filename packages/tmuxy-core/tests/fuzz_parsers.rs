//! Fuzzing the parsers that read untrusted input: what tmux writes on the
//! control-mode connection (its framing, and the octal escapes of pane
//! output), and what a pane's program prints (terminal sequences, OSC
//! strings, images). Anything a program in a pane prints reaches these, so
//! none of them may panic, hang or grow without bound, and none may let pane
//! output pass for tmux's own framing.
//!
//! In-process and random, on stable Rust (proptest): inputs are built from
//! hostile fragments (sequence starts, huge parameters, split UTF-8, tmux's
//! own guard lines) mixed with random bytes. `TMUXY_FUZZ_CASES` sets the
//! cases per target: a few dozen in `cargo test`, many more in the nightly
//! fuzz job (`bin/fuzz`), which caps time, memory and cores. A failure is
//! shrunk and saved to `fuzz_parsers.proptest-regressions`, to be replayed
//! first on every later run.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use tmuxy_core::control_mode::{decode_octal, ControlModeEvent, ImageParser, Parser};

mod common_aggregator_props;
use common_aggregator_props::seeded_aggregator;

fn config() -> ProptestConfig {
    let cases = std::env::var("TMUXY_FUZZ_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(48);
    ProptestConfig {
        cases,
        ..ProptestConfig::default()
    }
}

/// Pieces a hostile program prints: the starts of every sequence family the
/// pane path reads, their terminators, huge parameters, split and invalid
/// UTF-8, and lines shaped like tmux's and tmuxy's own framing.
const FRAGMENTS: &[&[u8]] = &[
    b"\x1b]7501;",
    b"\x1b]133;A\x07",
    b"\x1b]133;B\x07",
    b"\x1b]133;D;",
    b"\x1b]8;;",
    b"\x1b]8;id=x;https://example.com/\x1b\\",
    b"\x1b]52;c;",
    b"aGVsbG8=",
    b"\x1b]0;",
    b"\x1b]2;",
    b"\x1b]1337;File=inline=1;width=",
    b"\x1bPq",
    b"#0;2;0;0;0#0~~@@",
    b"\x1b_G",
    b"a=T,f=100,s=1,v=1;",
    b"\x1b\\",
    b"\x07",
    b"\x1b[",
    b"\x1b[?",
    b"999999999",
    b";",
    b"H",
    b"@",
    b"r",
    b"m",
    b"L",
    b"\x1b[?1049h",
    b"\x1b[?2004h",
    b"\x1b[38;2;",
    b"\x1bc",
    b"\x1b",
    b"\r\n",
    "語".as_bytes(),
    b"\xe8\xaa",
    b"\xff\xfe",
    b"\x00",
    b"%end 1 1 1\n",
    b"%exit\n",
    b"TMUXY_RPY_END 1\n",
    b"TMUXY_CAP_END\n",
];

/// Prefixes of the lines tmux writes on the control-mode connection, and of
/// the marker lines tmuxy wraps its own replies in.
const LINE_PREFIXES: &[&str] = &[
    "%begin ",
    "%end ",
    "%error ",
    "%output %",
    "%extended-output %",
    "%window-add @",
    "%window-close @",
    "%layout-change @",
    "%session-changed $",
    "%pane-mode-changed %",
    "%subscription-changed ",
    "%pause %",
    "%continue %",
    "%client-detached ",
    "%exit",
    "TMUXY_RPY_BEGIN ",
    "TMUXY_LS_BEGIN ",
    "",
];

fn hostile_bytes() -> impl Strategy<Value = Vec<u8>> {
    let part = prop_oneof![
        4 => prop::sample::select(FRAGMENTS).prop_map(<[u8]>::to_vec),
        2 => prop::collection::vec(any::<u8>(), 0..24),
        1 => (0u64..u64::MAX).prop_map(|n| n.to_string().into_bytes()),
    ];
    prop::collection::vec(part, 0..48).prop_map(|parts| parts.concat())
}

/// One line as tmux could write it: a known prefix and a hostile tail, with
/// no newline (lines are split before parsing).
fn control_line() -> impl Strategy<Value = Vec<u8>> {
    (prop::sample::select(LINE_PREFIXES), hostile_bytes()).prop_map(|(prefix, tail)| {
        let mut line = prefix.as_bytes().to_vec();
        line.extend(tail.into_iter().filter(|b| *b != b'\n'));
        line
    })
}

/// tmux's escaping of pane output on `%output`: a control byte or a
/// backslash as `\ooo`.
fn tmux_escape(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for &b in bytes {
        if b < b' ' || b == b'\\' {
            out.extend(format!("\\{b:03o}").into_bytes());
        } else {
            out.push(b);
        }
    }
    out
}

const GUARD: &str = "1700000000 7 1";

/// A line inside a reply block: anything tmux could write, and often a
/// well-formed one (pane output, a notification, another block's guard).
fn body_line() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        2 => control_line(),
        1 => prop::sample::select(&[
            "%output %1 hello",
            "%window-add @9",
            "%end 1 1 1",
            "%error 1700000000 8 1",
            "%exit",
            "%begin 1700000000 8 1",
        ][..])
        .prop_map(|line| line.as_bytes().to_vec()),
    ]
}

proptest! {
    #![proptest_config(config())]

    /// Any sequence of lines: never a panic.
    #[test]
    fn control_mode_lines_never_panic(lines in prop::collection::vec(control_line(), 0..64)) {
        let mut parser = Parser::new();
        for line in lines {
            let _ = parser.parse_line(line);
        }
    }

    /// Inside a reply block, nothing but its own guard ends it: a body that
    /// prints `%end`, `%exit` or well-formed `%output` lines is body, read as
    /// no event at all, and the guard then closes the block as its reply.
    #[test]
    fn a_reply_body_cannot_end_its_block_or_pass_for_output(
        body in prop::collection::vec(body_line(), 0..32),
    ) {
        let mut parser = Parser::new();
        parser.parse_line(format!("%begin {GUARD}"));
        for line in body {
            let text = String::from_utf8_lossy(&line);
            if text.starts_with(&format!("%end {GUARD}")) || text.starts_with(&format!("%error {GUARD}")) {
                continue;
            }
            let event = parser.parse_line(&line);
            prop_assert!(event.is_none(), "body line {text:?} read as {event:?}");
        }
        let reply = parser.parse_line(format!("%end {GUARD}"));
        prop_assert!(matches!(reply, Some(ControlModeEvent::CommandResponse { .. })), "{reply:?}");
        let after = parser.parse_line("%output %1 ok");
        prop_assert!(matches!(after, Some(ControlModeEvent::Output { .. })), "{after:?}");
    }

    /// tmux's octal escaping reads back as the bytes it escaped.
    #[test]
    fn octal_escapes_round_trip(bytes in prop::collection::vec(any::<u8>(), 0..256)) {
        prop_assert_eq!(decode_octal(tmux_escape(&bytes)), bytes);
    }

    /// Malformed escapes never panic, and never grow the text.
    #[test]
    fn octal_decoding_never_grows(input in prop::collection::vec(any::<u8>(), 0..256)) {
        let decoded = decode_octal(&input);
        prop_assert!(decoded.len() <= input.len());
    }

    /// Image sequences of every protocol, broken any way: never a panic, and
    /// what passes on to the terminal, all chunks together, is no more than
    /// what came in. (One chunk's share can be more: the unfinished start of
    /// what could be an image, held back, comes out with the next.)
    #[test]
    fn image_sequences_never_panic(chunks in prop::collection::vec(hostile_bytes(), 1..6)) {
        let mut images = ImageParser::new();
        let (mut fed, mut passed) = (0, 0);
        for chunk in chunks {
            fed += chunk.len();
            passed += images.process(&chunk).clean_bytes.len();
            prop_assert!(passed <= fed, "{passed} bytes out of {fed}");
        }
    }

    /// Whatever a pane prints, split across `%output` lines any way, through
    /// tmux's escaping and the parser into the state: never a panic, and every
    /// pane keeps its size, its rows and a cursor inside it.
    #[test]
    fn hostile_pane_output_keeps_every_pane_in_bounds(
        chunks in prop::collection::vec(hostile_bytes(), 1..8),
    ) {
        let mut parser = Parser::new();
        let mut agg = seeded_aggregator();
        let before: Vec<(u32, u32)> = agg.to_tmux_state().panes.iter().map(|p| (p.width, p.height)).collect();
        for chunk in chunks {
            let mut line = b"%output %0 ".to_vec();
            line.extend(tmux_escape(&chunk));
            if let Some(event) = parser.parse_line(line) {
                agg.step(event);
            }
        }
        let state = agg.to_tmux_state();
        let after: Vec<(u32, u32)> = state.panes.iter().map(|p| (p.width, p.height)).collect();
        prop_assert_eq!(before, after);
        for pane in &state.panes {
            prop_assert!(pane.cursor_x <= pane.width, "cursor x {} past {}", pane.cursor_x, pane.width);
            prop_assert!(pane.cursor_y < pane.height.max(1), "cursor y {} past {}", pane.cursor_y, pane.height);
            prop_assert!(pane.content.len() <= pane.height as usize, "{} rows in {}", pane.content.len(), pane.height);
        }
    }
}
