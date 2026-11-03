//! The MCP tools: one per CLI command an agent drives tmuxy with, each the
//! same operation over the session's control-mode connection.
//!
//! | Tool             | Same as                      | Changes things? |
//! | ---------------- | ---------------------------- | --------------- |
//! | `status`         | `tmuxy --json`               | no              |
//! | `pane_list`      | `tmuxy pane list --all`      | no              |
//! | `tab_list`       | `tmuxy tab list`             | no              |
//! | `pane_capture`   | `tmuxy pane capture`         | no              |
//! | `pane_wait_for`  | a `pane capture` loop        | no              |
//! | `pane_split`     | `tmuxy pane split`           | yes             |
//! | `pane_send_keys` | `tmuxy pane send -t`         | yes             |
//! | `pane_float`     | `tmuxy pane float`           | yes             |
//! | `tab_create`     | `tmuxy tab create`           | yes             |
//! | `open_preview`   | `tmuxy open <file>`          | yes             |
//! | `pane_kill`      | `tmuxy pane kill`            | yes             |
//!
//! An agent acts beside the user, so nothing here moves the user's focus:
//! a split, a tab and a float open without taking the keyboard.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tmuxy_core::CommandError;

mod open;
mod read;
mod schemas;

#[cfg(test)]
pub(super) use open::{
    float_command, float_create_args, preview_path, split_command, tab_command, FloatArgs,
    FloatPosition, SplitDirection, TabArgs,
};
use open::{open_preview, pane_float, pane_kill, pane_send_keys, pane_split, tab_create};
#[cfg(test)]
pub(super) use read::{find_on_screen, screen_pattern, trim_screen};
use read::{pane_capture, pane_list, pane_wait_for, status};
use schemas::*;

use super::tmux::Tmux;
use super::Caller;
use crate::state::AppState;

pub(super) struct Tool {
    pub name: &'static str,
    title: &'static str,
    description: &'static str,
    /// Whether it changes the session; a `?read-only` endpoint lists only the
    /// tools that do not.
    pub changes: bool,
    /// Whether what it changes can be lost (a killed pane's program).
    destructive: bool,
    schema: fn() -> Value,
}

pub(super) const TOOLS: &[Tool] = &[
    Tool {
        name: "status",
        title: "Session status",
        description: "The tmux session tmuxy shows: its name, tmux's version, the focused tab \
                      and pane, how many tabs and panes it has, and how many browser windows \
                      are watching it.",
        changes: false,
        destructive: false,
        schema: no_arguments,
    },
    Tool {
        name: "pane_list",
        title: "List panes",
        description: "Every pane of the session — in tabs, floats and sidebars — with its id, \
                      tab, kind, size, the program in front, its title and label, and which \
                      one the user has focused (active).",
        changes: false,
        destructive: false,
        schema: pane_list_schema,
    },
    Tool {
        name: "tab_list",
        title: "List tabs",
        description: "The session's tabs, with their id, index, name, pane count and which one \
                      is in front.",
        changes: false,
        destructive: false,
        schema: no_arguments,
    },
    Tool {
        name: "pane_capture",
        title: "Read a pane",
        description: "What a pane's screen shows, as plain text, with the cursor position. \
                      `scrollback` adds that many lines of history above the screen.",
        changes: false,
        destructive: false,
        schema: pane_capture_schema,
    },
    Tool {
        name: "pane_wait_for",
        title: "Wait for output",
        description: "Wait until a pane's screen matches a regular expression (Rust regex \
                      syntax), up to `timeout_seconds` (default 30, at most 600). Answers the \
                      matching line; fails with the screen's last lines on a timeout.",
        changes: false,
        destructive: false,
        schema: pane_wait_for_schema,
    },
    Tool {
        name: "pane_split",
        title: "Split a pane",
        description: "Split a pane (the focused one by default) to the right or below, \
                      optionally running a shell command in the new pane. Answers the new \
                      pane's id. The user's focus stays where it is.",
        changes: true,
        destructive: false,
        schema: pane_split_schema,
    },
    Tool {
        name: "pane_send_keys",
        title: "Type into a pane",
        description: "Type keys into a pane, as tmux send-keys does: each entry is literal text \
                      or a key name (Enter, Escape, C-c, Up, …), sent in order with nothing \
                      between them. The user is asked in that pane first (unless they turned \
                      that off), and this waits for their answer: it fails, sending nothing, \
                      when they decline or `timeout_seconds` (default 120, at most 600) passes.",
        changes: true,
        destructive: false,
        schema: pane_send_keys_schema,
    },
    Tool {
        name: "pane_float",
        title: "Open a float",
        description: "Open a floating pane over the current tab — centred, or as a drawer \
                      docked to an edge — with a shell, or running a shell command. Answers its \
                      pane id.",
        changes: true,
        destructive: false,
        schema: pane_float_schema,
    },
    Tool {
        name: "tab_create",
        title: "Open a tab",
        description: "Open a new tab, optionally named and running a shell command, without \
                      switching to it. Answers its tab id.",
        changes: true,
        destructive: false,
        schema: tab_create_schema,
    },
    Tool {
        name: "open_preview",
        title: "Preview a file",
        description: "Show a local Markdown (.md, mermaid included) or HTML file rendered in a \
                      float, following the file as it changes. The path must be absolute.",
        changes: true,
        destructive: false,
        schema: open_preview_schema,
    },
    Tool {
        name: "pane_kill",
        title: "Close a pane",
        description: "Close a pane, ending the program in it.",
        changes: true,
        destructive: true,
        schema: pane_kill_schema,
    },
];

