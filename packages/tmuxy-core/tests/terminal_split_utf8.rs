//! A pane's output reaches the terminal emulator in pieces cut wherever
//! tmux's reads ended, so one character can arrive in two writes. The screen
//! must not depend on where the cut fell. vte decoded a split character on a
//! separate path that, with an invalid byte soon after, dropped the valid
//! characters in between; the parser fuzzer found it (`C2 80 20 80`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

fn screen(writes: &[&[u8]]) -> (String, (u16, u16)) {
    let mut parser = vt100::Parser::new(12, 80, 0);
    for write in writes {
        parser.process(write);
    }
    let screen = parser.screen();
    (screen.contents(), screen.cursor_position())
}

#[test]
fn a_character_split_across_writes_reads_as_if_written_whole() {
    let inputs: [&[u8]; 5] = [
        b"\xc2\x80 \x80",
        "é ab\u{80}".as_bytes(),
        b"\xc3\xa9ab\xff",
        "語x\u{1f525}y".as_bytes(),
        b"\xe8\xaa\x9e\x1b[31mz",
    ];
    for bytes in inputs {
        let whole = screen(&[bytes]);
        for cut in 1..bytes.len() {
            assert_eq!(
                screen(&[&bytes[..cut], &bytes[cut..]]),
                whole,
                "{bytes:?} cut at {cut}"
            );
        }
        // One byte a write, as a program repainting byte by byte sends it.
        let bytewise: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(screen(&bytewise), whole, "{bytes:?} a byte at a time");
    }
}
