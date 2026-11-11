//! The values the UI, the CLI scripts, the browser guests, CI and their build
//! scripts share with tmuxy-core and the workspace, written out into files
//! each of them reads, so no copy is kept by hand.
//!
//! The files are committed; this test fails when one is stale. Rewrite them
//! with `UPDATE_GENERATED=1 cargo test -p tmuxy-core --test generated_constants`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use tmuxy_core::constants::sidebar_dock;
use tmuxy_core::constants::tmux_formats::APP_PANE_TITLE;
use tmuxy_core::constants::{SIDEBAR_WINDOW_PREFIX, STASH_SESSION};
use tmuxy_core::paths::Layout;
use tmuxy_core::session::ManagedOption;
use tmuxy_core::session_snapshot::LEFT_SIDEBAR_WIDGET;
use tmuxy_core::{PaneStateName, WindowType};

#[path = "generated/crate_graph.rs"]
mod crate_graph;
#[path = "generated/dev_loop.rs"]
mod dev_loop;
#[path = "generated/guest_keys.rs"]
mod guest_keys;

const HEADER: &str =
    "Generated from tmuxy-core by packages/tmuxy-core/tests/generated_constants.rs; do not edit.\n\
     Rewrite with UPDATE_GENERATED=1 cargo test -p tmuxy-core --test generated_constants";

fn packages() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// A string as a single-quoted literal, in TypeScript and in shell alike: no
/// value written here holds a quote or a backslash.
fn quoted(value: &str) -> String {
    assert!(
        !value.contains('\'') && !value.contains('\\'),
        "{value:?} needs escaping"
    );
    format!("'{value}'")
}

