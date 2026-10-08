//! Version skew: the combinations a release actually produces.
//!
//! tmuxy ships roughly every three days, and an upgrade is never atomic. Three
//! skews follow from that and none of them had a test:
//!
//!   1. **An old tab against a new server.** The server serves the frontend, so
//!      upgrading it does not reload a tab someone already has open. That tab
//!      keeps POSTing the payload shapes of the release it was loaded from,
//!      until the person reloads — which may be days.
//!   2. **An old CLI against a new server.** `~/.local/bin/tmuxy` is a symlink
//!      into a checkout, and a Homebrew install is a separate copy on a
//!      separate schedule, so the shell scripts writing `@tmuxy-*` tags are
//!      routinely a different vintage from the Rust reading them.
//!   3. **Two servers on one socket.** Both attach control mode to the same
//!      tmux server.
//!
//! What follows are contract tests, not integration tests: each one pins the
//! part of the contract that a version bump can silently break, so breaking it
//! requires saying so in a diff.

// A test's `expect` IS its assertion: the panic message is the failure report,
// and a Result threaded back to the harness would only say "Err". Same
// allowance every integration test under tmuxy-core carries.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::json;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root resolvable")
}

// ===========================================================================
// 1. An old tab against a new server
// ===========================================================================

/// Payloads exactly as shipped frontends have sent them.
///
/// This is a CORPUS, not a generated list: every entry is the wire shape a
/// released tab puts on the network, including the quirks. New commands may be
/// added; an entry may only be removed when a deliberate decision is made to
/// stop supporting tabs of that vintage, and then the removal is the diff
/// someone reviews.
///
/// Two quirks are load-bearing and both have burned us before:
///
///   * `args: {}` is sent even for commands that take none. serde's
///     adjacently-tagged representation rejects an empty map where a unit
///     variant is expected, which broke every such command on the wire;
///     `ClientCommand::decode` strips it and retries.
///   * camelCase field names (`paneId`), because the sender is TypeScript.
fn shipped_payloads() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        // The first thing every tab sends. `cols`/`rows` were added after the
        // command existed, so a tab older than that sends neither — which is
        // why they are Option and why this entry omits them.
        (
            "get_initial_state (no size)",
            json!({ "cmd": "get_initial_state", "args": {} }),
        ),
        (
            "get_initial_state (with size)",
            json!({ "cmd": "get_initial_state", "args": { "cols": 120, "rows": 40 } }),
        ),
        (
            "set_client_size",
            json!({ "cmd": "set_client_size", "args": { "cols": 100, "rows": 30 } }),
        ),
        (
            "run_tmux_command",
            json!({ "cmd": "run_tmux_command", "args": { "command": "splitw -v" } }),
        ),
        (
            "query_tmux",
            json!({ "cmd": "query_tmux", "args": { "command": "list-panes -a" } }),
        ),
        // `start`/`end` are defaulted, so all three vintages must decode: the
        // tab that sends neither, and the tab that sends both.
        (
            "get_scrollback_cells (defaults)",
            json!({ "cmd": "get_scrollback_cells", "args": { "paneId": "%0" } }),
        ),
        (
            "get_scrollback_cells (explicit range)",
            json!({ "cmd": "get_scrollback_cells", "args": { "paneId": "%0", "start": -500, "end": 0 } }),
        ),
        // Unit variants, each with the empty `args` a real tab sends.
        (
            "get_theme_settings",
            json!({ "cmd": "get_theme_settings", "args": {} }),
        ),
        (
            "get_themes_list",
            json!({ "cmd": "get_themes_list", "args": {} }),
        ),
        (
            "list_git_worktrees",
            json!({ "cmd": "list_git_worktrees", "args": {} }),
        ),
        (
            "get_trace_settings",
            json!({ "cmd": "get_trace_settings", "args": {} }),
        ),
        // `mode` was added to set_theme later; a tab from before it sends only
        // the name.
        (
            "set_theme (name only)",
            json!({ "cmd": "set_theme", "args": { "name": "dracula" } }),
        ),
        (
            "set_theme (with mode)",
            json!({ "cmd": "set_theme", "args": { "name": "dracula", "mode": "dark" } }),
        ),
        (
            "set_theme_mode",
            json!({ "cmd": "set_theme_mode", "args": { "mode": "light" } }),
        ),
        (
            "set_cursor_blink",
            json!({ "cmd": "set_cursor_blink", "args": { "enabled": true } }),
        ),
        (
            "set_trace_enabled",
            json!({ "cmd": "set_trace_enabled", "args": { "enabled": false } }),
        ),
        (
            "set_trace_level",
            json!({ "cmd": "set_trace_level", "args": { "level": "debug" } }),
        ),
    ]
}

#[test]
fn every_shipped_payload_still_decodes() {
    for (name, payload) in shipped_payloads() {
        let body = serde_json::to_vec(&payload).expect("payload serializes");
        let decoded = tmuxy_server::ClientCommand::decode(&body);
        assert!(
            decoded.is_ok(),
            "a shipped tab's `{name}` payload no longer decodes: {:?}\n\
             An open tab from a previous release sends exactly this. Either keep \
             accepting it (new fields need #[serde(default)]) or decide out loud \
             to drop support for tabs of that vintage.",
            decoded.err(),
        );
    }
}

