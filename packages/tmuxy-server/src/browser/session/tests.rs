use super::screencast::{
    base64_decode, FRAME_EVERY_NTH, FRAME_MAX_HEIGHT, FRAME_MAX_WIDTH, FRAME_QUALITY,
};
use super::verbs_impl::{is_context_swap, json_string, render};
use super::*;

/// `--attach` drives the tab the user browses in, never DevTools or an
/// extension's page that a browser also lists as a target.
#[test]
fn an_attached_browser_is_driven_through_a_browsing_tab() {
    assert!(super::is_user_tab("page", "https://example.com/"));
    assert!(super::is_user_tab("page", "about:blank"));
    assert!(!super::is_user_tab(
        "page",
        "devtools://devtools/bundled/inspector.html"
    ));
    assert!(!super::is_user_tab(
        "page",
        "chrome-extension://abc/popup.html"
    ));
    assert!(!super::is_user_tab(
        "service_worker",
        "https://example.com/sw.js"
    ));
}

/// The two ways Chromium says an evaluate named a context a navigation
/// just replaced; anything else is the page's own answer or a real error.
#[test]
fn a_replaced_context_is_told_apart_from_a_page_error() {
    assert!(is_context_swap(
        "Error -32000: Cannot find context with specified id"
    ));
    assert!(is_context_swap(
        "Execution context was destroyed, most likely because of a navigation"
    ));
    assert!(!is_context_swap("ReferenceError: foo is not defined"));
    assert!(!is_context_swap("websocket closed"));
}

/// The only thing between a selector containing a quote and an expression
/// that means something else entirely.
#[test]
fn a_string_reaching_the_page_is_escaped() {
    assert_eq!(json_string("#id"), "\"#id\"");
    assert_eq!(
        json_string("a[title=\"x\"]"),
        "\"a[title=\\\"x\\\"]\"",
        "a quote must not close the literal"
    );
    assert_eq!(json_string("back\\slash"), "\"back\\\\slash\"");
    assert_eq!(json_string("two\nlines"), "\"two\\nlines\"");
}

/// A selector built to break out of the literal must stay inside it. Not a
/// trust boundary — the caller already has a shell — but a correctness one:
/// a page whose content ends up in a selector should not change what the
/// expression does.
#[test]
fn a_selector_cannot_escape_into_the_expression() {
    let hostile = "x\"); alert(1); (\"";
    let escaped = json_string(hostile);

    // The real proof is that the output is ONE well-formed string literal
    // holding exactly the input. If any quote had closed the literal early,
    // the remainder would be trailing garbage and this parse would fail — a
    // substring check cannot tell `\"` from `"` and would pass either way.
    assert_eq!(
        serde_json::from_str::<String>(&escaped).expect("one valid JSON string"),
        hostile,
        "the page must receive the selector that was asked for"
    );

    let body = &escaped[1..escaped.len() - 1];
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            chars.next();
        } else {
            assert_ne!(c, '"', "an unescaped quote inside the literal: {escaped}");
        }
    }
}

#[test]
fn a_string_result_prints_without_quotes() {
    assert_eq!(render(&serde_json::json!("My Page")), "My Page");
    assert_eq!(render(&serde_json::json!(42)), "42");
    assert_eq!(render(&serde_json::json!(true)), "true");
    assert_eq!(render(&serde_json::json!(null)), "null");
    assert_eq!(render(&serde_json::json!({ "a": 1 })), "{\"a\":1}");
}

#[test]
fn silent_output_prints_nothing() {
    assert_eq!(Output::Silent.to_string(), "");
    assert_eq!(Output::Line("x".into()).to_string(), "x");
}

#[test]
fn a_wait_that_runs_out_names_the_selector_and_the_budget() {
    let error = SessionError::WaitedTooLong {
        selector: "#late".to_string(),
    };
    let message = error.to_string();
    assert!(message.contains("#late"), "{message}");
    assert!(message.contains("20s"), "{message}");
}

#[test]
fn base64_round_trips_a_jpeg_header() {
    use base64::Engine as _;
    let jpeg = b"\xff\xd8\xff\xe0";
    let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg);
    assert_eq!(base64_decode(&encoded).as_deref(), Some(&jpeg[..]));
    assert_eq!(base64_decode("not base64!!"), None);
}

/// The frame budget is a LATENCY budget: these bytes share the control-mode
/// stream with keystroke echo (docs/PERFORMANCE.md, Axis C).
#[test]
fn the_frame_budget_stays_modest() {
    assert!(FRAME_QUALITY <= 70, "a higher quality is mostly more bytes");
    assert!(FRAME_MAX_WIDTH <= 1920 && FRAME_MAX_HEIGHT <= 1200);
    // Not a throttle. `everyNthFrame` counts compositor frames, so any
    // value above 1 drops the one-or-two frames a STILL page produces and
    // leaves the previous page on screen after a navigation. The budget is
    // kept with quality and the size cap instead.
    assert_eq!(
        FRAME_EVERY_NTH, 1,
        "throttling by frame count deletes a still page's only frames"
    );
}