/// `ThemeMode` → `themeMode`: what the client calls a managed option.
fn client_key(option: ManagedOption) -> String {
    let name = format!("{option:?}");
    let mut chars = name.chars();
    chars
        .next()
        .map(|c| c.to_ascii_lowercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

// ---- The UI's script-effect marks (`tmux_compat`): its own section, so the
// other values above and below can grow without touching it.

/// The marks a tmuxy script run carries ahead of its shell command, by the
/// effect each names: what the UI writes and reads back.
fn script_effect_tags(out: &mut String) {
    let _ = writeln!(
        out,
        "\n/** What a script run that settles or re-lists is marked with (`tmux_compat::SETTLE_TAG`, `RELIST_TAG`). */\n\
         export const SCRIPT_EFFECT_TAGS = {{"
    );
    for tag in [
        tmuxy_core::tmux_compat::SETTLE_TAG,
        tmuxy_core::tmux_compat::RELIST_TAG,
    ] {
        let effect = tag.split_once('=').map_or(tag, |(_, effect)| effect);
        // Quoted only where a key must be, as prettier writes it.
        let key = if effect
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            effect.to_string()
        } else {
            quoted(effect)
        };
        let _ = writeln!(out, "  {key}: {},", quoted(tag));
    }
    out.push_str("} as const;\n");
}

fn typescript() -> String {
    let mut out = String::new();
    for line in HEADER.lines() {
        let _ = writeln!(out, "// {line}");
    }
    script_effect_tags(&mut out);
    dev_loop::typescript(&mut out);
    let _ = writeln!(
        out,
        "\n/** The session parked pane-group members live in (`STASH_SESSION`). */\n\
         export const STASH_SESSION = {};",
        quoted(STASH_SESSION)
    );
    let _ = writeln!(
        out,
        "\n/** A pane's title with tmux's host-name seed filtered out (`tmux_formats::APP_PANE_TITLE`). */\n\
         export const APP_PANE_TITLE = {};",
        quoted(APP_PANE_TITLE)
    );
    let _ = writeln!(
        out,
        "\n/** The window types tmuxy's chrome is tagged with (`WindowType`); an untagged window is a tab. */\n\
         export const CHROME_WINDOW_TYPES = [{}] as const;",
        [
            WindowType::Float,
            WindowType::SidebarLeft,
            WindowType::SidebarRight,
        ]
        .map(|t| quoted(t.as_str()))
        .join(", ")
    );
    let _ = writeln!(
        out,
        "\n/** The `@tmuxy-pane-state` words tmuxy knows, in attention order (`PaneStateName`). */\n\
         export const PANE_STATES = [{}] as const;",
        PaneStateName::ALL
            .map(|s| quoted(s.as_str()))
            .join(", ")
    );
    let _ = writeln!(
        out,
        "\n/** Sidebar column widths and drag bounds, in cells (`sidebar_dock`). */\n\
         export const SIDEBAR_DOCK = {{\n  leftCols: {},\n  rightCols: {},\n  minCols: {},\n  maxCols: {},\n}} as const;",
        sidebar_dock::LEFT_COLS,
        sidebar_dock::RIGHT_COLS,
        sidebar_dock::MIN_COLS,
        sidebar_dock::MAX_COLS
    );
    let _ = writeln!(
        out,
        "\n/** The options a menu changes, by what the client calls them (`session::ManagedOption`). */\n\
         export const MANAGED_OPTIONS = {{"
    );
    for option in ManagedOption::ALL {
        let _ = writeln!(out, "  {}: {},", client_key(option), quoted(option.name()));
    }
    out.push_str("} as const;\n");
    let _ = writeln!(
        out,
        "\n/** What a left sidebar runs, and a restore recognises (`session_snapshot::LEFT_SIDEBAR_WIDGET`). */\n\
         export const LEFT_SIDEBAR_WIDGET = {};",
        quoted(LEFT_SIDEBAR_WIDGET)
    );
    let _ = writeln!(
        out,
        "\n/** The name prefix a sidebar window is recognised by (`constants::SIDEBAR_WINDOW_PREFIX`). */\n\
         export const SIDEBAR_WINDOW_PREFIX = {};",
        quoted(SIDEBAR_WINDOW_PREFIX)
    );
    let _ = writeln!(
        out,
        "\n/** What marks a key binding as a plugin key's (`plugins::keys::MARKER`). */\n\
         export const PLUGIN_KEY_MARKER = {};",
        quoted(tmuxy_core::plugins::keys::MARKER)
    );
    let _ = writeln!(
        out,
        "\n/** The bundled scripts, in the data dir the config chain publishes to tmux (`paths::scripts_by_env`). */\n\
         export const SCRIPTS_DIR = {};",
        quoted(&tmuxy_core::paths::scripts_by_env())
    );
    let _ = writeln!(
        out,
        "\n/** The CLI dispatcher in the data dir's `bin/` (`paths::cli_by_env`). */\n\
         export const CLI_PATH = {};",
        quoted(&tmuxy_core::paths::cli_by_env())
    );
    ui_shared(&mut out);
    out
}

// --- Values the UI shares with the shipped config and the CLI's scripts ---

/// A number as TypeScript writes it after prettier: `1`, not `1.0`.
fn ts_number(value: &serde_json::Number) -> String {
    value
        .as_f64()
        .map_or_else(|| value.to_string(), |v| format!("{v}"))
}

/// A JSON value as a TypeScript literal, keys in sorted order and indented
/// the way prettier prints it (objects only nest one level here).
fn ts_literal(value: &serde_json::Value, indent: &str) -> String {
    match value {
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => ts_number(n),
        serde_json::Value::String(s) => quoted(s),
        serde_json::Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|v| ts_literal(v, indent))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        serde_json::Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            if indent.is_empty() {
                let inner = "  ";
                let body: String = keys
                    .iter()
                    .map(|k| format!("{inner}{k}: {},\n", ts_literal(&map[*k], inner)))
                    .collect();
                format!("{{\n{body}}}")
            } else {
                let body = keys
                    .iter()
                    .map(|k| format!("{k}: {}", ts_literal(&map[*k], indent)))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{{ {body} }}")
            }
        }
        serde_json::Value::Null => "null".to_string(),
    }
}

/// A character as a TypeScript string literal, quoted the way prettier quotes it.
fn ts_char(c: char) -> String {
    match c {
        '\'' => "\"'\"".to_string(),
        '\\' => "'\\\\'".to_string(),
        c => format!("'{c}'"),
    }
}

