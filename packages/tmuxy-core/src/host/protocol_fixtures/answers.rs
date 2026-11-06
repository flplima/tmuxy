//! One answer per command, by its wire name: `command_results.json`.

use super::{
    assert_fixture, canonical_bindings, canonical_state, canonical_theme_settings, cell,
    styled_cell,
};
use crate::host::{ConnectionInfo, HostEvent};

/// One answer per command, by its wire name, the way both hosts answer it.
/// The TypeScript suite decodes each with the schema the client reads it
/// with, so a field renamed on one side shows on the other.
#[test]
fn every_command_answer_matches_its_fixture() {
    use crate::transport::{PluginToken, ScrollbackCells, SnapshotInfo, TraceSettings};
    let answer = |v: serde_json::Value| v;
    let json = |v: &dyn erased::Json| v.to_json();
    let server = crate::servers::Server {
        session: Some("work".to_string()),
        last_used: Some(1_700_000_000),
        session_count: Some(2),
        ..crate::servers::Server::localhost_on("tmuxy")
    };
    let answers: Vec<(&str, serde_json::Value)> = vec![
        ("get_initial_state", json(&canonical_state())),
        ("set_client_size", answer(serde_json::Value::Null)),
        ("run_tmux_command", answer(serde_json::Value::Null)),
        ("query_tmux", answer("%0 bash\n".into())),
        (
            "get_scrollback_cells",
            json(&ScrollbackCells {
                cells: vec![vec![cell("h"), styled_cell("i")]],
                history_size: 1234,
                start: -200,
                end: -1,
                width: 80,
            }),
        ),
        (
            "read_preview",
            json(&crate::preview::PreviewRead::Document(
                crate::preview::PreviewDocument {
                    kind: "markdown",
                    name: "README.md".to_string(),
                    text: "# hi".to_string(),
                    net: false,
                },
            )),
        ),
        (
            "read_preview_resource",
            json(&crate::preview::PreviewRead::Resource(
                crate::preview::PreviewResource {
                    mime: "image/png",
                    data: "iVBORw0K".to_string(),
                },
            )),
        ),
        ("stage_preview", answer(serde_json::Value::Null)),
        ("get_theme_settings", json(&canonical_theme_settings())),
        (
            "get_themes_list",
            json(&vec![crate::theme::ThemeInfo {
                name: "tokyo-night".to_string(),
                display_name: "Tokyo Night".to_string(),
                modes: vec!["dark", "light"],
            }]),
        ),
        (
            "list_git_worktrees",
            json(&vec![crate::worktrees::GitRepository {
                id: "/src/tmuxy".to_string(),
                name: "tmuxy".to_string(),
                root: Some("/src/tmuxy".to_string()),
                worktrees: vec![crate::worktrees::GitWorktree {
                    path: "/src/tmuxy".to_string(),
                    branch: Some("main".to_string()),
                    head: "0123abc".to_string(),
                    is_main: true,
                    detached: false,
                    bare: false,
                    locked: false,
                    prunable: false,
                }],
            }]),
        ),
        (
            "list_snapshots",
            json(&vec![SnapshotInfo {
                name: "work".to_string(),
                saved_at: 1_700_000_000,
            }]),
        ),
        (
            "get_trace_settings",
            json(&TraceSettings {
                enabled: true,
                level: "shape",
                path: "/home/u/.local/state/tmuxy/trace.ndjson".to_string(),
                locked: false,
            }),
        ),
        ("set_trace_enabled", answer(true.into())),
        ("set_trace_level", answer("labeled".into())),
        (
            "list_servers",
            json(&crate::servers::ServerList {
                servers: vec![server],
                current_id: "localhost".to_string(),
            }),
        ),
        (
            "prepare_plugin_action",
            json(&PluginToken {
                token: "tok-1".to_string(),
            }),
        ),
        (
            "open_link",
            json(&Some(crate::plugins::links::Prepared {
                plugin: "gh".to_string(),
                action: "open".to_string(),
                token: "tok-2".to_string(),
            })),
        ),
        ("open_text", answer(serde_json::Value::Null)),
        (
            "greeting",
            json(&vec![
                HostEvent::ConnectionInfo(ConnectionInfo {
                    connection_id: 0,
                    default_shell: "zsh".to_string(),
                    trace_enabled: false,
                    hostname: "gaphs04".to_string(),
                }),
                HostEvent::KeyBindings(canonical_bindings()),
            ]),
        ),
    ];
    assert_fixture(
        "command_results.json",
        &serde_json::Value::Object(
            answers
                .into_iter()
                .map(|(name, value)| (name.to_string(), value))
                .collect(),
        ),
    );
}

/// `serde_json::to_value` behind a trait object, so one list holds every
/// answer type.
mod erased {
    pub trait Json {
        fn to_json(&self) -> serde_json::Value;
    }
    impl<T: serde::Serialize> Json for T {
        fn to_json(&self) -> serde_json::Value {
            serde_json::to_value(self).unwrap()
        }
    }
}
