use std::path::Path;

use super::*;

/// Every helper under `packages/tmuxy-cli/bin/tmuxy/` must be in the bundled list, or the
/// packaged app ships a `tmuxy-cli` that dispatches to a file that was
/// never mirrored to `~/.config/tmuxy/bin/` (the tree sidebar shipped that
/// way once: `tmuxy widget tree` died with "No such file or directory").
#[test]
fn every_helper_script_is_bundled() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmuxy-cli/bin/tmuxy");
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .expect("bin/tmuxy readable")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| format!("tmuxy/{}", e.file_name().to_string_lossy()))
        .collect();
    on_disk.sort();
    let mut bundled: Vec<String> = BUNDLED_BIN_SCRIPTS
        .iter()
        .map(|(rel, _)| rel.to_string())
        .filter(|rel| rel.starts_with("tmuxy/"))
        .collect();
    bundled.sort();
    assert_eq!(
        on_disk, bundled,
        "packages/tmuxy-cli/bin/tmuxy/* and BUNDLED_BIN_SCRIPTS disagree"
    );
}

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
    assert_eq!(
        resolve_user_css_in(&dir, "/themes/nord.css").as_deref(),
        Some(BUNDLED_THEMES[4].1.as_bytes())
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

#[test]
fn managed_state_serde_roundtrips() {
    let state = ManagedState {
        theme: Some("dracula".into()),
        theme_mode: Some("dark".into()),
        cursor_blink: Some(false),
        send_ask: Some(false),
        transparency: Some(false),
        use_tmux_conf: Some(true),
    };
    let json = serde_json::to_string(&state).unwrap();
    let parsed: ManagedState = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.theme.as_deref(), Some("dracula"));
    assert_eq!(parsed.theme_mode.as_deref(), Some("dark"));
    assert_eq!(parsed.cursor_blink, Some(false));
    assert_eq!(parsed.send_ask, Some(false));
    assert_eq!(parsed.transparency, Some(false));
    assert_eq!(parsed.use_tmux_conf, Some(true));

    // An older build's file has no such key; the choice is simply unmade.
    // `use_tmux_conf` unset must read as OFF rather than as "no opinion" —
    // sourcing someone's config is not a thing to start doing on an upgrade.
    let old: ManagedState = serde_json::from_str(r#"{"theme":"nord"}"#).unwrap();
    assert_eq!(old.cursor_blink, None);
    assert_eq!(old.use_tmux_conf, None);
    assert!(!old.use_tmux_conf.unwrap_or(false));
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
    assert!(managed_state_commands(&ManagedState::default()).is_empty());

    let state = ManagedState {
        theme: Some("tokyo night".into()),
        theme_mode: None,
        cursor_blink: Some(false),
        send_ask: Some(false),
        transparency: Some(false),
        use_tmux_conf: Some(true),
    };
    assert_eq!(
        managed_state_commands(&state),
        vec![
            "set-option -g @tmuxy-theme 'tokyo night'".to_string(),
            "set-option -g @tmuxy-cursor-blink 'off'".to_string(),
            "set-option -g @tmuxy-send-ask 'off'".to_string(),
            "set-option -g @tmuxy-transparency 'off'".to_string(),
        ]
    );
}

#[test]
fn user_conf_template_points_at_a_relocated_config_dir() {
    let relocated = std::path::Path::new("/tmp/xdg/tmuxy");
    let conf = user_conf_template(relocated);
    assert!(conf.contains("source-file /tmp/xdg/tmuxy/tmuxy.defaults.conf"));
    assert!(!conf.contains("~/.config/tmuxy"));

    let default_dir = dirs::home_dir().unwrap().join(".config").join("tmuxy");
    assert_eq!(user_conf_template(&default_dir), DEFAULT_USER_CONF);
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

#[test]
fn a_socket_is_a_name_or_a_path_without_shell_syntax() {
    for ok in ["tmuxy", "tmuxy-dev", "/tmp/tmux-501/tmuxy"] {
        assert!(is_safe_socket(ok), "{ok}");
    }
    for bad in ["", "-L", "a b", "x;id", "$(id)", "x'y"] {
        assert!(!is_safe_socket(bad), "{bad}");
    }
}