/// Links and whether core's `is_openable_url` opens them, for the client's
/// rule to be held to (`infra/__tests__/openUrl.test.ts`).
fn openable_url_cases() -> String {
    let cases = [
        "https://example.com/a?b=c",
        "HTTP://EXAMPLE.COM",
        "mailto:someone@example.com",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://example.com/\u{1b}[31m",
        "https://example.com/\"&calc.exe",
        "https://example.com/'x",
        "https://example.com/a b",
        "https://example.com/a\u{a0}b",
        "https://example.com/a\u{85}b",
        "https://example.com/a\u{feff}b",
        "https://example.com/a\u{2028}b",
        "https://example.com/<x>",
        "https://example.com/{x}|^`\\",
        "https://example.com/caf\u{e9}",
        "",
    ];
    let rows: Vec<String> = cases
        .iter()
        .map(|url| {
            format!(
                "  [{}, {}]",
                json_ascii(url),
                tmuxy_core::host::command::is_openable_url(url)
            )
        })
        .collect();
    format!("[\n{}\n]\n", rows.join(",\n"))
}

/// A JSON string with everything outside printable ASCII escaped, so the
/// fixture shows each case's character by its code.
fn json_ascii(value: &str) -> String {
    let mut out = String::from('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            ' '..='~' => out.push(c),
            c => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
        }
    }
    out.push('"');
    out
}

/// The prefix the shipped defaults set (`set -g prefix` in tmuxy.defaults.conf).
fn default_prefix() -> String {
    let path = packages().join("tmuxy-core/assets/tmuxy.defaults.conf");
    let conf = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    conf.lines()
        .find_map(|line| line.trim().strip_prefix("set -g prefix "))
        .map(|key| key.trim().to_string())
        .unwrap_or_else(|| panic!("{} sets no prefix", path.display()))
}

/// The themes the UI ships (`tmuxy-ui/public/themes`), named and moded as
/// the server's `get_themes_list` names them.
fn bundled_themes() -> Vec<tmuxy_core::theme::ThemeInfo> {
    let dir = packages().join("tmuxy-ui/public/themes");
    let mut stems: Vec<(String, PathBuf)> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "css"))
        .filter_map(|path| Some((path.file_stem()?.to_str()?.to_string(), path)))
        .collect();
    stems.sort();
    stems
        .into_iter()
        .map(|(name, path)| {
            let css = std::fs::read_to_string(&path).unwrap_or_default();
            tmuxy_core::theme::ThemeInfo {
                display_name: tmuxy_core::theme::display_theme_name(&name),
                modes: tmuxy_core::session::theme_modes(&css),
                name,
            }
        })
        .collect()
}

fn ui_shared(out: &mut String) {
    let appearance =
        serde_json::to_value(tmuxy_core::theme::Appearance::default()).unwrap_or_default();
    let _ = writeln!(
        out,
        "\n/** The appearance options before a config has said (`theme::Appearance::default()`, tmuxy.defaults.conf's). */\n\
         export const DEFAULT_APPEARANCE = {} as const;",
        ts_literal(&appearance, "")
    );
    let _ = writeln!(
        out,
        "\n/** The prefix key tmuxy.defaults.conf sets. */\nexport const DEFAULT_PREFIX = {};",
        quoted(&default_prefix())
    );
    let _ = writeln!(
        out,
        "\n/** What `tmuxy-widget` prints before a widget's name (`constants::WIDGET_MARKER`). */\n\
         export const WIDGET_MARKER = {};",
        quoted(tmuxy_core::constants::WIDGET_MARKER)
    );
    let _ = writeln!(
        out,
        "\n/** The buffer the client stages a paste in (`constants::PASTE_BUFFER`). */\n\
         export const PASTE_BUFFER = {};",
        quoted(tmuxy_core::constants::PASTE_BUFFER)
    );
    let _ = writeln!(
        out,
        "\n/** Which links a pane printed may be opened (`host::command::is_openable_url`). */\n\
         export const OPENABLE_URL = {{\n  schemes: [{}],\n  forbidden: [{}],\n}} as const;",
        tmuxy_core::constants::OPENABLE_URL_SCHEMES
            .map(quoted)
            .join(", "),
        tmuxy_core::constants::URL_FORBIDDEN_CHARS
            .map(ts_char)
            .join(", ")
    );
    out.push_str(
        "\n/** The themes the app ships, as the server lists them (`theme::get_themes_list`). */\n\
         export const BUNDLED_THEMES = [\n",
    );
    for theme in bundled_themes() {
        let value = serde_json::to_value(&theme).unwrap_or_default();
        let _ = writeln!(out, "  {},", ts_literal(&value, "  "));
    }
    out.push_str("];\n");
}

