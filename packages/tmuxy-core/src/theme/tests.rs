use super::*;

#[test]
fn display_theme_name_title_cases_hyphenated_stems() {
    assert_eq!(display_theme_name("tokyo-night"), "Tokyo Night");
    assert_eq!(display_theme_name("default"), "Default");
    assert_eq!(display_theme_name(""), "");
}

/// What tmux prints for `settings_query` when these options are set and
/// the rest are not: a `name=` line each, blank lines dropped the way the
/// control-mode reply drops them.
fn printed(set: &[(&str, &str)]) -> String {
    SETTINGS_OPTIONS
        .iter()
        .map(|option| {
            let value = set
                .iter()
                .find(|(name, _)| name == option)
                .map_or("", |(_, value)| value);
            format!("{option}={value}\n")
        })
        .collect()
}

/// One round trip reads every option by name; an unset one is the
/// default, and shifts nothing.
#[test]
fn settings_are_read_in_one_query_and_unset_options_take_the_defaults() {
    let query = settings_query();
    for option in SETTINGS_OPTIONS {
        assert!(
            query.contains(&format!("display-message -p '{option}=#{{{option}}}'")),
            "{option}"
        );
    }

    let settings = parse_settings(&printed(&[
        (tmux_options::THEME, "nord"),
        (tmux_options::OPACITY, "0.5"),
        (tmux_options::BLUR, "off"),
        (tmux_options::TRANSPARENCY, "off"),
        (tmux_options::TAB_OVERVIEW_COLS, "40"),
        (tmux_options::SIZE, "80x25"),
    ]));
    assert_eq!(settings["theme"], "nord");
    assert_eq!(settings["mode"], DEFAULT_MODE);
    assert_eq!(settings["appearance"]["opacity"], 0.5);
    assert_eq!(settings["appearance"]["blur"], false);
    assert_eq!(settings["appearance"]["transparency"], false);
    assert_eq!(
        settings["appearance"]["tabOverviewCols"],
        MAX_TAB_OVERVIEW_COLS
    );
    assert_eq!(settings["appearance"]["animations"], true);
    assert_eq!(
        settings["appearance"]["size"],
        serde_json::json!({ "mode": "fixed", "cols": 80, "rows": 25 })
    );

    // A fresh config sets no theme: the theme is the default, not the
    // opacity that happens to be printed next.
    let fresh = parse_settings("@tmuxy-opacity=0.7\n@tmuxy-active-pane-opacity=1\n");
    assert_eq!(fresh["theme"], DEFAULT_THEME);
    assert_eq!(fresh["appearance"]["opacity"], 0.7);
    assert_eq!(fresh["appearance"]["transparency"], true);

    let empty = parse_settings("");
    assert_eq!(empty["theme"], DEFAULT_THEME);
    assert_eq!(
        empty["appearance"],
        serde_json::to_value(Appearance::default()).unwrap()
    );
    assert_eq!(empty["cssVars"], serde_json::json!({}));
}

/// The `show-options -g` lines after the settings carry the CSS
/// variables: one per `@tmuxy-css-*` option, unquoted, and only those a
/// browser can take as one declaration.
#[test]
fn css_variable_options_are_read_from_the_global_options() {
    let output = format!(
        "{}@tmuxy-css-term-background \"#101010\"\n@tmuxy-css-accent-blue rgb(1,2,3)\n\
         @tmuxy-css-font-family \"\\\"Fira Code\\\", monospace\"\n\
         @tmuxy-css-bad;name x\n@tmuxy-css-term-foreground \"red; }} body {{\"\n\
         @tmuxy-opacity 0.5\nstatus-right \"%H:%M\"\n",
        printed(&[(tmux_options::THEME, "nord")])
    );
    let settings = parse_settings(&output);
    assert_eq!(settings["theme"], "nord");
    // The `show-options` echo of a settings option has no `=`: not a value.
    assert_eq!(
        settings["appearance"]["opacity"],
        Appearance::default().opacity
    );
    assert_eq!(
        settings["cssVars"],
        serde_json::json!({
            "term-background": "#101010",
            "accent-blue": "rgb(1,2,3)",
            "font-family": "\"Fira Code\", monospace",
        })
    );
    assert!(settings_query().ends_with("show-options -g"));
}

