use std::path::Path;

use super::*;

#[test]
fn the_server_command_is_published_quoted_with_its_subcommand() {
    assert_eq!(
        server_command_env_for(Path::new("/Apps/my tmuxy/tmuxy"), Some("server")),
        [
            "set-environment -g TMUXY_SERVER_BIN '/Apps/my tmuxy/tmuxy'",
            "set-environment -g TMUXY_SERVER_SUBCOMMAND 'server'",
        ]
    );
    assert_eq!(
        server_command_env_for(Path::new("/bin/tmuxy-server"), None)[1],
        "set-environment -g -u TMUXY_SERVER_SUBCOMMAND"
    );
}

#[test]
fn invoked_exe_prefers_appimage_and_maps_cellar_to_opt() {
    let prefix = std::env::temp_dir().join(format!("tmuxy-invoked-exe-{}", std::process::id()));
    std::fs::create_dir_all(prefix.join("opt/tmuxy/bin")).unwrap();
    let opt_bin = prefix.join("opt/tmuxy/bin/tmuxy");
    std::fs::write(&opt_bin, "").unwrap();

    let cellar_bin = prefix.join("Cellar/tmuxy/0.1.4/bin/tmuxy");
    let mount_bin = Path::new("/tmp/.mount_tmuxyBgDPhF/usr/bin/tmuxy");

    // Inside an AppImage installed via Homebrew, $APPIMAGE is in Cellar/ and
    // current_exe() is inside the ephemeral FUSE mount: the resolved path is
    // the stable opt/ symlink, never the mount or the versioned Cellar dir.
    assert_eq!(
        resolve_invoked_exe(Some(&cellar_bin), Some(mount_bin)),
        Some(opt_bin)
    );

    // Standalone AppImage outside Homebrew: $APPIMAGE wins over the FUSE mount.
    let standalone = Path::new("/home/me/Applications/tmuxy.AppImage");
    assert_eq!(
        resolve_invoked_exe(Some(standalone), Some(mount_bin)),
        Some(standalone.to_path_buf())
    );

    // Non-AppImage build: current_exe() is used when $APPIMAGE is unset/empty.
    assert_eq!(
        resolve_invoked_exe(Some(Path::new("")), Some(standalone)),
        Some(standalone.to_path_buf())
    );
    assert_eq!(
        resolve_invoked_exe(None, Some(standalone)),
        Some(standalone.to_path_buf())
    );

    let _ = std::fs::remove_dir_all(&prefix);
}