fn shell_ui_shared(out: &mut String) {
    let _ = writeln!(
        out,
        "\n# What tmuxy-widget prints before a widget's name, for the client to draw it.\nWIDGET_MARKER={}",
        quoted(tmuxy_core::constants::WIDGET_MARKER)
    );
}

fn shell() -> String {
    let mut out = String::from("#!/bin/bash\n");
    for line in HEADER.lines() {
        let _ = writeln!(out, "# {line}");
    }
    out.push_str("# Sourced by _lib.\n# shellcheck disable=SC2034\n");
    let _ = writeln!(
        out,
        "\n# The session parked pane-group members live in: never a real session.\nSTASH_SESSION={}",
        quoted(STASH_SESSION)
    );
    let _ = writeln!(
        out,
        "\n# A pane's title with tmux's host-name seed filtered out: tmux seeds every\n# pane's title with the host name.\nAPP_PANE_TITLE_FMT={}",
        quoted(APP_PANE_TITLE)
    );
    shell_cli_contract(&mut out);
    shell_tmux_names(&mut out);
    shell_ui_shared(&mut out);
    dev_loop::shell(&mut out);
    out
}

/// The `@tmuxy-*` options, window types and defaults the scripts read and
/// write (`constants::tmux_options`, `WindowType`, `session`).
fn shell_tmux_names(out: &mut String) {
    use tmuxy_core::constants::tmux_options as o;
    let _ = writeln!(
        out,
        "\n# The `@tmuxy-pane-state` words tmuxy knows (`PaneStateName`): all that\n# `tmuxy pane state` takes.\n\
         PANE_STATE_WORDS={}",
        quoted(&PaneStateName::ALL.map(PaneStateName::as_str).join("|"))
    );
    out.push_str("\n# The tmuxy options the scripts read and write (`constants::tmux_options`).\n");
    for (name, value) in [
        ("WINDOW_TYPE", o::WINDOW_TYPE),
        ("SIDEBAR_HIDDEN", o::SIDEBAR_HIDDEN),
        ("COLLAPSIBLE", o::COLLAPSIBLE),
        ("FOCUS_REQUEST", o::FOCUS_REQUEST),
        ("GROUP_ID", o::GROUP_ID),
        ("PANE_RESTORE", o::PANE_RESTORE),
        ("PANE_STATE", o::PANE_STATE),
        ("PANE_LABEL", o::PANE_LABEL),
        ("PANE_WIDGET", o::PANE_WIDGET),
        ("PANE_PREVIEW", o::PANE_PREVIEW),
        ("PANE_PREVIEW_NET", o::PANE_PREVIEW_NET),
        ("PANE_DIFF", o::PANE_DIFF),
    ] {
        let _ = writeln!(out, "OPT_{name}={}", quoted(value));
    }
    let _ = writeln!(
        out,
        "\n# The window types tmuxy's chrome is tagged with (`WindowType`); an\n\
         # untagged window is a tab. A sidebar's window is named by its prefix.\n\
         WINDOW_TYPE_FLOAT={}\nWINDOW_TYPE_SIDEBAR_LEFT={}\nWINDOW_TYPE_SIDEBAR_RIGHT={}\n\
         SIDEBAR_WINDOW_PREFIX={}",
        quoted(WindowType::Float.as_str()),
        quoted(WindowType::SidebarLeft.as_str()),
        quoted(WindowType::SidebarRight.as_str()),
        quoted(SIDEBAR_WINDOW_PREFIX)
    );
    let _ = writeln!(
        out,
        "\n# The socket a released build serves when TMUX_SOCKET is unset, and the\n\
         # session it attaches to (`session::DEFAULT_TMUX_SOCKET`, `DEFAULT_SESSION_NAME`).\n\
         DEFAULT_TMUX_SOCKET={}\nDEFAULT_SESSION={}",
        quoted(tmuxy_core::session::DEFAULT_TMUX_SOCKET),
        quoted(tmuxy_core::DEFAULT_SESSION_NAME)
    );
}

