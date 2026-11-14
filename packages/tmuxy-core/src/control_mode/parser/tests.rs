use super::*;

#[test]
fn a_message_is_kept_as_tmux_wrote_it_less_control_characters() {
    let mut parser = Parser::new();
    let parse = |parser: &mut Parser, line: &str| match parser.parse_line(line) {
        Some(ControlModeEvent::Message { text }) => text,
        other => panic!("expected Message, got {other:?}"),
    };
    assert_eq!(parse(&mut parser, "%message build done"), "build done");
    // Unescaped: a backslash and an octal-looking run stay literal.
    assert_eq!(
        parse(&mut parser, r"%message back\slash \012 é"),
        r"back\slash \012 é"
    );
    assert_eq!(parse(&mut parser, "%message a\tb\x07c\x1b[1m"), "a bc[1m");
    let long = parse(&mut parser, &format!("%message {}", "x".repeat(600)));
    assert_eq!(long.chars().count(), MAX_MESSAGE_CHARS + 1);
    assert!(long.ends_with('…'));
}

#[test]
fn test_parse_output() {
    let mut parser = Parser::new();
    let event = parser.parse_line("%output %1 Hello World");

    match event {
        Some(ControlModeEvent::Output { pane_id, content }) => {
            assert_eq!(pane_id, "%1");
            assert_eq!(content, b"Hello World");
        }
        _ => panic!("Expected Output event"),
    }
}

#[test]
fn test_parse_output_with_escapes() {
    let mut parser = Parser::new();
    let event = parser.parse_line(r"%output %1 \033[0mHello");

    match event {
        Some(ControlModeEvent::Output { pane_id, content }) => {
            assert_eq!(pane_id, "%1");
            assert_eq!(content, b"\x1b[0mHello");
        }
        _ => panic!("Expected Output event"),
    }
}

#[test]
fn test_parse_layout_change() {
    let mut parser = Parser::new();
    let event = parser.parse_line("%layout-change @0 abc123,80x24,0,0 abc123,80x24,0,0 *");

    match event {
        Some(ControlModeEvent::LayoutChange {
            window_id,
            layout,
            visible_layout,
            flags,
        }) => {
            assert_eq!(window_id, "@0");
            assert_eq!(layout, "abc123,80x24,0,0");
            assert_eq!(visible_layout, "abc123,80x24,0,0");
            assert_eq!(flags, "*");
        }
        _ => panic!("Expected LayoutChange event"),
    }
}

#[test]
fn test_parse_window_add() {
    let mut parser = Parser::new();
    let event = parser.parse_line("%window-add @5");

    match event {
        Some(ControlModeEvent::WindowAdd { window_id }) => {
            assert_eq!(window_id, "@5");
        }
        _ => panic!("Expected WindowAdd event"),
    }
}

#[test]
fn test_parse_command_response() {
    let mut parser = Parser::new();

    assert!(parser.parse_line("%begin 1234567890 0 0").is_none());
    assert!(parser.parse_line("line 1").is_none());
    assert!(parser.parse_line("line 2").is_none());
    let event = parser.parse_line("%end 1234567890 0 0");

    match event {
        Some(ControlModeEvent::CommandResponse { output, success }) => {
            assert_eq!(output, "line 1\nline 2");
            assert!(success);
        }
        _ => panic!("Expected CommandResponse event"),
    }
}

#[test]
fn test_parse_command_error() {
    let mut parser = Parser::new();

    parser.parse_line("%begin 1234567890 1 0");
    parser.parse_line("error message");
    let event = parser.parse_line("%error 1234567890 1 0");

    match event {
        Some(ControlModeEvent::CommandResponse { success, .. }) => {
            assert!(!success);
        }
        _ => panic!("Expected CommandResponse event"),
    }
}

#[test]
fn stray_end_without_begin_is_ignored() {
    let mut parser = Parser::new();
    assert!(parser.parse_line("%end 1234567890 0 0").is_none());
    assert!(parser.parse_line("%error 1234567890 1 0").is_none());
}

/// A capture of a pane that shows tmux's own guard lines: the block ends at
/// the `%end` repeating its `%begin`, and nothing in between — another
/// block's guards, a `%begin`, a notification — is read as anything but body.
#[test]
fn a_block_closes_only_on_the_guard_that_repeats_its_begin() {
    let mut parser = Parser::new();
    let body = [
        "%end 1234567890 7 1",
        "%error 0 0 0",
        "%begin 1 2 3",
        "%exit",
        "%window-close @1",
    ];
    assert!(parser.parse_line("%begin 1234567890 8 1").is_none());
    for line in body {
        assert!(parser.parse_line(line).is_none(), "{line} is body");
    }
    match parser.parse_line("%end 1234567890 8 1") {
        Some(ControlModeEvent::CommandResponse {
            output, success, ..
        }) => {
            assert!(success);
            assert_eq!(output, body.join("\n"));
        }
        other => panic!("expected the block, got {other:?}"),
    }
    // The block is closed: a notification is a notification again.
    assert!(matches!(
        parser.parse_line("%exit"),
        Some(ControlModeEvent::Exit { .. })
    ));
}