#[test]
fn refresh_launcher_if_installed_heals_stale_wrapper_without_creating_a_new_one() {
    let root = std::env::temp_dir().join(format!("tmuxy-launcher-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let layout = crate::paths::Layout {
        config: home.join(".config/tmuxy"),
        data: root.join("data"),
        state: root.join("state"),
        home,
    };
    let wrapper = layout.home.join(".local/bin/tmuxy");
    let launcher = layout.state.join("launcher");
    let installed_exe = root.join("opt-tmuxy");
    let debug_exe = root.join("target-debug-tmuxy");
    std::fs::write(&installed_exe, "").unwrap();
    std::fs::write(&debug_exe, "").unwrap();

    // On a host that never ran the GUI, no wrapper exists and none is created.
    heal_wrapper_in(&layout, &installed_exe, true);
    assert!(!wrapper.exists());
    assert!(!launcher.exists());

    // Once installed by an older build — the mark in its header, a body
    // that derives the state dir in the shell — a CLI start updates both
    // the wrapper and the state dir's launcher.
    std::fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\n{WRAPPER_MARK}\nLAUNCHER_FILE=\"$HOME/.config/tmuxy/launcher\"\n"),
    )
    .unwrap();

    heal_wrapper_in(&layout, &installed_exe, true);
    assert_eq!(
        std::fs::read_to_string(&launcher).unwrap(),
        format!("{}\n", installed_exe.display())
    );
    assert_eq!(
        std::fs::read_to_string(&wrapper).unwrap(),
        launcher_wrapper(&launcher)
    );

    // When both the wrapper and the recorded target are healthy, running
    // another binary (such as `target/debug/tmuxy` in a test) leaves the
    // installed launcher alone; only a missing target or a full GUI launch
    // (`refresh_launcher_in`) replaces it.
    heal_wrapper_in(&layout, &debug_exe, true);
    assert_eq!(
        std::fs::read_to_string(&launcher).unwrap(),
        format!("{}\n", installed_exe.display())
    );

    std::fs::remove_file(&installed_exe).unwrap();
    heal_wrapper_in(&layout, &debug_exe, true);
    assert_eq!(
        std::fs::read_to_string(&launcher).unwrap(),
        format!("{}\n", debug_exe.display())
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// The wrapper runs the binary its launcher file names, with the arguments
/// it was given — from a state dir whose path a shell would split.
#[cfg(unix)]
#[test]
fn the_wrapper_execs_the_recorded_binary() {
    let root = std::env::temp_dir().join(format!("tmuxy launcher's {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let launcher = root.join("launcher");
    std::fs::write(&launcher, "/bin/echo\n").unwrap();
    let wrapper = root.join("tmuxy");
    std::fs::write(&wrapper, launcher_wrapper(&launcher)).unwrap();
    let out = std::process::Command::new("sh")
        .arg(&wrapper)
        .args(["pane", "list"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), "pane list\n");
    let _ = std::fs::remove_dir_all(&root);
}

/// A tmuxy run with another state dir — a test's server, a build pointed
/// elsewhere — never points the user's shorthand at its own launcher; a file
/// without tmuxy's mark, or a symlink the user made, is never replaced.
#[test]
fn a_file_without_the_mark_or_from_another_state_dir_is_left_alone() {
    let root = std::env::temp_dir().join(format!("tmuxy-launcher-other-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let layout = crate::paths::Layout {
        config: home.join(".config/tmuxy"),
        data: root.join("data"),
        state: root.join("test-state"),
        home,
    };
    let wrapper = layout.home.join(".local/bin/tmuxy");
    std::fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
    let exe = root.join("tmuxy");
    std::fs::write(&exe, "").unwrap();

    // Marked, stale, and not this process's to heal: its state dir is not
    // the one the user's shorthand belongs to.
    let stale = launcher_wrapper(&root.join("users-state/launcher"));
    std::fs::write(&wrapper, &stale).unwrap();
    refresh_launcher_if_installed_in(&layout, &exe);
    assert_eq!(std::fs::read_to_string(&wrapper).unwrap(), stale);

    // The user's own script under that name carries no mark of tmuxy's and
    // is never touched, whatever it says.
    let users_own = "#!/bin/sh\nLAUNCHER_FILE=\"$STATE_DIR/launcher\"\nexec /opt/my-tmuxy \"$@\"\n";
    std::fs::write(&wrapper, users_own).unwrap();
    heal_wrapper_in(&layout, &exe, true);
    assert_eq!(std::fs::read_to_string(&wrapper).unwrap(), users_own);
    assert!(!layout.state.join("launcher").exists());

    // Marked and stale, under the state dir the shorthand belongs to: rewritten.
    std::fs::write(&wrapper, &stale).unwrap();
    heal_wrapper_in(&layout, &exe, true);
    assert_eq!(
        std::fs::read_to_string(&wrapper).unwrap(),
        launcher_wrapper(&layout.state.join("launcher"))
    );

    // A checkout's CLI, linked by hand, survives even a GUI launch.
    std::fs::remove_file(&wrapper).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&exe, &wrapper).unwrap();
        refresh_launcher_in(&layout, &exe);
        assert!(std::fs::symlink_metadata(&wrapper)
            .unwrap()
            .file_type()
            .is_symlink());
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_ssh_tail_is_split_into_arguments_and_a_blank_one_means_local() {
    assert_eq!(
        ssh_argv(Some(" -p 2222  user@host ")),
        Some(vec!["-p".to_string(), "2222".into(), "user@host".into()])
    );
    assert_eq!(ssh_argv(Some("   ")), None);
    assert_eq!(ssh_argv(None), None);
}

#[test]
fn session_names_are_held_to_the_alphabet() {
    for ok in ["tmuxy", "tmuxy_test_1727", "a-b", "me@host", "c++", "x"] {
        assert!(is_safe_session_name(ok), "{ok:?} should be accepted");
    }
    for bad in [
        "",
        "-bad",
        "--help",
        "a b",
        "a'b",
        "a;b",
        "a#(id)",
        "a.b",
        "a:b",
        "a\nb",
        "a\u{7f}b",
        "ünïcode",
    ] {
        assert!(!is_safe_session_name(bad), "{bad:?} should be refused");
    }
}

#[test]
fn a_session_name_is_the_text_it_was_parsed_from() {
    let name = SessionName::parse("tmuxy_test_1727").expect("a safe name parses");
    assert_eq!(name.as_str(), "tmuxy_test_1727");
    assert_eq!(name.to_string(), "tmuxy_test_1727");
    assert_eq!(&*name, "tmuxy_test_1727");
    assert_eq!(name.into_string(), "tmuxy_test_1727");
    assert_eq!(SessionName::parse("a;b"), None);
}

#[test]
fn a_css_name_cannot_leave_the_themes_dir_or_end_a_declaration() {
    for ok in ["nord", "my_theme-2", "a"] {
        assert!(is_safe_css_name(ok), "{ok:?}");
    }
    for bad in ["", "../x", "a/b", "a;b", "a b", "a}b", "ünï"] {
        assert!(!is_safe_css_name(bad), "{bad:?}");
    }
    let dir = Path::new("/nonexistent");
    assert!(resolve_user_css_in(dir, "themes/../tmuxy.conf").is_none());
    assert!(resolve_user_css_in(dir, "themes/nord.css/../../x.css").is_none());
    assert!(resolve_user_css_in(dir, "tmuxy.conf").is_none());
}

#[test]
fn the_users_file_is_served_first_and_a_built_in_falls_back_to_the_bundle() {
    let dir = std::env::temp_dir().join(format!("tmuxy-css-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let nord = BUNDLED_THEMES
        .iter()
        .find(|(name, _)| *name == "nord.css")
        .unwrap()
        .1;
    assert_eq!(
        resolve_user_css_in(&dir, "/themes/nord.css").as_deref(),
        Some(nord.as_bytes())
    );
    assert_eq!(resolve_user_css_in(&dir, "custom.css"), Some(Vec::new()));
    assert!(resolve_user_css_in(&dir, "themes/mine.css").is_none());

    std::fs::create_dir_all(dir.join("themes")).unwrap();
    std::fs::write(dir.join("themes/mine.css"), "a").unwrap();
    std::fs::write(dir.join("themes/nord.css"), "b").unwrap();
    std::fs::write(dir.join("custom.css"), "c").unwrap();
    assert_eq!(
        resolve_user_css_in(&dir, "themes/mine.css"),
        Some(b"a".to_vec())
    );
    assert_eq!(
        resolve_user_css_in(&dir, "themes/nord.css"),
        Some(b"b".to_vec())
    );
    assert_eq!(resolve_user_css_in(&dir, "custom.css"), Some(b"c".to_vec()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_built_in_theme_the_build_no_longer_ships_is_removed_and_a_users_own_kept() {
    let dir = std::env::temp_dir().join(format!("tmuxy-themes-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("retired.css"),
        format!("{BUILT_IN_THEME_HEADER}:root {{}}"),
    )
    .unwrap();
    std::fs::write(dir.join("mine.css"), ":root {}").unwrap();

    ensure_themes_in(&dir);

    assert!(!dir.join("retired.css").exists());
    assert!(dir.join("mine.css").exists());
    for (name, _) in BUNDLED_THEMES {
        assert!(dir.join(name).exists(), "{name}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_theme_supports_the_modes_whose_blocks_declare_something() {
    assert_eq!(
        theme_modes(":root.theme-dark {\n  --a: 1;\n}\n:root.theme-light {\n}\n"),
        vec!["dark"]
    );
    assert_eq!(
        theme_modes(":root.theme-dark { --a: 1 } :root.theme-light { --a: 2 }"),
        vec!["dark", "light"]
    );
    assert!(theme_modes("body { color: red }").is_empty());
    for (name, css) in BUNDLED_THEMES {
        assert!(theme_modes(css).contains(&"dark"), "{name}");
    }
}

/// An older build's file has no such key: the choice is simply unmade, and
/// reading it does not fail.
#[test]
fn a_managed_state_file_missing_a_key_reads_it_as_unset() {
    let old: ManagedState = serde_json::from_str(r#"{"theme":"nord"}"#).unwrap();
    assert_eq!(old.theme.as_deref(), Some("nord"));
    assert_eq!(old.cursor_blink, None);
    assert_eq!(old.use_tmux_conf, None);
}

#[test]
fn managed_state_skips_unset_fields_on_serialize() {
    let state = ManagedState::default();
    let json = serde_json::to_string(&state).unwrap();
    // Empty struct must not write nulls — older readers might choke on them.
    assert_eq!(json, "{}");
}

#[test]
fn managed_state_commands_set_only_the_chosen_options() {
    assert!(managed_state_commands(&ManagedState::default(), &[]).is_empty());

    let state = ManagedState {
        theme: Some("tokyo night".into()),
        theme_mode: None,
        cursor_blink: Some(false),
        send_ask: Some(false),
        transparency: Some(false),
        use_tmux_conf: Some(true),
        ..ManagedState::default()
    };
    assert_eq!(
        managed_state_commands(&state, &[]),
        vec![
            "set-option -g @tmuxy-theme 'tokyo night'".to_string(),
            "set-option -g @tmuxy-cursor-blink 'off'".to_string(),
            "set-option -g @tmuxy-send-ask 'off'".to_string(),
            "set-option -g @tmuxy-transparency 'off'".to_string(),
        ]
    );
}

/// Config beats menu state: an option the user's tmuxy.conf sets is not put
/// back over it from tmuxy.state.json, on a connect or a reload.
#[test]
fn a_pinned_option_is_not_reapplied_from_the_menu_state() {
    let state = ManagedState {
        theme: Some("dracula".into()),
        theme_mode: Some("light".into()),
        cursor_blink: Some(false),
        ..Default::default()
    };
    let pinned = pinned_options_in("set -g @tmuxy-theme nord\nset -g @tmuxy-cursor-blink on\n");
    assert_eq!(
        managed_state_commands(&state, &pinned),
        vec!["set-option -g @tmuxy-theme-mode 'light'".to_string()]
    );
}

#[test]
fn a_pin_is_a_set_line_outside_a_comment_and_not_an_unset() {
    let conf = "\
# set -g @tmuxy-theme-mode light
#   set -g @tmuxy-transparency off
set-option -g @tmuxy-send-ask off
set -gq '@tmuxy-theme' \"nord\"
set -gu @tmuxy-cursor-blink
set -g @tmuxy-opacity 0.5 ; set -g @tmuxy-transparency off
bind x set -g @tmuxy-theme-mode dark
";
    assert_eq!(
        pinned_options_in(conf),
        vec!["@tmuxy-theme", "@tmuxy-send-ask", "@tmuxy-transparency"]
    );
    assert!(pinned_options_in(DEFAULT_USER_CONF).is_empty());
}

/// tmux runs `set-o` as `set-option`, and its words are the grammar's: a
/// reader that matched the verb's spelling missed both pins.
#[test]
fn a_pin_is_read_by_the_command_grammar() {
    assert_eq!(
        pinned_options_in("set-o -g @tmuxy-theme nord\nset-opt -g @tmuxy-send-ask off\n"),
        vec!["@tmuxy-theme", "@tmuxy-send-ask"]
    );
}

/// `-t` takes an argument, which is a target and not the option's name,
/// whether it stands alone, ends a cluster or is glued to its flag.
#[test]
fn a_pin_reads_past_a_target_flag_and_its_argument() {
    for conf in [
        "set -g -t main @tmuxy-theme nord",
        "set -gt main @tmuxy-theme nord",
        "set -t main -g @tmuxy-theme nord",
        "set-option -tmain -gq @tmuxy-theme nord",
        "set -g -- @tmuxy-theme nord",
    ] {
        assert_eq!(pinned_options_in(conf), ["@tmuxy-theme"], "{conf}");
    }
}

/// The file runs top to bottom: a later `-u` lets an earlier pin go, and a
/// set after that pins it again.
#[test]
fn a_later_unset_lets_a_pin_go() {
    let conf = "\
set -g @tmuxy-theme nord
set -g @tmuxy-theme-mode dark
set -gu @tmuxy-theme
set -g -u @tmuxy-theme-mode
set -g @tmuxy-cursor-blink on
set -gu @tmuxy-cursor-blink
set -g @tmuxy-cursor-blink off
";
    assert_eq!(pinned_options_in(conf), ["@tmuxy-cursor-blink"]);
}

/// Commands split where tmux splits a list — `\;`, a glued `;`, a bare one —
/// and a comment runs from a `#` that starts a word to the end of its line,
/// `;` and all; a `#` inside quotes or a word is text.
#[test]
fn a_pin_splits_commands_and_drops_comments_as_tmux_does() {
    let conf = "\
set -g @tmuxy-theme nord \\; set -g @tmuxy-theme-mode dark
set -g @tmuxy-send-ask off;set -g @tmuxy-transparency off
set -g @tmuxy-opacity 1 # note ; set -g @tmuxy-cursor-blink on
";
    assert_eq!(
        pinned_options_in(conf),
        [
            "@tmuxy-theme",
            "@tmuxy-theme-mode",
            "@tmuxy-send-ask",
            "@tmuxy-transparency"
        ]
    );
    assert_eq!(
        pinned_options_in("set -g @tmuxy-cursor-blink \"on # kept\" ; set -g @x a#b"),
        ["@tmuxy-cursor-blink"]
    );
    assert_eq!(
        pinned_options_in("set -g \\\n  @tmuxy-theme nord"),
        ["@tmuxy-theme"],
        "a continued line"
    );
}

/// What the app reads is the global session option: a session's own, a
/// window's, a pane's or the server's table does not reach it, and a binding's
/// block runs on a key press, not when the file is read.
#[test]
fn only_a_global_session_option_set_when_the_file_is_read_pins() {
    for conf in [
        "set @tmuxy-theme nord",
        "set -t main @tmuxy-theme nord",
        "set -gw @tmuxy-theme nord",
        "set -p @tmuxy-theme nord",
        "set -s @tmuxy-theme nord",
        "bind x { set -g @tmuxy-theme nord }",
        "bind x set -g @tmuxy-theme nord",
    ] {
        assert!(pinned_options_in(conf).is_empty(), "{conf}");
    }
}

/// What reaches ssh as its destination is a host, never an option: ssh runs
/// a `-oProxyCommand=…` as a local command.
#[test]
fn an_ssh_destination_is_a_user_and_host_and_nothing_else() {
    for ok in ["host", "felipe@prod", "10.0.0.2", "me@my-box.local", "::1"] {
        assert!(is_ssh_destination(ok), "{ok}");
    }
    for bad in [
        "-oProxyCommand=id",
        "ssh -oProxyCommand=id",
        "-p 2222 host",
        "user@-oProxyCommand=id",
        "host;id",
        "a b",
        "",
        "@host",
    ] {
        assert!(!is_ssh_destination(bad), "{bad}");
    }
}

/// A port after the host is ssh's `-p`; a colon inside an IPv6 address, or
/// one followed by no port number, is part of the destination.
#[test]
fn a_destinations_port_is_split_off_and_an_ipv6_address_is_left_whole() {
    assert_eq!(
        split_ssh_port("felipe@prod:2222"),
        ("felipe@prod", Some(2222))
    );
    assert_eq!(split_ssh_port("host"), ("host", None));
    assert_eq!(split_ssh_port("::1"), ("::1", None));
    assert_eq!(split_ssh_port("host:x"), ("host:x", None));
}

#[test]
fn a_socket_is_a_name_or_a_path_without_shell_syntax() {
    for ok in ["tmuxy", "tmuxy-dev", "/tmp/tmux-501/tmuxy"] {
        assert!(is_safe_socket(ok), "{ok}");
    }
    for bad in [
        "",
        "-L",
        "../tmuxy",
        "rel/socket",
        "/tmp/../tmuxy",
        "a b",
        "x;id",
        "$(id)",
        "x'y",
    ] {
        assert!(!is_safe_socket(bad), "{bad}");
    }
}
