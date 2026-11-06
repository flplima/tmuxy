//! The values the UI, the CLI scripts and the browser guests' build scripts
//! share with tmuxy-core, written out of tmuxy-core into files each of them
//! reads, so no copy is kept by hand.
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
use tmuxy_core::WindowType;

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
        "\n/** The CLI dispatcher in the data dir's `bin/` (`paths::CLI_DISPATCHER`). */\n\
         export const CLI_DISPATCHER = {};",
        quoted(tmuxy_core::paths::CLI_DISPATCHER)
    );
    out
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
    out
}

/// The `@tmuxy-*` options, window types and defaults the scripts read and
/// write (`constants::tmux_options`, `WindowType`, `session`).
fn shell_tmux_names(out: &mut String) {
    use tmuxy_core::constants::tmux_options as o;
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

/// The CLI's contract (`cli_contract`) and the exit statuses its scripts
/// read from the verbs.
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
        "\n# What `pane-group next|prev --no-wrap` exits with when there is no member\n\
         # that way (`groups::NOTHING_TO_STEP_TO`).\nGROUP_NOTHING_TO_STEP_TO={}",
        tmuxy_core::groups::NOTHING_TO_STEP_TO
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
