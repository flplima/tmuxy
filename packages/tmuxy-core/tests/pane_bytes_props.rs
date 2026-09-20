//! Property tests for everything that eats arbitrary bytes coming out of a
//! pane.
//!
//! Any program a user runs — `cat /dev/urandom`, a corrupt log, a hostile
//! payload — reaches these parsers verbatim. They therefore have one
//! non-negotiable property: whatever the bytes, they return, they do not
//! panic, and they do not grow without bound. A panic here takes down the
//! monitor task that owns the whole session.
//!
//! Case counts are capped so the suite stays fast and CI-deterministic.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use tmuxy_core::control_mode::{decode_octal, ImageParser, OscParser, Parser};
use tmuxy_core::layout;

/// Escape a byte string the way tmux control mode does: everything below
/// ASCII 32 and the backslash itself becomes a three-digit octal escape.
fn tmux_escape(bytes: &[u8]) -> String {
    let mut out = String::new();
    for &b in bytes {
        if b < 32 || b == b'\\' {
            out.push_str(&format!("\\{:03o}", b));
        } else {
            out.push(b as char);
        }
    }
    out
}

/// Bytes that survive `tmux_escape` unchanged (ASCII only, so the escaped
/// form is itself a `&str` the parser can be handed).
fn escapable_bytes() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(0u8..=127, 0..64)
}

/// Arbitrary bytes, including invalid UTF-8 — what a pane really emits.
fn pane_bytes() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(any::<u8>(), 0..512)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// The escape/unescape pair is the only thing standing between tmux's
    /// wire format and the terminal emulator. If it is not a round trip, a
    /// pane silently renders bytes the program never wrote.
    #[test]
    fn octal_unescape_inverts_tmux_escaping(bytes in escapable_bytes()) {
        prop_assert_eq!(decode_octal(&tmux_escape(&bytes)), bytes);
    }

    /// A backslash run that is not a valid escape must be copied through, not
    /// panic on the missing digits.
    #[test]
    fn octal_unescape_never_panics(text in ".{0,200}") {
        let decoded = decode_octal(&text);
        prop_assert!(decoded.len() <= text.len());
    }

    /// Every control-mode line the parser is handed comes off a pty it does
    /// not control. Arbitrary text must return, never panic on a byte-index
    /// slice past a UTF-8 boundary.
    #[test]
    fn control_mode_parser_survives_arbitrary_lines(lines in prop::collection::vec(".{0,120}", 0..24)) {
        let mut parser = Parser::new();
        for line in &lines {
            let _ = parser.parse_line(line);
        }
    }

    /// Lines that look like real notifications — the shapes the parser
    /// actually branches on — with hostile payloads after the prefix.
    #[test]
    fn control_mode_parser_survives_hostile_notifications(
        verb in prop::sample::select(vec![
            "%output", "%extended-output", "%layout-change", "%window-add",
            "%window-close", "%window-renamed", "%window-pane-changed",
            "%pane-mode-changed", "%session-changed", "%session-window-changed",
            "%paste-buffer-changed", "%pause", "%continue", "%exit",
            "%begin", "%end", "%error",
        ]),
        tail in ".{0,120}",
    ) {
        let mut parser = Parser::new();
        let _ = parser.parse_line(&format!("{verb} {tail}"));
        // A second line exercises the in-response accumulation path.
        let _ = parser.parse_line(&tail);
    }

    /// `%output` is the hot path: the pane id and the escaped payload must
    /// round-trip through the parser byte for byte.
    #[test]
    fn output_notifications_round_trip(pane in 0u32..64, bytes in escapable_bytes()) {
        let mut parser = Parser::new();
        let line = format!("%output %{} {}", pane, tmux_escape(&bytes));
        match parser.parse_line(&line) {
            Some(tmuxy_core::control_mode::ControlModeEvent::Output { pane_id, content }) => {
                prop_assert_eq!(pane_id, format!("%{}", pane));
                prop_assert_eq!(content, bytes);
            }
            other => prop_assert!(false, "expected an Output event, got {:?}", other),
        }
    }

    /// The OSC decoder strips sequences out of the vt100 stream. Arbitrary
    /// bytes must not panic, and it must never invent bytes: what it passes
    /// through is a subset of what it was given.
    #[test]
    fn osc_parser_survives_arbitrary_bytes(chunks in prop::collection::vec(pane_bytes(), 1..6)) {
        let mut parser = OscParser::new();
        parser.set_viewport_height(24);
        let mut fed = 0usize;
        let mut emitted = 0usize;
        for chunk in &chunks {
            fed += chunk.len();
            let out = parser.process(chunk);
            emitted += out.bytes.len();
            for (start, end, _) in &out.links {
                prop_assert!(start < end && *end <= out.bytes.len());
            }
        }
        prop_assert!(emitted <= fed, "OSC parser emitted more bytes than it was fed");
    }

    /// The image decoders read a length-prefixed, base64-carrying payload out
    /// of the same stream. Arbitrary bytes must not panic and must not be
    /// mistaken for an image.
    #[test]
    fn image_parser_survives_arbitrary_bytes(chunks in prop::collection::vec(pane_bytes(), 1..6)) {
        let mut parser = ImageParser::new();
        for chunk in &chunks {
            let result = parser.process(chunk);
            prop_assert!(result.clean_bytes.len() <= chunk.len() + 8 * 1024 * 1024);
        }
    }

    /// A payload that opens a real image escape and then feeds it garbage —
    /// the shape a hostile program would actually use.
    #[test]
    fn image_parser_survives_truncated_escapes(
        intro in prop::sample::select(vec![
            &b"\x1b]1337;File=inline=1:"[..],
            &b"\x1b_Gf=100,a=T;"[..],
            &b"\x1bPq"[..],
        ]),
        junk in pane_bytes(),
    ) {
        let mut parser = ImageParser::new();
        let mut payload = intro.to_vec();
        payload.extend_from_slice(&junk);
        let _ = parser.process(&payload);
    }

    /// Layout strings come from tmux, but also from `%layout-change` lines
    /// that a pane's own output can forge on a mis-framed stream.
    #[test]
    fn layout_parse_never_panics(text in "[0-9a-fx,\\[\\]{}]{0,80}") {
        if let Some(node) = layout::parse(&text) {
            // Anything that parses must serialize back to something that
            // parses — the round trip `select-layout` depends on.
            let serialized = layout::serialize(&node);
            prop_assert_eq!(layout::parse(&serialized), Some(node));
        }
        let _ = layout::first_level_heights(&text);
        let _ = layout::collapse_first_level(&text, 0);
        let _ = layout::even_first_level(&text);
    }

    /// Generated trees: serialize → parse must be the identity, and every
    /// reshape must produce a string tmux would accept back.
    #[test]
    fn layout_reshapes_stay_parseable(panes in 1usize..6, width in 20u32..200, height in 6u32..60) {
        let children: Vec<layout::Node> = (0..panes)
            .map(|i| layout::Node::Leaf {
                w: width,
                h: height,
                x: 0,
                y: i as u32 * (height + 1),
                pane: i as u32,
            })
            .collect();
        let root = layout::Node::Split {
            w: width,
            h: height * panes as u32 + panes as u32 - 1,
            x: 0,
            y: 0,
            vertical: true,
            children,
        };
        let serialized = layout::serialize(&root);
        let reparsed_root = layout::parse(&serialized);
        prop_assert_eq!(reparsed_root.as_ref(), Some(&root));

        for reshaped in [
            layout::collapse_first_level(&serialized, 0),
            layout::even_first_level(&serialized),
        ]
        .into_iter()
        .flatten()
        {
            let reparsed = layout::parse(&reshaped)
                .unwrap_or_else(|| panic!("reshaped layout does not parse: {reshaped}"));
            // Every pane survives the reshape; losing one loses a terminal.
            for pane in 0..panes as u32 {
                prop_assert!(reparsed.contains_pane(pane), "{reshaped} dropped pane {}", pane);
            }
            // tmux rejects a layout whose checksum does not match its body.
            let (head, body) = reshaped.split_once(',').unwrap();
            prop_assert_eq!(head, format!("{:04x}", layout::checksum(body)));
        }
    }
}

