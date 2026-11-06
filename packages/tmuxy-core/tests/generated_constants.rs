//! The values the UI and the CLI scripts share with tmuxy-core, written out of
//! tmuxy-core into a TypeScript module and a shell file each of them reads,
//! so no copy is kept by hand: the stash session, the pane-title format, the
//! window types, the sidebar dock widths, the options a menu changes, what a
//! left sidebar runs.
//!
//! The files are committed; this test fails when one is stale. Rewrite them
//! with `UPDATE_GENERATED=1 cargo test -p tmuxy-core --test generated_constants`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use tmuxy_core::constants::sidebar_dock;
use tmuxy_core::constants::tmux_formats::APP_PANE_TITLE;
use tmuxy_core::constants::STASH_SESSION;
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

fn typescript() -> String {
    let mut out = String::new();
    for line in HEADER.lines() {
        let _ = writeln!(out, "// {line}");
    }
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
    out
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