/// The tools a client sees, as `tools/list` answers them.
pub(super) fn listed(read_only: bool) -> Vec<Value> {
    TOOLS
        .iter()
        .filter(|tool| !(read_only && tool.changes))
        .map(|tool| {
            json!({
                "name": tool.name,
                "title": tool.title,
                "description": tool.description,
                "inputSchema": (tool.schema)(),
                "annotations": {
                    "title": tool.title,
                    "readOnlyHint": !tool.changes,
                    "destructiveHint": tool.destructive,
                    "idempotentHint": !tool.changes,
                    "openWorldHint": false,
                },
            })
        })
        .collect()
}

/// The tool a `tools/call` names, if this endpoint offers it.
pub(super) fn find(name: &str, read_only: bool) -> Option<&'static Tool> {
    TOOLS
        .iter()
        .find(|tool| tool.name == name && !(read_only && tool.changes))
}

pub(super) async fn call(
    tool: &Tool,
    state: &Arc<AppState>,
    caller: &Caller,
    arguments: &Value,
) -> Result<Value, CommandError> {
    let tmux = Tmux::attach(state, &caller.session).await?;
    run(tool.name, &tmux, caller, arguments).await
}

pub(super) async fn run(
    name: &str,
    tmux: &Tmux,
    caller: &Caller,
    arguments: &Value,
) -> Result<Value, CommandError> {
    match name {
        "status" => status(tmux, caller).await,
        "pane_list" => pane_list(tmux, args(arguments)?).await,
        "tab_list" => Ok(json!({ "tabs": tmux.tabs().await? })),
        "pane_capture" => pane_capture(tmux, args(arguments)?).await,
        "pane_wait_for" => pane_wait_for(tmux, args(arguments)?).await,
        "pane_split" => pane_split(tmux, args(arguments)?).await,
        "pane_send_keys" => pane_send_keys(tmux, caller, args(arguments)?).await,
        "pane_float" => pane_float(tmux, args(arguments)?).await,
        "tab_create" => tab_create(tmux, args(arguments)?).await,
        "open_preview" => open_preview(tmux, args(arguments)?).await,
        "pane_kill" => pane_kill(tmux, args(arguments)?).await,
        _ => Err(CommandError::invalid(format!("unknown tool: {name}"))),
    }
}

fn args<T: for<'de> Deserialize<'de>>(arguments: &Value) -> Result<T, CommandError> {
    serde_json::from_value(arguments.clone())
        .map_err(|e| CommandError::invalid(format!("invalid arguments: {e}")))
}

/// A timeout an agent gave, in whole seconds, held to `max`.
fn timeout(seconds: Option<u64>, default: Duration, max: Duration) -> Duration {
    seconds.map_or(default, Duration::from_secs).min(max)
}