#[test]
fn test_parse_exit() {
    let mut parser = Parser::new();

    let event = parser.parse_line("%exit");
    match event {
        Some(ControlModeEvent::Exit { reason }) => {
            assert!(reason.is_none());
        }
        _ => panic!("Expected Exit event"),
    }

    let event = parser.parse_line("%exit detached");
    match event {
        Some(ControlModeEvent::Exit { reason }) => {
            assert_eq!(reason, Some("detached".to_string()));
        }
        _ => panic!("Expected Exit event"),
    }
}

#[test]
fn test_parse_session_changed() {
    let mut parser = Parser::new();
    let event = parser.parse_line("%session-changed $0 main");

    match event {
        Some(ControlModeEvent::SessionChanged {
            session_id,
            session_name,
        }) => {
            assert_eq!(session_id, "$0");
            assert_eq!(session_name, "main");
        }
        _ => panic!("Expected SessionChanged event"),
    }
}

/// A title subscription names the pane whose title changed; the value
/// after ` : ` is free text and may hold anything, spaces and `%` included.
/// A session-scoped subscription (the theme's) names no window or pane:
/// tmux writes `-` for each, and the value after ` : ` is the whole news.
#[test]
fn a_session_subscription_change_carries_its_value() {
    let mut parser = Parser::new();
    let event = parser.parse_line("%subscription-changed tmuxy-theme $1 - - - : gruvbox:light");
    match event {
        Some(ControlModeEvent::SessionSubscriptionChanged { name, value }) => {
            assert_eq!(name, "tmuxy-theme");
            assert_eq!(value, "gruvbox:light");
        }
        other => panic!("expected SessionSubscriptionChanged, got {other:?}"),
    }
}

#[test]
fn a_subscription_change_names_its_pane() {
    let mut parser = Parser::new();
    let event = parser
        .parse_line("%subscription-changed tmuxy-pane-titles $0 @3 1 %7 - : 100% done, %9 next");
    match event {
        Some(ControlModeEvent::SubscriptionChanged { name, pane_id }) => {
            assert_eq!(name, "tmuxy-pane-titles");
            assert_eq!(pane_id, "%7");
        }
        other => panic!("expected SubscriptionChanged, got {other:?}"),
    }
}

#[test]
fn test_parse_pane_mode_changed() {
    let mut parser = Parser::new();
    let event = parser.parse_line("%pane-mode-changed %0");

    match event {
        Some(ControlModeEvent::PaneModeChanged { pane_id }) => {
            assert_eq!(pane_id, "%0");
        }
        _ => panic!("Expected PaneModeChanged event"),
    }
}

#[test]
fn test_parse_paste_buffer_changed() {
    let mut parser = Parser::new();
    let event = parser.parse_line("%paste-buffer-changed buffer0");

    match event {
        Some(ControlModeEvent::PasteBufferChanged { buffer_name }) => {
            assert_eq!(buffer_name, "buffer0");
        }
        _ => panic!("Expected PasteBufferChanged event"),
    }
}

/// `%extended-output` carries a pane's bytes: a parse that refuses it leaves
/// a pane whose output arrives this way silent.
#[test]
fn extended_output_carries_the_panes_bytes() {
    let mut parser = Parser::new();
    match parser.parse_line(r"%extended-output %3 142 : \033[0mhi") {
        Some(ControlModeEvent::Output { pane_id, content }) => {
            assert_eq!(pane_id, "%3");
            assert_eq!(content, b"\x1b[0mhi");
        }
        other => panic!("expected Output, got {other:?}"),
    }
}

/// The age field is optional in practice, and an unparseable one must not
/// take the output down with it — the bytes still have to reach the pane.
#[test]
fn extended_output_without_a_readable_age_still_delivers_its_bytes() {
    let mut parser = Parser::new();
    match parser.parse_line("%extended-output %3 notanumber : hi") {
        Some(ControlModeEvent::Output { pane_id, content }) => {
            assert_eq!(pane_id, "%3");
            assert_eq!(content, b"hi");
        }
        other => panic!("expected Output, got {other:?}"),
    }
}

