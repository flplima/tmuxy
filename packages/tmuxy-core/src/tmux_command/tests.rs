use super::*;

fn top_level(cmd: &str) -> Vec<String> {
    parse(cmd).top_level().map(|c| c.text.to_string()).collect()
}

#[test]
fn new_window_rewrite_quotes_the_session() {
    // Session names come from servers.json / `tmuxy session connect`, so they can
    // contain whitespace (which truncated the target) or `;` (which
    // appended extra commands to the list).
    let out = new_window_rewrite("my session", None);
    assert!(out.contains("splitw -t 'my session' ;"), "{out}");

    let out = new_window_rewrite("evil ; kill-server", None);
    assert!(out.contains("-t 'evil ; kill-server'"), "{out}");

    let out = new_window_rewrite("it's", None);
    assert!(out.contains(r"-t 'it'\''s'"), "{out}");
}

#[test]
fn new_window_rewrite_includes_resize_only_with_a_size() {
    let sized = new_window_rewrite("tmuxy", Some((120, 40)));
    assert!(sized.contains("resizew -x 120 -y 40"), "{sized}");
    // Tabs carry no marker — the rewrite must not tag the window.
    assert!(!sized.contains("@tmuxy-window-type"), "{sized}");

    let plain = new_window_rewrite("tmuxy", None);
    assert!(!plain.contains("resizew"), "{plain}");
    assert!(!plain.contains("@tmuxy-window-type"), "{plain}");
}

/// The regression this pair of helpers exists for: the keyboard actor pins
/// every bound command, so `prefix c` never looked like a `new-window` to a
/// head-anchored check, and the raw command escaped to an external
/// subprocess against an attached control-mode client.
#[test]
fn a_list_runs_a_command_behind_the_binding_pin() {
    let pinned =
        "select-window -t @2 \\; select-pane -t %5 \\; new-window -c \"#{pane_current_path}\"";
    assert!(parse(pinned).runs(&NEW_WINDOW));
    assert!(parse("neww").runs(&NEW_WINDOW));
    // A pane pin alone (an overlay binding) is still seen through.
    assert!(parse("select-pane -t %5 \\; neww").runs(&NEW_WINDOW));
    // No false positives: `new-window` as an argument is not a verb, and a
    // different command with the same prefix does not count.
    assert!(!parse("select-pane -t %5 \\; split-window -h").runs(&NEW_WINDOW));
    assert!(!parse("send-keys -l 'new-window'").runs(&NEW_WINDOW));
    assert!(!parse("new-session -d").runs(&NEW_WINDOW));
}

/// tmux runs any prefix of a command's name no other command shares, so
/// a policy that knew only the name and the alias missed `resize-w`.
#[test]
fn a_command_is_seen_under_every_name_tmux_runs_it_by() {
    for verb in ["resize-window", "resizew", "resize-w", "resize-win"] {
        assert!(RESIZE_WINDOW.named_by(verb), "{verb}");
    }
    for verb in ["resize-", "resize-pane", "resizep", "resize-windows"] {
        assert!(!RESIZE_WINDOW.named_by(verb), "{verb}");
    }
    for verb in ["new-window", "neww", "new-w", "new-wi"] {
        assert!(NEW_WINDOW.named_by(verb), "{verb}");
    }
    for verb in ["new", "new-", "new-session", "news"] {
        assert!(!NEW_WINDOW.named_by(verb), "{verb}");
    }
}

#[test]
fn the_new_window_rewrite_keeps_the_pin_around_the_rewrite() {
    let pinned = "select-window -t @2 \\; select-pane -t %5 \\; new-window";
    let out = parse(pinned)
        .rewrite_new_window("tmuxy", Some((120, 40)))
        .expect("a new-window in the list");

    // The pin survives, ahead of the rewrite — `splitw -t <session>` targets
    // the session's CURRENT window, so the pin is what aims it at the tab
    // the user is looking at.
    assert!(
        out.starts_with("select-window -t @2 ; select-pane -t %5 ;"),
        "{out}"
    );
    assert!(out.contains("splitw -t 'tmuxy'"), "{out}");
    assert!(out.contains("breakp"), "{out}");
    assert!(out.contains("resizew -x 120 -y 40"), "{out}");
    // Control mode's line parser rejects the shell-escaped separator.
    assert!(!out.contains("\\;"), "{out}");
}