/// The theme is a stylesheet path and the mode one of three words; anything
/// else is the default. A CSS variable cannot comment out the ones after it
/// or fetch from the network.
#[test]
fn a_theme_mode_or_css_value_that_is_not_one_falls_back_or_is_dropped() {
    let output = format!(
        "{}@tmuxy-css-a \"red /* \"\n@tmuxy-css-b url(https://x.example/beacon)\n\
         @tmuxy-css-c \"URL( x )\"\n@tmuxy-css-d \"\\\\75 rl(x)\"\n\
         @tmuxy-css-e \"image-set(x 1x)\"\n@tmuxy-css-f calc(1px + 2px)\n",
        printed(&[
            (tmux_options::THEME, "../../evil"),
            (tmux_options::THEME_MODE, "dark\" onload=\"x"),
        ])
    );
    let settings = parse_settings(&output);
    assert_eq!(settings["theme"], DEFAULT_THEME);
    assert_eq!(settings["mode"], DEFAULT_MODE);
    assert_eq!(
        settings["cssVars"],
        serde_json::json!({ "f": "calc(1px + 2px)" })
    );
    assert_eq!(
        parse_settings(&printed(&[(tmux_options::THEME_MODE, "auto")]))["mode"],
        "auto"
    );
}

/// Every option the app reads is documented where the user edits it.
#[test]
fn the_config_readme_documents_every_option() {
    let readme = include_str!("../../assets/config-README.md");
    for option in SETTINGS_OPTIONS {
        assert!(
            readme.contains(&format!("`{option}`")),
            "{option} is undocumented"
        );
    }
    assert!(readme.contains(&format!("`{CSS_VAR_PREFIX}<variable>`")));
}

/// The value goes into a control-mode command line: quoted so `;` stays
/// literal, and refused if it carries a line break.
#[test]
fn an_option_value_cannot_end_the_command_line() {
    assert_eq!(option_value("nord").unwrap(), "'nord'");
    assert_eq!(
        option_value("a ; kill-server").unwrap(),
        "'a ; kill-server'"
    );
    assert!(option_value("a\nkill-server").is_err());
}

#[test]
fn parse_count_accepts_whole_numbers_and_caps_them() {
    assert_eq!(parse_count("5", 3, 12), 5);
    assert_eq!(parse_count(" 2\n", 3, 12), 2);
    assert_eq!(parse_count("40", 3, 12), 12);
    assert_eq!(parse_count("0", 3, 12), 3);
    assert_eq!(parse_count("-1", 3, 12), 3);
    assert_eq!(parse_count("2.5", 3, 12), 3);
    assert_eq!(parse_count("", 3, 12), 3);
}

/// Config beats menu state: a menu change leaves an option the user's
/// tmuxy.conf pins as the file has it, and one made only of pinned options is
/// refused with the reason, not dropped without a word.
#[test]
fn a_menu_change_skips_what_tmuxy_conf_pins() {
    let pinned = [tmux_options::THEME];
    assert_eq!(
        unpinned(
            &[
                (tmux_options::THEME, "dracula"),
                (tmux_options::THEME_MODE, "light")
            ],
            &pinned
        )
        .unwrap(),
        vec![(tmux_options::THEME_MODE, "light")]
    );
    let refused = unpinned(&[(tmux_options::THEME, "dracula")], &pinned).unwrap_err();
    assert!(refused.error.contains("@tmuxy-theme is set in tmuxy.conf"));
    assert_eq!(
        unpinned(&[(tmux_options::CURSOR_BLINK, "off")], &pinned).unwrap(),
        vec![(tmux_options::CURSOR_BLINK, "off")]
    );
}
