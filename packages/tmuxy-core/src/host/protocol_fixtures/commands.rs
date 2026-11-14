//! Every command a client can send and every answer it can get, by wire
//! name: `command_requests.json` and `command_results.json`. The client's
//! command table (`packages/tmuxy-ui/src/domain/backendCalls.ts`) is checked
//! against both, so a command, an argument or an answer field renamed on
//! one side shows on the other.

use std::collections::BTreeSet;

use super::{
    assert_fixture, canonical_bindings, canonical_state, canonical_theme_settings, cell,
    styled_cell,
};
use crate::host::{ClientCommand, ConnectionInfo, HostEvent};
use crate::PaneId;

/// How many variants `ClientCommand` has; [`variant`] numbers them.
const COMMANDS: usize = 32;

/// Each variant's number, `0..COMMANDS`. Exhaustive, so a new command does
/// not compile until it is numbered here, and then the tests below want a
/// request and an answer for it.
fn variant(cmd: &ClientCommand) -> usize {
    use ClientCommand as C;
    match cmd {
        C::GetInitialState { .. } => 0,
        C::SetClientSize { .. } => 1,
        C::RunTmuxCommand { .. } => 2,
        C::QueryTmux { .. } => 3,
        C::GetScrollbackCells { .. } => 4,
        C::ReadPreview { .. } => 5,
        C::StagePreview { .. } => 6,
        C::GetThemeSettings => 7,
        C::SetTheme { .. } => 8,
        C::SetThemeMode { .. } => 9,
        C::GetThemesList => 10,
        C::SetCursorBlink { .. } => 11,
        C::SetSendAsk { .. } => 12,
        C::SetTransparency { .. } => 13,
        C::ListGitWorktrees => 14,
        C::ListSnapshots => 15,
        C::RestoreSession { .. } => 16,
        C::GetTraceSettings => 17,
        C::SetTraceEnabled { .. } => 18,
        C::SetTraceLevel { .. } => 19,
        C::RecordTrace { .. } => 20,
        C::OpenTraceFile => 21,
        C::OpenUrl { .. } => 22,
        C::ListServers => 23,
        C::ConnectServer { .. } => 24,
        C::DetachClient => 25,
        C::PreparePluginAction { .. } => 26,
        C::OpenLink { .. } => 27,
        C::OpenText { .. } => 28,
        C::Greeting => 29,
        C::GetTraceShare { .. } => 30,
        C::ListPanePorts => 31,
    }
}

fn pane() -> PaneId {
    PaneId::from_number(2)
}

/// One request per command, every optional argument given, so each
/// argument the host reads is named in the fixture.
fn every_request() -> Vec<ClientCommand> {
    use ClientCommand as C;
    let s = |text: &str| text.to_string();
    vec![
        C::GetInitialState {
            cols: Some(120),
            rows: Some(40),
        },
        C::SetClientSize {
            cols: 120,
            rows: 40,
        },
        C::RunTmuxCommand {
            command: s("split-window -h"),
        },
        C::QueryTmux {
            command: s("list-panes -F '#{pane_id}'"),
        },
        C::GetScrollbackCells {
            pane_id: pane(),
            start: -200,
            end: -1,
        },
        C::ReadPreview {
            pane_id: pane(),
            path: Some(s("img/logo.png")),
        },
        C::StagePreview {
            pane_id: pane(),
            html: s("<p>hi</p>"),
        },
        C::GetThemeSettings,
        C::SetTheme {
            name: s("nord"),
            mode: Some(s("dark")),
        },
        C::SetThemeMode { mode: s("light") },
        C::GetThemesList,
        C::SetCursorBlink { enabled: true },
        C::SetSendAsk { enabled: false },
        C::SetTransparency { enabled: true },
        C::ListGitWorktrees,
        C::ListPanePorts,
        C::ListSnapshots,
        C::RestoreSession { session: s("work") },
        C::GetTraceSettings,
        C::SetTraceEnabled { enabled: true },
        C::SetTraceLevel {
            level: s("labeled"),
        },
        C::RecordTrace {
            events: vec![serde_json::json!({ "layer": "ui", "name": "click" })
                .as_object()
                .cloned()
                .unwrap()],
        },
        C::OpenTraceFile,
        C::OpenUrl {
            url: s("https://example.com"),
        },
        C::ListServers,
        C::ConnectServer {
            id: s("localhost"),
            session: Some(s("work")),
        },
        C::DetachClient,
        C::PreparePluginAction {
            plugin: s("gh"),
            action: s("open"),
            pane_id: pane(),
            selection: Some(s("selected text")),
        },
        C::OpenLink {
            url: s("https://github.com/o/r/pull/1"),
            pane_id: pane(),
        },
        C::OpenText {
            pane_id: pane(),
            line: s("see #12"),
            column: 5,
        },
        C::Greeting,
        C::GetTraceShare { last: 20 },
    ]
}