#[test]
fn the_new_window_rewrite_passes_through_unpinned_and_unrelated() {
    let bare = parse("new-window")
        .rewrite_new_window("tmuxy", None)
        .expect("a bare new-window still rewrites");
    assert_eq!(bare, new_window_rewrite("tmuxy", None));

    assert!(parse("select-pane -t %5 \\; split-window -h")
        .rewrite_new_window("tmuxy", None)
        .is_none());
}

#[test]
fn a_list_splits_outside_quotes_only() {
    assert_eq!(
        top_level("splitw \\; breakp"),
        vec!["splitw ".to_string(), " breakp".to_string()]
    );
    // A separator inside single quotes is payload, not a separator.
    assert_eq!(
        top_level("send-keys -l 'a\\;b'"),
        vec!["send-keys -l 'a\\;b'".to_string()]
    );
    assert_eq!(
        top_level("send-keys -l \"a\\;b\""),
        vec!["send-keys -l \"a\\;b\"".to_string()]
    );
    assert_eq!(
        top_level("send-keys -l 'a\\;b' \\; selectp -t %1"),
        vec![
            "send-keys -l 'a\\;b' ".to_string(),
            " selectp -t %1".to_string()
        ]
    );
}

/// Every separator tmux acts on splits, read with tmux's quoting: a bare
/// `;`, a newline, and a quote a backslash escaped does not open or close
/// anything. Each of these hid a `resizew` from the router.
#[test]
fn a_list_splits_where_tmux_does() {
    let verbs = |cmd: &str| -> Vec<String> {
        parse(cmd)
            .top_level()
            .map(|c| c.verb().to_string())
            .collect()
    };
    assert_eq!(verbs("display x ; resizew -x 1"), ["display", "resizew"]);
    assert_eq!(verbs("display x\nresizew -x 1"), ["display", "resizew"]);
    assert_eq!(
        verbs("display \"\\\"\" \\; resizew"),
        ["display", "resizew"]
    );
    assert_eq!(verbs("display \\' \\; resizew"), ["display", "resizew"]);
    assert_eq!(
        verbs("display 'it'\\''s' ; resizew"),
        ["display", "resizew"]
    );
    // An open quote does not survive the end of the line.
    assert_eq!(verbs("display 'x\nresizew"), ["display", "resizew"]);
    // Quoted separators stay payload.
    assert_eq!(verbs("display 'a ; b' \"c ; d\" \"e\\\";f\""), ["display"]);
}

/// A `{ … }` block is a command list tmux runs (`if-shell`'s branches, a
/// menu item), so a command inside one, at any depth, is a command the
/// policy must see. A brace that is quoted, escaped or glued to a word
/// (`#{pane_id}`) opens nothing, in tmux or here.
#[test]
fn a_list_runs_the_commands_of_its_blocks() {
    for cmd in [
        "if-shell -F 1 { resizew -x 10 -y 10 }",
        "if-shell -F 1 {resizew}",
        "if-shell -F 1 { display x } { resize-w -x 1 }",
        "if -F 1 { if -F 1 { display x } { selectp ; resizew } }",
        "select-pane -t %1 \\; if-shell -F 1 { display -p x#{pane_id} ; resizew }",
        "display-menu -x M Yes y { resizew } No n { }",
    ] {
        assert!(parse(cmd).runs(&RESIZE_WINDOW), "{cmd:?}");
    }
    assert!(parse("if-shell -F 1 { new-window }").runs(&NEW_WINDOW));
    for cmd in [
        "display '{ resizew }'",
        "display \"{ resizew }\"",
        "display \\{ resizew \\}",
        "display x{ resizew }",
        "display-menu -x M \"resizew\" r { display x }",
    ] {
        assert!(!parse(cmd).runs(&RESIZE_WINDOW), "{cmd:?}");
    }
}

