use super::*;

/// The module's stated purpose is "a typo can't diverge a sender from its
/// reader" — but `concat!` can't interpolate consts, so the format
/// strings repeat the option names as literals. This test is the
/// lockstep guard: every window-scoped `@tmuxy-*` option must appear
/// verbatim in the list-windows format the parser consumes.
#[test]
fn list_windows_cmd_embeds_every_window_option() {
    for option in [
        tmux_options::WINDOW_TYPE,
        tmux_options::FLOAT_PARENT,
        tmux_options::FLOAT_WIDTH,
        tmux_options::FLOAT_HEIGHT,
        tmux_options::FLOAT_DRAWER,
        tmux_options::FLOAT_BG,
        tmux_options::FLOAT_NOHEADER,
        tmux_options::FOCUS_REQUEST,
        tmux_options::SIDEBAR_COLS,
        tmux_options::SIDEBAR_HIDDEN,
        tmux_options::SIDEBAR_ROWS,
        tmux_options::COLLAPSIBLE,
    ] {
        assert!(
            tmux_formats::LIST_WINDOWS_CMD.contains(&format!("#{{{option}}}")),
            "LIST_WINDOWS_CMD is missing #{{{option}}} — the format string \
             and the tmux_options constant have diverged"
        );
    }
}

/// The pane rows must ask whether the pane is in COPY mode, never the
/// broader `#{pane_in_mode}`. The client turns this field into its own
/// copy mode, which hides the live terminal — so a pane in any other tmux
/// mode (view, tree, buffer, client) would vanish behind a scrollback view.
#[test]
fn list_panes_cmd_asks_for_copy_mode_not_any_mode() {
    assert!(
        tmux_formats::LIST_PANES_CMD.contains(tmux_formats::COPY_MODE_FLAG),
        "LIST_PANES_CMD must request COPY_MODE_FLAG"
    );
    assert!(
        !tmux_formats::LIST_PANES_CMD.contains("#{pane_in_mode}"),
        "LIST_PANES_CMD must not use #{{pane_in_mode}} — it is 1 for view-mode too"
    );
}

/// Both pane enumerations must ask for the HOST-FILTERED title, never a
/// bare `#{pane_title}`: the raw field is seeded with the host name, so a
/// client reading it can't tell "the app set this" from "tmux did", and the
/// pane header would show a host name instead of falling back to the
/// process name.
#[test]
fn list_panes_cmds_ask_for_the_app_set_title() {
    for (name, cmd) in [
        ("LIST_PANES_CMD", tmux_formats::LIST_PANES_CMD),
        ("LIST_STASH_PANES_CMD", tmux_formats::LIST_STASH_PANES_CMD),
    ] {
        assert!(
            cmd.contains(tmux_formats::APP_PANE_TITLE),
            "{name} must request APP_PANE_TITLE, not a bare #{{pane_title}}"
        );
        assert_eq!(
            cmd.matches("#{pane_title}").count(),
            tmux_formats::APP_PANE_TITLE
                .matches("#{pane_title}")
                .count(),
            "{name} has a #{{pane_title}} outside APP_PANE_TITLE"
        );
    }
}

/// `@tmuxy-ask` rides in the pane format's fixed tail. A literal that
/// drifted from the constant would leave every pending question invisible.
#[test]
fn list_panes_cmd_embeds_the_ask_options() {
    for opt in [tmux_options::PANE_STATE, tmux_options::ASK] {
        assert!(
            tmux_formats::LIST_PANES_CMD.contains(&format!("#{{{opt}}}")),
            "LIST_PANES_CMD is missing #{{{opt}}}"
        );
    }
}

/// The group id rides in the pane format now (pane-scoped), and the stash
/// enumeration must carry it too — same lockstep guard against a divergent
/// literal.
#[test]
fn list_panes_cmds_embed_group_id() {
    let opt = tmux_options::GROUP_ID;
    assert!(
        tmux_formats::LIST_PANES_CMD.contains(&format!("#{{{opt}}}")),
        "LIST_PANES_CMD is missing #{{{opt}}}"
    );
    assert!(
        tmux_formats::LIST_STASH_PANES_CMD.contains(&format!("#{{{opt}}}")),
        "LIST_STASH_PANES_CMD is missing #{{{opt}}}"
    );
    assert!(
        tmux_formats::LIST_STASH_PANES_CMD.contains(STASH_SESSION),
        "LIST_STASH_PANES_CMD must target the stash session by name"
    );
}

/// The pane-metadata subscription watches exactly the pane options the
/// group scripts change without tmux announcing it.
#[test]
fn pane_meta_subscription_watches_the_group_options() {
    let cmd = tmux_formats::SUBSCRIBE_PANE_TITLES_CMD;
    assert!(cmd.contains(&format!("'{}:", tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME)));
    for opt in [
        tmux_options::GROUP_ID,
        tmux_options::GROUP_POS,
        tmux_options::GROUP_REV,
    ] {
        assert!(
            cmd.contains(&format!("#{{{opt}}}")),
            "SUBSCRIBE_PANE_TITLES_CMD is missing #{{{opt}}}"
        );
    }
}