/// A line with no ` : ` separator is not an extended-output line, and must
/// be refused rather than half-read.
#[test]
fn extended_output_without_a_separator_is_not_an_event() {
    let mut parser = Parser::new();
    assert!(parser
        .parse_line("%extended-output %3 142 no separator here")
        .is_none());
}

#[test]
fn response_keeps_leading_blank_lines() {
    // A capture-pane whose top rows are blank: the blank lines are real
    // rows and must survive, or the content shifts up under the cursor.
    let mut parser = Parser::new();
    assert!(parser.parse_line("%begin 1234567890 2 0").is_none());
    assert!(parser.parse_line("").is_none());
    assert!(parser.parse_line("").is_none());
    assert!(parser.parse_line("~").is_none());
    assert!(parser.parse_line("❯").is_none());
    match parser.parse_line("%end 1234567890 2 0") {
        Some(ControlModeEvent::CommandResponse { output, .. }) => {
            assert_eq!(output, "\n\n~\n❯");
        }
        other => panic!("expected a CommandResponse, got {other:?}"),
    }
}

/// tmux names the session a rename is about by id, then gives its new name,
/// which may hold spaces.
#[test]
fn a_session_rename_carries_the_session_id_apart_from_the_name() {
    let mut parser = Parser::new();
    match parser.parse_line("%session-renamed $0 my work") {
        Some(ControlModeEvent::SessionRenamed { session_id, name }) => {
            assert_eq!(session_id, "$0");
            assert_eq!(name, "my work");
        }
        other => panic!("Expected SessionRenamed, got {other:?}"),
    }
}

#[test]
fn a_reply_past_the_cap_is_an_error_and_the_next_one_is_whole() {
    let mut parser = Parser::with_max_response_bytes(10);
    parser.parse_line("%begin 1 1 0");
    parser.parse_line("0123456789abcdef");
    parser.parse_line("more");
    match parser.parse_line("%end 1 1 0") {
        Some(ControlModeEvent::CommandResponse {
            success, output, ..
        }) => {
            assert!(!success);
            assert!(output.contains("larger than 10 bytes"), "{output}");
        }
        other => panic!("expected CommandResponse, got {other:?}"),
    }
    parser.parse_line("%begin 1 2 0");
    parser.parse_line("ok");
    match parser.parse_line("%end 1 2 0") {
        Some(ControlModeEvent::CommandResponse {
            success, output, ..
        }) => {
            assert!(success);
            assert_eq!(output, "ok");
        }
        other => panic!("expected CommandResponse, got {other:?}"),
    }
}

/// tmux 3.8 queues a notification raised while a command runs until the
/// command's block has closed (tmux issue 5458), so it comes before the
/// `%begin` or after the `%end`, never between: both orders read the
/// notification as one, and the reply whole.
#[test]
fn a_notification_queued_before_or_after_a_reply_is_read_as_one() {
    for notification_first in [true, false] {
        let mut parser = Parser::new();
        let mut events = Vec::new();
        let mut feed = |line: &str| events.extend(parser.parse_line(line));
        if notification_first {
            feed("%output %3 hello");
        }
        feed("%begin 1234567890 9 1");
        feed("one");
        feed("two");
        feed("%end 1234567890 9 1");
        if !notification_first {
            feed("%output %3 hello");
        }
        assert_eq!(events.len(), 2, "{events:?}");
        let (reply, output) = if notification_first {
            (&events[1], &events[0])
        } else {
            (&events[0], &events[1])
        };
        assert!(
            matches!(reply, ControlModeEvent::CommandResponse { output, success: true, .. } if output == "one\ntwo"),
            "{reply:?}"
        );
        assert!(
            matches!(output, ControlModeEvent::Output { content, .. } if content == b"hello"),
            "{output:?}"
        );
    }
}

/// Before 3.8 a notification could arrive inside a block. It cannot be told
/// from the command's own output there (a `capture-pane` of a pane showing
/// `%output …` prints exactly that), so it is read as the reply's body: the
/// pane's next capture or output brings it up to date. This pins that, so a
/// parser that starts guessing is a decision, not an accident.
#[test]
fn before_tmux_3_8_a_notification_inside_a_reply_is_its_body() {
    let mut parser = Parser::new();
    assert!(parser.parse_line("%begin 1234567890 9 1").is_none());
    assert!(parser.parse_line("%output %3 hello").is_none());
    assert!(parser.parse_line("%window-add @4").is_none());
    match parser.parse_line("%end 1234567890 9 1") {
        Some(ControlModeEvent::CommandResponse { output, .. }) => {
            assert_eq!(output, "%output %3 hello\n%window-add @4");
        }
        other => panic!("expected the reply, got {other:?}"),
    }
}