/// The CLI's contract (`cli_contract`).
fn shell_cli_contract(out: &mut String) {
    use tmuxy_core::cli_contract as c;
    let _ = writeln!(
        out,
        "\n# The CLI's exit codes and its failure under --json (`cli_contract`).\n\
         EXIT_FAILED={}\nEXIT_USAGE={}\nEXIT_TARGET={}\nEXIT_NO_SERVER={}\nJSON_FAILURE_FORMAT={}",
        c::EXIT_FAILED,
        c::EXIT_USAGE,
        c::EXIT_TARGET,
        c::EXIT_NO_SERVER,
        quoted(c::JSON_FAILURE_FORMAT)
    );
    let _ = writeln!(
        out,
        "\n# What tmux says when there is no server on the socket (`session::NO_SERVER_SIGNS`).\n\
         NO_SERVER_SIGNS=({})",
        tmuxy_core::session::NO_SERVER_SIGNS.map(quoted).join(" ")
    );
}

/// The guest's tmuxy layout: tmuxy's own on Linux for a `root` whose home is
/// `/root`, as `paths` resolves it.
fn guest_layout() -> Layout {
    let home = PathBuf::from("/root");
    Layout {
        config: home.join(".config/tmuxy"),
        data: home.join(".local/share/tmuxy"),
        state: home.join(".local/state/tmuxy"),
        home,
    }
}

fn guest_json() -> String {
    let layout = guest_layout();
    let path = |p: PathBuf| p.display().to_string();
    // Keys in sorted order: serde_json keeps insertion order when another
    // crate of the build turns on its `preserve_order`, and sorts otherwise,
    // so only a sorted literal reads the same both ways.
    let value = serde_json::json!({
        "_generated": HEADER.lines().collect::<Vec<_>>(),
        "confAssets": [
            tmuxy_core::paths::ESSENTIALS_CONF.name,
            tmuxy_core::paths::DEFAULTS_CONF.name,
        ],
        "configDir": path(layout.config.clone()),
        "dataDir": path(layout.data.clone()),
        "entryConf": path(layout.entry_conf()),
        "entryConfText": tmuxy_core::session::guest_entry_conf(&layout),
        "stateDir": path(layout.state.clone()),
    });
    format!(
        "{}\n",
        serde_json::to_string_pretty(&value).unwrap_or_default()
    )
}

fn check(path: PathBuf, generated: String) {
    if std::env::var_os("UPDATE_GENERATED").is_some() {
        std::fs::write(&path, generated).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == generated,
        "{} is stale: rewrite it with UPDATE_GENERATED=1 cargo test -p tmuxy-core --test generated_constants",
        path.display()
    );
}

#[test]
fn the_ui_module_is_tmuxy_cores_values() {
    check(
        packages().join("tmuxy-ui/src/domain/tmuxyConstants.gen.ts"),
        typescript(),
    );
}

#[test]
fn the_ui_url_cases_are_tmuxy_cores_verdicts() {
    check(
        packages().join("tmuxy-ui/src/infra/__tests__/openableUrlCases.gen.json"),
        openable_url_cases(),
    );
}

#[test]
fn the_cli_file_is_tmuxy_cores_values() {
    check(packages().join("tmuxy-cli/bin/tmuxy/_options"), shell());
}

#[test]
fn the_guest_layout_and_chain_are_tmuxy_cores() {
    check(
        packages().join("tmuxy-ui/scripts/lib/guest.gen.json"),
        guest_json(),
    );
}

#[test]
fn the_guest_key_bindings_are_the_shipped_confs() {
    check(
        packages().join("tmuxy-ui/src/infra/transport/drivers/guest/defaultKeybindings.gen.json"),
        guest_keys::guest_keybindings(),
    );
}

#[test]
fn the_crate_graph_is_cargos() {
    check(
        packages().join("tmuxy-core/tests/generated/crate-graph.gen.json"),
        crate_graph::crate_graph_json(),
    );
}
