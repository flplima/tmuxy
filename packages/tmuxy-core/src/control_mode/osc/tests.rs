use super::*;

/// SEC-22. One URL, many cells: the map shares it rather than copying it.
#[test]
fn cells_under_one_link_share_its_url() {
    let mut parser = OscParser::new();
    let out = parser.process(b"\x1b]8;;https://example.com\x07label\x1b]8;;\x07");
    let (_, _, url) = &out.links[0];
    for (col, ch) in "label".chars().enumerate() {
        parser.mark_cell(0, col as u32, url, &ch.to_string());
    }
    // The link's own Arc plus five cells: six strong references, one string.
    assert_eq!(Arc::strong_count(url), 6);
}

#[test]
fn an_oversized_url_opens_no_link() {
    let mut parser = OscParser::new();
    let url = "https://example.com/".to_string() + &"a".repeat(MAX_HYPERLINK_URL_BYTES);
    let seq = format!("\x1b]8;;{url}\x07text\x1b]8;;\x07");
    let out = parser.process(seq.as_bytes());
    assert_eq!(out.bytes, b"text");
    assert!(out.links.is_empty());
    assert!(parser.active_url().is_none());
}

#[test]
fn osc8_strips_the_escapes_and_reports_the_linked_span() {
    let mut parser = OscParser::new();

    let input = b"\x1b]8;;https://example.com\x07hello\x1b]8;;\x07";
    let out = parser.process(input);

    // Output has the OSC sequences stripped...
    assert_eq!(out.bytes, b"hello");
    // ...and the caller is told exactly which of those bytes were linked,
    // so it can ask vt100 where they landed. This parser maps no cells
    // itself — it has no cursor to map them with.
    assert_eq!(out.links, vec![(0, 5, "https://example.com".into())]);
}

#[test]
fn text_outside_the_link_is_not_in_the_span() {
    let mut parser = OscParser::new();
    let out = parser.process(b"before\x1b]8;;http://x\x07IN\x1b]8;;\x07after");
    assert_eq!(out.bytes, b"beforeINafter");
    assert_eq!(out.links, vec![(6, 8, "http://x".into())]);
}

#[test]
fn two_links_in_one_chunk_get_one_span_each() {
    let mut parser = OscParser::new();
    let out =
        parser.process(b"\x1b]8;;http://a\x07A\x1b]8;;\x07 \x1b]8;;http://b\x07B\x1b]8;;\x07");
    assert_eq!(out.bytes, b"A B");
    assert_eq!(
        out.links,
        vec![(0, 1, "http://a".into()), (2, 3, "http://b".into()),]
    );
}

#[test]
fn a_link_left_open_spans_to_the_end_of_the_chunk_and_resumes() {
    let mut parser = OscParser::new();
    // Link opened but not closed before the chunk ends.
    let first = parser.process(b"\x1b]8;;http://x\x07AB");
    assert_eq!(first.bytes, b"AB");
    assert_eq!(first.links, vec![(0, 2, "http://x".into())]);

    // Still open: the next chunk's bytes are linked from offset 0.
    let second = parser.process(b"CD\x1b]8;;\x07EF");
    assert_eq!(second.bytes, b"CDEF");
    assert_eq!(second.links, vec![(0, 2, "http://x".into())]);
}

/// The row as `row_urls` wants it: one entry per column.
fn row(text: &str) -> Vec<String> {
    text.chars().map(|c| c.to_string()).collect()
}

#[test]
fn shift_rows_up_moves_marks_and_drops_what_scrolls_off() {
    let mut parser = OscParser::new();
    parser.set_viewport_height(3);
    parser.mark_cell(0, 0, &Arc::from("http://gone"), "A");
    parser.mark_cell(2, 1, &Arc::from("http://kept"), "B");

    parser.shift_rows_up(1);

    assert_eq!(parser.row_urls(0, &row("A ")), vec![None, None]);
    assert_eq!(
        parser.row_urls(1, &row("xB")),
        vec![None, Some("http://kept")]
    );
}

#[test]
fn marks_past_the_bottom_row_are_refused() {
    let mut parser = OscParser::new();
    parser.set_viewport_height(3);
    parser.mark_cell(3, 0, &Arc::from("http://offscreen"), "A");
    assert!(parser.cell_urls.is_empty());
}

#[test]
fn a_run_whose_text_changed_is_dropped_whole() {
    // The label was written as one thing, so it lives or dies as one. A
    // redraw that changes any of it takes all of it — including the cells
    // it happened to refill with the same character, which per-cell
    // checking would leave underlined on their own.
    let mut parser = OscParser::new();
    parser.set_viewport_height(2);
    for (col, ch) in "AB CD".chars().enumerate() {
        parser.mark_cell(0, col as u32, &Arc::from("http://label"), &ch.to_string());
    }

    assert_eq!(
        parser.row_urls(0, &row("AB CD")),
        vec![Some("http://label"); 5],
        "untouched text keeps its link"
    );
    assert_eq!(
        parser.row_urls(0, &row("XY CZ")),
        vec![None; 5],
        "the space and the C survived the redraw, but the run did not"
    );
}

#[test]
fn two_runs_on_one_row_are_judged_separately() {
    let mut parser = OscParser::new();
    parser.set_viewport_height(2);
    for (col, ch) in "AA".chars().enumerate() {
        parser.mark_cell(0, col as u32, &Arc::from("http://a"), &ch.to_string());
    }
    for (col, ch) in "BB".chars().enumerate() {
        parser.mark_cell(0, col as u32 + 3, &Arc::from("http://b"), &ch.to_string());
    }

    assert_eq!(
        parser.row_urls(0, &row("AA ZZ")),
        vec![Some("http://a"), Some("http://a"), None, None, None],
        "the second link's text changed; the first one's did not"
    );
}

#[test]
fn osc_sequence_split_across_chunks_is_not_torn() {
    let mut parser = OscParser::new();
    // The hyperlink start sequence is cut mid-URL between two process() calls.
    let out1 = parser.process(b"\x1b]8;;https://exa");
    // Nothing emitted yet — the incomplete escape is buffered, not leaked.
    assert!(out1.bytes.is_empty());
    let out2 = parser.process(b"mple.com\x07hi\x1b]8;;\x07");
    assert_eq!(out2.bytes, b"hi");
    assert_eq!(out2.links, vec![(0, 2, "https://example.com".into())]);
}

#[test]
fn test_osc52_clipboard() {
    let mut parser = OscParser::new();

    // OSC 52 with base64-encoded "hello"
    let input = b"\x1b]52;c;aGVsbG8=\x07";
    let _ = parser.process(input);

    assert_eq!(parser.take_clipboard(), Some("hello".to_string()));
}

#[test]
fn test_base64_decode() {
    assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
    assert_eq!(base64_decode("dGVzdA==").unwrap(), b"test");
}