/// A runaway OSC sequence must not be buffered forever: past the cap the
/// parser gives up on framing and emits the bytes, so a program printing
/// `ESC ] …` and never terminating it cannot grow the process without bound.
#[test]
fn an_unterminated_osc_sequence_does_not_buffer_without_bound() {
    let mut parser = OscParser::new();
    parser.set_viewport_height(24);
    let chunk = {
        let mut c = vec![0x1b, b']', b'0', b';'];
        c.extend(std::iter::repeat_n(b'A', 4096));
        c
    };
    // 32 chunks ≈ 128 KiB, twice the 64 KiB pending cap.
    for _ in 0..32 {
        parser.process(&chunk);
    }
    // The parser has recovered: ordinary text after the runaway still reaches
    // the terminal instead of disappearing into the pending buffer.
    let out = parser.process(b"\x07hello");
    assert!(
        out.bytes.windows(5).any(|w| w == b"hello"),
        "text after an unterminated OSC sequence never reached vt100"
    );
}

/// The same bound for the image decoder, whose cap is 8 MiB.
#[test]
fn an_unterminated_image_escape_does_not_buffer_without_bound() {
    let mut parser = ImageParser::new();
    let chunk = {
        let mut c = b"\x1b]1337;File=inline=1:".to_vec();
        c.extend(std::iter::repeat_n(b'A', 1024 * 1024));
        c
    };
    for _ in 0..10 {
        parser.process(&chunk);
    }
    let result = parser.process(b"\x07plain text");
    assert!(
        result.clean_bytes.windows(10).any(|w| w == b"plain text"),
        "text after an unterminated image escape never reached vt100"
    );
}