/// A field added to a command must be optional, or the release that adds it
/// breaks every tab that is already open.
///
/// Checked by construction rather than by reading the struct: each payload
/// here is the MINIMAL form of its command — only the fields that have always
/// been required — and must decode on its own.
#[test]
fn a_tab_that_omits_newer_fields_is_still_understood() {
    let minimal = [
        json!({ "cmd": "get_initial_state", "args": {} }),
        json!({ "cmd": "set_theme", "args": { "name": "nord" } }),
        json!({ "cmd": "get_scrollback_cells", "args": { "paneId": "%1" } }),
    ];
    for payload in minimal {
        let body = serde_json::to_vec(&payload).expect("payload serializes");
        assert!(
            tmuxy_server::ClientCommand::decode(&body).is_ok(),
            "the minimal form of {payload} must decode — a newly added field has to \
             be #[serde(default)] or Option, or it is a breaking change for open tabs",
        );
    }
}

/// The other direction: a NEW tab against an OLD server cannot be fixed from
/// here, but it must fail legibly. A command the server does not know is a
/// clean rejection, never a panic — the frontend shows the error, and a reload
/// picks up a matching pair.
#[test]
fn a_command_the_server_does_not_know_is_refused_not_fatal() {
    for body in [
        json!({ "cmd": "a_command_from_the_future", "args": {} }),
        json!({ "cmd": "set_theme", "args": {} }), // required field missing
        json!({ "cmd": "set_client_size", "args": { "cols": "wide", "rows": 30 } }), // wrong type
    ] {
        let encoded = serde_json::to_vec(&body).expect("payload serializes");
        let decoded = tmuxy_server::ClientCommand::decode(&encoded);
        assert!(
            decoded.is_err(),
            "{body} should be refused rather than silently matched to something else",
        );
    }
}

/// An unparseable body must not be mistaken for a valid command. Belt and
/// braces around `decode`'s retry path, which reparses the body as a `Value`:
/// a body that is not JSON at all has to come back as the FIRST error.
#[test]
fn a_body_that_is_not_json_is_refused() {
    assert!(tmuxy_server::ClientCommand::decode(b"not json at all").is_err());
    assert!(tmuxy_server::ClientCommand::decode(b"").is_err());
}

// ===========================================================================
// 2. An old CLI against a new server
// ===========================================================================

/// Every `@tmuxy-*` option the shell scripts write, as they write it.
///
/// The CLI and the server are separately installed and separately updated, and
/// they communicate only through these tmux options. A rename on one side is
/// invisible to the other: the writer sets an option nobody reads, the reader
/// finds nothing and falls back to a default, and the feature quietly stops
/// working without a single test failing.
fn tags_written_by_the_shell() -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let bin = repo_root().join("bin");
    let mut files = vec![bin.join("tmuxy-cli")];
    for entry in std::fs::read_dir(bin.join("tmuxy")).expect("bin/tmuxy readable") {
        let entry = entry.expect("readable dir entry");
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            files.push(entry.path());
        }
    }

    for file in files {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let bytes = text.as_bytes();
        let needle = b"@tmuxy-";
        let mut i = 0;
        while let Some(at) = bytes[i..]
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|p| p + i)
        {
            let mut end = at + needle.len();
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
                end += 1;
            }
            found.insert(text[at..end].to_string());
            i = end;
        }
    }
    found
}

#[test]
fn every_tag_the_cli_writes_is_one_the_core_reads() {
    // The Rust side's vocabulary, read from the same place the code reads it.
    let constants =
        std::fs::read_to_string(repo_root().join("packages/tmuxy-core/src/constants.rs"))
            .expect("constants.rs readable");

    let unknown: Vec<String> = tags_written_by_the_shell()
        .into_iter()
        .filter(|tag| !constants.contains(tag.as_str()))
        .collect();

    assert!(
        unknown.is_empty(),
        "the shell scripts write {} tmux option(s) that tmuxy-core never reads: {}\n\
         These two halves ship separately, so a rename on one side is silent: the \
         CLI sets an option nobody reads, the core falls back to a default, and the \
         feature stops working with every test still green. Add the constant to \
         packages/tmuxy-core/src/constants.rs, or fix the spelling in bin/.",
        unknown.len(),
        unknown.join(", "),
    );
}

// ===========================================================================
// 3. Two servers on one socket
// ===========================================================================
//
// Two servers on one tmux socket is a configuration, not a crash — but it is
// never what anyone wants, which is why the three-socket rule exists (a
// released build serves `tmuxy`, the dev server `tmuxy-dev`, the E2E suite
// `tmuxy-test`). The piece of it that is pure logic — that each server's pid
// file is its own, so `tmuxy server stop` cannot read one server's bookkeeping
// and signal another — is pinned in `server.rs`'s own test module, next to the
// private function that decides it:
// `two_servers_on_different_ports_do_not_share_a_pid_file`.