fn command_names() -> Vec<String> {
    every_request()
        .iter()
        .map(|cmd| {
            serde_json::to_value(cmd).unwrap()["cmd"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

/// One request per command, as both hosts receive it: `{ cmd, args }`.
#[test]
fn every_command_request_matches_its_fixture() {
    let requests = every_request();
    let numbered: BTreeSet<usize> = requests.iter().map(variant).collect();
    assert_eq!(
        numbered,
        (0..COMMANDS).collect(),
        "every_request() must hold one request of each ClientCommand variant"
    );
    assert_eq!(requests.len(), COMMANDS);
    let frames: Vec<serde_json::Value> = requests
        .iter()
        .map(|cmd| {
            let frame = serde_json::to_value(cmd).unwrap();
            let decoded = ClientCommand::from_value(frame.clone())
                .unwrap_or_else(|e| panic!("{frame} does not decode: {e}"));
            assert_eq!(variant(&decoded), variant(cmd), "{frame}");
            frame
        })
        .collect();
    assert_fixture("command_requests.json", &serde_json::Value::Array(frames));
}

/// Every answer a command can give, by its wire name, the way both hosts
/// answer it: a list, since `read_preview` answers a document or a
/// resource. The TypeScript suite decodes each with the schema the client
/// reads it with.
#[test]
fn every_command_answer_matches_its_fixture() {
    use crate::host::{PluginToken, ScrollbackCells, SnapshotInfo, TraceSettings, TraceShare};
    let null = || vec![serde_json::Value::Null];
    let json = |v: &dyn erased::Json| vec![v.to_json()];
    let server = crate::servers::Server {
        session: Some("work".to_string()),
        last_used: Some(1_700_000_000),
        session_count: Some(2),
        ..crate::servers::Server::localhost_on("tmuxy")
    };
    let answers: Vec<(&str, Vec<serde_json::Value>)> = vec![
        ("get_initial_state", json(&canonical_state())),
        ("set_client_size", null()),
        ("run_tmux_command", null()),
        ("query_tmux", vec!["%0 bash\n".into()]),
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
            vec![
                erased::Json::to_json(&crate::preview::PreviewRead::Document(
                    crate::preview::PreviewDocument {
                        kind: "markdown",
                        name: "README.md".to_string(),
                        text: "# hi".to_string(),
                        net: false,
                    },
                )),
                erased::Json::to_json(&crate::preview::PreviewRead::Resource(
                    crate::preview::PreviewResource {
                        mime: "image/png",
                        data: "iVBORw0K".to_string(),
                    },
                )),
            ],
        ),
        ("stage_preview", null()),
        ("get_theme_settings", json(&canonical_theme_settings())),
        ("set_theme", null()),
        ("set_theme_mode", null()),
        (
            "get_themes_list",
            json(&vec![crate::theme::ThemeInfo {
                name: "tokyo-night".to_string(),
                display_name: "Tokyo Night".to_string(),
                modes: vec!["dark", "light"],
            }]),
        ),
        ("set_cursor_blink", null()),
        ("set_send_ask", null()),
        ("set_transparency", null()),
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
                    changes: None,
                }],
            }]),
        ),
        (
            "list_pane_ports",
            json(&vec![crate::ports::PanePorts {
                pane_id: "%2".to_string(),
                ports: vec![5173, 8123],
            }]),
        ),
        (
            "list_snapshots",
            json(&vec![SnapshotInfo {
                name: "work".to_string(),
                saved_at: 1_700_000_000,
            }]),
        ),
        ("restore_session", null()),
        (
            "get_trace_settings",
            json(&TraceSettings {
                enabled: true,
                level: "shape",
                path: "/home/u/.local/state/tmuxy/trace.ndjson".to_string(),
                locked: false,
            }),
        ),
        ("set_trace_enabled", vec![true.into()]),
        ("set_trace_level", vec!["labeled".into()]),
        ("record_trace", null()),
        ("open_trace_file", null()),
        (
            "get_trace_share",
            json(&TraceShare {
                text: "{\"layer\":\"tmux\",\"op\":\"Split\",\"session\":\"session-1\"}\n"
                    .to_string(),
                lines: 1,
            }),
        ),
        ("open_url", null()),
        (
            "list_servers",
            json(&crate::servers::ServerList {
                servers: vec![server],
                current_id: "localhost".to_string(),
            }),
        ),
        ("connect_server", null()),
        ("detach_client", null()),
        (
            "prepare_plugin_action",
            json(&PluginToken {
                token: "tok-1".to_string(),
            }),
        ),
        (
            "open_link",
            vec![
                erased::Json::to_json(&Some(crate::plugins::links::Prepared {
                    plugin: "gh".to_string(),
                    action: "open".to_string(),
                    token: "tok-2".to_string(),
                })),
                serde_json::Value::Null,
            ],
        ),
        ("open_text", null()),
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
    let answered: BTreeSet<String> = answers.iter().map(|(name, _)| name.to_string()).collect();
    assert_eq!(
        answered,
        command_names().into_iter().collect(),
        "command_results.json must answer exactly the commands a client can send"
    );
    assert_fixture(
        "command_results.json",
        &serde_json::Value::Object(
            answers
                .into_iter()
                .map(|(name, value)| (name.to_string(), serde_json::Value::Array(value)))
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
