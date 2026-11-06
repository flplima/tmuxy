use super::*;

fn parser() -> vt100::Parser<OscRequests> {
    vt100::Parser::new_with_callbacks(24, 80, 0, OscRequests::default())
}

#[test]
fn osc52_writes_the_decoded_text() {
    let mut parser = parser();
    parser.process(b"\x1b]52;c;aGVsbG8=\x07");
    assert_eq!(
        parser.callbacks_mut().take_clipboard(),
        Some("hello".to_string())
    );
    assert_eq!(parser.callbacks_mut().take_clipboard(), None);
}

#[test]
fn osc52_split_across_writes_still_arrives() {
    let mut parser = parser();
    parser.process(b"\x1b]52;c;aGVs");
    parser.process(b"bG8=\x1b\\");
    assert_eq!(
        parser.callbacks_mut().take_clipboard(),
        Some("hello".to_string())
    );
}

#[test]
fn osc0_and_osc2_set_the_title_and_osc1_does_not() {
    let mut parser = parser();
    parser.process(b"\x1b]1;icon\x07");
    assert_eq!(parser.callbacks_mut().take_title(), None);
    parser.process(b"\x1b]0;vim; make\x07");
    assert_eq!(
        parser.callbacks_mut().take_title(),
        Some("vim; make".to_string()),
        "a title keeps its semicolons"
    );
    parser.process(b"\x1b]2;zsh\x1b\\");
    assert_eq!(parser.callbacks_mut().take_title(), Some("zsh".to_string()));
}

#[test]
fn osc_title_and_clipboard_enforce_size_caps() {
    let mut parser = parser();

    let huge_title = format!("\x1b]2;{}é\x07", "a".repeat(MAX_TITLE_BYTES - 1));
    parser.process(huge_title.as_bytes());
    let title = parser.callbacks_mut().take_title().expect("title recorded");
    assert_eq!(title.len(), MAX_TITLE_BYTES - 1);

    let huge_clip = format!(
        "\x1b]52;c;{}\x07",
        "A".repeat(MAX_CLIPBOARD_BASE64_BYTES + 4)
    );
    parser.process(huge_clip.as_bytes());
    assert_eq!(parser.callbacks_mut().take_clipboard(), None);
}