/// The rewrites split and rejoin a list at its top level only: a block
/// goes out whole, with its own separators and quoting as they came.
#[test]
fn the_top_level_keeps_brace_blocks_whole() {
    assert_eq!(
        top_level("select-pane -t %1 \\; if -F 1 { selectp -t %2 ; resizep -Z } { display \"}\" }"),
        [
            "select-pane -t %1 ",
            " if -F 1 { selectp -t %2 ; resizep -Z } { display \"}\" }"
        ]
    );
}

/// `if-shell … { new-window }` is how tmux 3.2+ lists a conditional
/// binding, and a window menu offers `{ new-window }` as an item: the
/// block keeps its shape, with the rewrite in place of each `new-window`.
#[test]
fn the_new_window_rewrite_reaches_inside_blocks() {
    let out = parse("select-pane -t %5 \\; if-shell -F 1 { new-window -c x } { display y }")
        .rewrite_new_window("tmuxy", None);
    assert_eq!(
        out.as_deref(),
        Some("select-pane -t %5 ; if-shell -F 1 { splitw -t 'tmuxy' ; breakp } { display y }")
    );
    let out =
        parse("display-menu -x M \"New Pane\" p { new-pane ; join-pane } \"New Window\" w {neww}")
            .rewrite_new_window("tmuxy", None);
    assert_eq!(
        out.as_deref(),
        Some("display-menu -x M \"New Pane\" p { new-pane ; join-pane } \"New Window\" w { splitw -t 'tmuxy' ; breakp }")
    );
    assert_eq!(
        parse("neww ; if -F 1 { neww }")
            .rewrite_new_window("tmuxy", None)
            .as_deref(),
        Some("splitw -t 'tmuxy' ; breakp ; if -F 1 { splitw -t 'tmuxy' ; breakp }")
    );
}

/// The separator the frontend joins a pinned binding with is a literal on a
/// control-mode line; it becomes the bare `;` there, and nothing else moves
/// — not a `\;` inside quotes, which is text.
#[test]
fn escaped_separators_become_plain_ones_and_nothing_else_changes() {
    let pinned =
        "select-window -t @1 \\; select-pane -t %2 \\;  splitw -h -c \"#{pane_current_path}\"";
    assert_eq!(
        parse(pinned).with_plain_separators(),
        "select-window -t @1 ; select-pane -t %2 ;  splitw -h -c \"#{pane_current_path}\""
    );
    let literal = "send-keys -t %1 -l -- 'a \\; b' \\; send-keys -t %1 Enter";
    assert_eq!(
        parse(literal).with_plain_separators(),
        "send-keys -t %1 -l -- 'a \\; b' ; send-keys -t %1 Enter"
    );
    let plain = "display -p x ; display -p y";
    assert!(matches!(
        parse(plain).with_plain_separators(),
        Cow::Borrowed(_)
    ));
}

/// A command's words are as written, a block one word of the command it
/// belongs to, and the list says when tmux's own reading is in doubt.
#[test]
fn a_command_is_read_into_its_words() {
    let list = parse("run-shell -t %3 'echo \"a b\"' ; if -F 1 { display x } {selectp}");
    let top: Vec<Vec<&str>> = list.top_level().map(|c| c.words().to_vec()).collect();
    assert_eq!(
        top,
        [
            vec!["run-shell", "-t", "%3", "'echo \"a b\"'"],
            vec!["if", "-F", "1", "{ display x }", "{selectp}"],
        ]
    );
    assert!(list.has_blocks());
    assert!(!list.glued_separator && !list.unterminated_quote);
    assert!(parse("display hi; run-shell 'a'").glued_separator);
    assert!(parse("display 'hi").unterminated_quote);
    assert!(!parse("display 'hi'").has_blocks());
}

#[test]
fn a_word_is_unquoted_as_tmux_joins_it() {
    assert_eq!(unquote("'it'\\''s'").as_deref(), Some("it's"));
    assert_eq!(
        unquote("\"a \\\"b\\\" \\101\"").as_deref(),
        Some("a \"b\" A")
    );
    assert_eq!(unquote("plain\\ word").as_deref(), Some("plain word"));
    assert_eq!(unquote("'#{pane_id}'").as_deref(), Some("#{pane_id}"));
    for unknown in ["$HOME", "\"$HOME\"", "~/x", "{ a }", "'open"] {
        assert_eq!(unquote(unknown), None, "{unknown}");
    }
}
