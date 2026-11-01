use super::*;

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
fn compound_runs_sees_past_the_binding_pin() {
    let pinned =
        "select-window -t @2 \\; select-pane -t %5 \\; new-window -c \"#{pane_current_path}\"";
    assert!(compound_runs(pinned, &NEW_WINDOW));
    assert!(compound_runs("neww", &NEW_WINDOW));
    // A pane pin alone (an overlay binding) is still seen through.
    assert!(compound_runs("select-pane -t %5 \\; neww", &NEW_WINDOW));
    // No false positives: `new-window` as an argument is not a verb, and a
    // different command with the same prefix does not count.
    assert!(!compound_runs(
        "select-pane -t %5 \\; split-window -h",
        &NEW_WINDOW
    ));
    assert!(!compound_runs("send-keys -l 'new-window'", &NEW_WINDOW));
    assert!(!compound_runs("new-session -d", &NEW_WINDOW));
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
fn rewrite_new_window_in_compound_keeps_the_pin_around_the_rewrite() {
    let pinned = "select-window -t @2 \\; select-pane -t %5 \\; new-window";
    let out = rewrite_new_window_in_compound(pinned, "tmuxy", Some((120, 40)))
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
fn rewrite_new_window_in_compound_passes_through_unpinned_and_unrelated() {
    let bare = rewrite_new_window_in_compound("new-window", "tmuxy", None)
        .expect("a bare new-window still rewrites");
    assert_eq!(bare, new_window_rewrite("tmuxy", None));

    assert!(
        rewrite_new_window_in_compound("select-pane -t %5 \\; split-window -h", "tmuxy", None)
            .is_none()
    );
}

#[test]
fn split_compound_respects_quotes() {
    // Unquoted separators split.
    assert_eq!(
        split_compound("splitw \\; breakp"),
        vec!["splitw ".to_string(), " breakp".to_string()]
    );
    // A separator inside single quotes is payload, not a separator.
    assert_eq!(
        split_compound("send-keys -l 'a\\;b'"),
        vec!["send-keys -l 'a\\;b'".to_string()]
    );
    // Same for double quotes.
    assert_eq!(
        split_compound("send-keys -l \"a\\;b\""),
        vec!["send-keys -l \"a\\;b\"".to_string()]
    );
    // Mixed: quoted payload preserved, real separator still splits.
    assert_eq!(
        split_compound("send-keys -l 'a\\;b' \\; selectp -t %1"),
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
fn split_compound_splits_where_tmux_does() {
    let verbs = |cmd: &str| -> Vec<String> {
        split_compound(cmd)
            .iter()
            .map(|part| command_verb(part).to_string())
            .filter(|verb| !verb.is_empty())
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
fn compound_runs_sees_into_brace_blocks() {
    for cmd in [
        "if-shell -F 1 { resizew -x 10 -y 10 }",
        "if-shell -F 1 {resizew}",
        "if-shell -F 1 { display x } { resize-w -x 1 }",
        "if -F 1 { if -F 1 { display x } { selectp ; resizew } }",
        "select-pane -t %1 \\; if-shell -F 1 { display -p x#{pane_id} ; resizew }",
        "display-menu -x M Yes y { resizew } No n { }",
    ] {
        assert!(compound_runs(cmd, &RESIZE_WINDOW), "{cmd:?}");
    }
    assert!(compound_runs("if-shell -F 1 { new-window }", &NEW_WINDOW));
    for cmd in [
        "display '{ resizew }'",
        "display \"{ resizew }\"",
        "display \\{ resizew \\}",
        "display x{ resizew }",
        "display-menu -x M \"resizew\" r { display x }",
    ] {
        assert!(!compound_runs(cmd, &RESIZE_WINDOW), "{cmd:?}");
    }
}

/// The rewrites split and rejoin a list at its top level only: a block
/// goes out whole, with its own separators and quoting as they came.
#[test]
fn split_compound_keeps_brace_blocks_whole() {
    assert_eq!(
        split_compound(
            "select-pane -t %1 \\; if -F 1 { selectp -t %2 ; resizep -Z } { display \"}\" }"
        ),
        [
            "select-pane -t %1 ",
            " if -F 1 { selectp -t %2 ; resizep -Z } { display \"}\" }"
        ]
    );
    assert_eq!(
        rewrite_mutating_verbs("split-window -h \\; if -F 1 { kill-pane ; display '{' }"),
        "splitw -h ; if -F 1 { kill-pane ; display '{' }"
    );
}

/// `if-shell … { new-window }` is how tmux 3.2+ lists a conditional
/// binding, and a window menu offers `{ new-window }` as an item: the
/// block keeps its shape, with the rewrite in place of each `new-window`.
#[test]
fn rewrite_new_window_in_compound_rewrites_inside_blocks() {
    let out = rewrite_new_window_in_compound(
        "select-pane -t %5 \\; if-shell -F 1 { new-window -c x } { display y }",
        "tmuxy",
        None,
    );
    assert_eq!(
        out.as_deref(),
        Some("select-pane -t %5 ; if-shell -F 1 { splitw -t 'tmuxy' ; breakp } { display y }")
    );
    let out = rewrite_new_window_in_compound(
        "display-menu -x M \"New Pane\" p { new-pane ; join-pane } \"New Window\" w {neww}",
        "tmuxy",
        None,
    );
    assert_eq!(
        out.as_deref(),
        Some("display-menu -x M \"New Pane\" p { new-pane ; join-pane } \"New Window\" w { splitw -t 'tmuxy' ; breakp }")
    );
    // Every new-window in the list, not only the first.
    assert_eq!(
        rewrite_new_window_in_compound("neww ; if -F 1 { neww }", "tmuxy", None).as_deref(),
        Some("splitw -t 'tmuxy' ; breakp ; if -F 1 { splitw -t 'tmuxy' ; breakp }")
    );
}
