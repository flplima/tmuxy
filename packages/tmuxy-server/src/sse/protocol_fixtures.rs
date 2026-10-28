//! Canonical wire-shape fixtures, written by Rust and read back by the
//! TypeScript decoders (`packages/tmuxy-ui/src/infra/transport/__tests__/`).
//!
//! There is no ts-rs/specta/typeshare in this workspace: the Effect schemas
//! and `deltaProtocol.ts` mirror these Rust types by hand, and a field that
//! drifts between the two (`history_size` did) is invisible to both test
//! suites. These fixtures are the shared artefact — Rust emits them from the
//! live types, TypeScript decodes the committed files, and either side
//! changing shape turns one of the two suites red.
//!
//! Regenerate with:
//!
//! ```sh
//! UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-server protocol_fixtures
//! ```

use super::*;
use std::collections::HashMap;
use tmuxy_core::control_mode::images::{ImagePlacement, ImageProtocol};
use tmuxy_core::control_mode::LogKind;
use tmuxy_core::transport::KeyBindings;
use tmuxy_core::{
    CellStyle, CommandError, PaneDelta, StateUpdate, TerminalCell, TmuxDelta, TmuxPane, TmuxState,
    TmuxWindow, WindowDelta, WindowType,
};

/// Where the committed fixtures live, shared with the Vitest suite.
fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol-fixtures")
}

/// `value` with every object's keys in order. serde_json keeps insertion
/// order (the agent installer needs it), and a `HashMap` field — a delta's
/// windows — inserts in no fixed order, so the file is rendered sorted.
fn sorted_keys(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            serde_json::Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), sorted_keys(&map[k])))
                    .collect(),
            )
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(sorted_keys).collect())
        }
        other => other.clone(),
    }
}

/// Write `value` to `name` when regenerating, otherwise assert the
/// committed file is byte-for-byte what the code emits today.
fn assert_fixture(name: &str, value: &serde_json::Value) {
    let path = fixture_dir().join(name);
    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(&sorted_keys(value)).unwrap()
    );
    if std::env::var("UPDATE_PROTOCOL_FIXTURES").is_ok() {
        std::fs::create_dir_all(fixture_dir()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "protocol fixture {name} is missing ({e}). \
             Regenerate with UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-server protocol_fixtures"
        )
    });
    assert_eq!(
        committed, rendered,
        "protocol fixture {name} no longer matches what the Rust types emit. \
         The TypeScript decoders are pinned to this file — update both sides, then \
         regenerate with UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-server protocol_fixtures"
    );
}

fn cell(c: &str) -> TerminalCell {
    TerminalCell::new(c.to_string())
}

fn styled_cell(c: &str) -> TerminalCell {
    TerminalCell::with_style(
        c.to_string(),
        CellStyle {
            fg: Some(tmuxy_core::CellColor::Rgb {
                r: 200,
                g: 40,
                b: 40,
            }),
            bg: Some(tmuxy_core::CellColor::Indexed(4)),
            bold: true,
            dim: true,
            italic: true,
            underline: true,
            inverse: true,
            url: Some("https://example.com".to_string()),
            size: None,
        },
    )
}

/// A state that populates EVERY field of every type on the wire. A field
/// left at its default would be skipped by `skip_serializing_if` and
/// never reach the TypeScript decoder, which is exactly the hole a
/// fixture is supposed to close.
fn canonical_state() -> TmuxState {
    TmuxState {
        session_name: "tmuxy".to_string(),
        active_window_id: Some("@1".parse().unwrap()),
        active_pane_id: Some("%2".parse().unwrap()),
        panes: vec![
            TmuxPane {
                id: 2,
                tmux_id: "%2".parse().unwrap(),
                window_id: "@1".parse().unwrap(),
                content: std::sync::Arc::new(vec![
                    vec![cell("h"), cell("i")],
                    vec![styled_cell("!")],
                ]),
                cursor_x: 2,
                cursor_y: 0,
                width: 80,
                height: 24,
                x: 0,
                y: 0,
                active: true,
                command: "zsh".to_string(),
                title: "pane title".to_string(),
                border_title: "border".to_string(),
                group_id: Some("g5".parse().unwrap()),
                in_mode: true,
                copy_cursor_x: 3,
                copy_cursor_y: 4,
                alternate_on: true,
                mouse_any_flag: true,
                marked: true,
                paused: true,
                history_size: 1234,
                selection_present: true,
                selection_start_x: 1,
                selection_start_y: -2,
                images: vec![ImagePlacement {
                    id: 7,
                    row: 3,
                    col: 4,
                    width_cells: 10,
                    height_cells: 5,
                    protocol: ImageProtocol::Kitty,
                    stretch: false,
                }],
                cursor_shape: 6,
                cursor_hidden: true,
                pane_state: Some("working".to_string()),
                pane_ask: Some("eyJ0b2tlbiI6ImExIn0=".to_string()),
                pane_widget: Some("tree".to_string()),
                pane_restore: None,
                group_pos: None,
            },
            TmuxPane {
                id: 3,
                tmux_id: "%3".parse().unwrap(),
                window_id: "@1".parse().unwrap(),
                content: std::sync::Arc::new(vec![vec![]]),
                cursor_x: 0,
                cursor_y: 0,
                width: 80,
                height: 24,
                x: 0,
                y: 25,
                active: false,
                command: "nvim".to_string(),
                title: String::new(),
                border_title: String::new(),
                group_id: None,
                in_mode: false,
                copy_cursor_x: 0,
                copy_cursor_y: 0,
                alternate_on: false,
                mouse_any_flag: false,
                marked: false,
                paused: false,
                history_size: 0,
                selection_present: false,
                selection_start_x: 0,
                selection_start_y: 0,
                images: vec![],
                cursor_shape: 0,
                cursor_hidden: false,
                pane_state: None,
                pane_ask: None,
                pane_widget: None,
                pane_restore: None,
                group_pos: None,
            },
        ],
        windows: vec![
            TmuxWindow {
                id: "@1".parse().unwrap(),
                index: 0,
                name: "main".to_string(),
                active: true,
                window_type: Some(WindowType::Tab),
                float_parent: None,
                float_width: None,
                float_height: None,
                float_drawer: None,
                float_bg: None,
                float_noheader: false,
                sidebar_cols: None,
                sidebar_hidden: false,
                collapsible: true,
                zoomed: true,
                active_pane_id: Some("%2".parse().unwrap()),
                pane_tree: Some(tmuxy_core::layout::PaneTree::Split {
                    vertical: false,
                    children: vec![
                        tmuxy_core::layout::PaneTree::Pane("%1".parse().unwrap()),
                        tmuxy_core::layout::PaneTree::Pane("%2".parse().unwrap()),
                    ],
                }),
            },
            TmuxWindow {
                id: "@2".parse().unwrap(),
                index: 1,
                name: "float".to_string(),
                active: false,
                window_type: Some(WindowType::Float),
                float_parent: Some("@1".parse().unwrap()),
                float_width: Some(60),
                float_height: Some(20),
                float_drawer: Some("bottom".to_string()),
                float_bg: Some("dim".to_string()),
                float_noheader: true,
                sidebar_cols: Some(30),
                sidebar_hidden: true,
                collapsible: false,
                zoomed: false,
                active_pane_id: None,
                pane_tree: None,
            },
        ],
        total_width: 80,
        total_height: 50,
        focus_request: Some("left".to_string()),
        seq: 41,
    }
}

/// A delta touching every field the client merges, including the removal
/// shapes (`null` pane / window) and the sparse content map.
fn canonical_delta() -> TmuxDelta {
    let mut panes: HashMap<tmuxy_core::PaneId, Option<PaneDelta>> = HashMap::new();
    panes.insert(
        "%2".parse().unwrap(),
        Some(PaneDelta {
            window_id: Some("@2".parse().unwrap()),
            content: Some(HashMap::from([(1usize, vec![cell("x"), styled_cell("y")])])),
            cursor_x: Some(5),
            cursor_y: Some(6),
            width: Some(100),
            height: Some(30),
            x: Some(1),
            y: Some(2),
            active: Some(false),
            command: Some("bash".to_string()),
            title: Some("new title".to_string()),
            border_title: Some("new border".to_string()),
            group_id: Some(None),
            pane_state: Some(Some("idle".to_string())),
            pane_ask: Some(None),
            pane_widget: Some(Some("tree".to_string())),
            pane_restore: None,
            group_pos: None,
            in_mode: Some(false),
            copy_cursor_x: Some(7),
            copy_cursor_y: Some(8),
            alternate_on: Some(false),
            mouse_any_flag: Some(false),
            marked: Some(false),
            paused: Some(false),
            history_size: Some(4321),
            selection_present: Some(false),
            selection_start_x: Some(9),
            selection_start_y: Some(-10),
            images: Some(vec![]),
            cursor_shape: Some(2),
            cursor_hidden: Some(false),
        }),
    );
    panes.insert("%3".parse().unwrap(), None);

    let mut windows: HashMap<tmuxy_core::WindowId, Option<WindowDelta>> = HashMap::new();
    windows.insert(
        "@1".parse().unwrap(),
        Some(WindowDelta {
            index: Some(1),
            name: Some("renamed".to_string()),
            active: Some(false),
            window_type: Some(Some(WindowType::SidebarLeft)),
            float_parent: Some(None),
            float_width: Some(Some(70)),
            float_height: Some(Some(25)),
            float_drawer: Some(Some("top".to_string())),
            float_bg: Some(Some("blur".to_string())),
            float_noheader: Some(true),
            sidebar_cols: Some(Some(40)),
            sidebar_hidden: Some(true),
            collapsible: Some(false),
            zoomed: Some(false),
            active_pane_id: Some(Some("%4".parse().unwrap())),
            pane_tree: Some(Some(tmuxy_core::layout::PaneTree::Split {
                vertical: true,
                children: vec![
                    tmuxy_core::layout::PaneTree::Pane("%3".parse().unwrap()),
                    tmuxy_core::layout::PaneTree::Pane("%4".parse().unwrap()),
                ],
            })),
        }),
    );
    windows.insert("@2".parse().unwrap(), None);

    TmuxDelta {
        seq: 42,
        panes: Some(panes),
        windows: Some(windows),
        new_panes: Some(vec![TmuxPane {
            id: 4,
            tmux_id: "%4".parse().unwrap(),
            window_id: "@1".parse().unwrap(),
            content: std::sync::Arc::new(vec![vec![cell("n")]]),
            cursor_x: 1,
            cursor_y: 0,
            width: 40,
            height: 12,
            x: 0,
            y: 0,
            active: true,
            command: "fish".to_string(),
            title: String::new(),
            border_title: String::new(),
            group_id: None,
            in_mode: false,
            copy_cursor_x: 0,
            copy_cursor_y: 0,
            alternate_on: false,
            mouse_any_flag: false,
            marked: false,
            paused: false,
            history_size: 11,
            selection_present: false,
            selection_start_x: 0,
            selection_start_y: 0,
            images: vec![],
            cursor_shape: 0,
            cursor_hidden: false,
            pane_state: None,
            pane_ask: None,
            pane_widget: None,
            pane_restore: None,
            group_pos: None,
        }]),
        new_windows: Some(vec![TmuxWindow {
            id: "@3".parse().unwrap(),
            index: 2,
            name: "added".to_string(),
            active: false,
            window_type: Some(WindowType::Float),
            float_parent: Some("@2".parse().unwrap()),
            float_width: None,
            float_height: None,
            float_drawer: None,
            float_bg: None,
            float_noheader: false,
            sidebar_cols: None,
            sidebar_hidden: false,
            collapsible: false,
            zoomed: false,
            active_pane_id: None,
            pane_tree: None,
        }]),
        active_window_id: Some("@2".parse().unwrap()),
        active_pane_id: Some("%4".parse().unwrap()),
        focus_request: Some(String::new()),
        total_width: Some(100),
        total_height: Some(60),
    }
}

/// `get_initial_state`'s 200 body — the `CommandResponse` envelope the
/// adapter unwraps before decoding a `ServerState` out of `result`.
#[test]
fn get_initial_state_response_matches_its_fixture() {
    let response = CommandResponse {
        result: serde_json::to_value(canonical_state()).unwrap(),
    };
    assert_fixture(
        "get_initial_state.json",
        &serde_json::to_value(&response).unwrap(),
    );
}

/// The two `state-update` frames, exactly as they go down the SSE wire:
/// the `event:` name the browser dispatches on, and the `data:` payload.
#[test]
fn state_update_frames_match_their_fixtures() {
    for (name, update) in [
        (
            "sse_state_update_full.json",
            StateUpdate::Full {
                state: canonical_state(),
            },
        ),
        (
            "sse_state_update_delta.json",
            StateUpdate::Delta {
                delta: canonical_delta(),
            },
        ),
    ] {
        let payload = encode_event(&SseEvent::StateUpdate(Box::new(update))).unwrap();
        assert_fixture(name, &frame(&payload));
    }
}

/// Every SSE frame other than `state-update`. One list, so the fixture
/// and the naming check below can never disagree about what the server
/// can emit.
pub(super) fn every_other_sse_event() -> Vec<SseEvent> {
    vec![
        SseEvent::ConnectionInfo {
            connection_id: 3,
            default_shell: "/bin/zsh".to_string(),
            trace_enabled: true,
            hostname: "gaphs04".to_string(),
        },
        SseEvent::Error {
            message: "unknown command: frobnicate".to_string(),
        },
        SseEvent::KeyBindings(KeyBindings {
            prefix_key: "C-b".to_string(),
            prefix_bindings: vec![tmuxy_core::KeyBinding {
                key: "c".to_string(),
                command: "new-window".to_string(),
                description: "new window".to_string(),
                repeat: false,
            }],
            root_bindings: vec![tmuxy_core::KeyBinding {
                key: "M-Left".to_string(),
                command: "select-pane -L".to_string(),
                description: "pane left".to_string(),
                repeat: true,
            }],
            tables: [(
                "pane".to_string(),
                vec![tmuxy_core::KeyBinding {
                    key: "x".to_string(),
                    command: "kill-pane \\; switch-client -T pane".to_string(),
                    description: "kill-pane \\; switch-client -T pane".to_string(),
                    repeat: false,
                }],
            )]
            .into(),
        }),
        SseEvent::ThemeSettings(serde_json::json!({
            "name": "default",
            "mode": "dark",
            "opacity": 0.9,
        })),
        SseEvent::CssChanged,
        SseEvent::Log {
            kind: LogKind::Command,
            message: "tmux has-session -t tmuxy".to_string(),
        },
        SseEvent::Fatal {
            message: "tmux exited and will not be retried".to_string(),
        },
        SseEvent::Detached {
            reason: Some("detached".to_string()),
        },
        SseEvent::Clipboard {
            pane_id: "%2".parse().unwrap(),
            text: "copied".to_string(),
        },
        SseEvent::Message {
            text: "build done".to_string(),
        },
    ]
}

/// Every other SSE frame, in one fixture the TypeScript suite walks so a
/// new variant cannot be added without the client learning to read it.
#[test]
fn every_sse_frame_matches_its_fixture() {
    let frames: Vec<serde_json::Value> = every_other_sse_event()
        .iter()
        .map(|e| frame(&encode_event(e).unwrap()))
        .collect();
    assert_fixture("sse_frames.json", &serde_json::Value::Array(frames));
}

/// The `/commands` error bodies a client has to render: one of each kind.
#[test]
fn command_error_responses_match_their_fixture() {
    let bodies: Vec<serde_json::Value> = [
        CommandError::tmux("can't find pane: %99"),
        CommandError::invalid("invalid command payload: unknown variant `frobnicate`"),
        CommandError::forbidden("resize-window must go through set_client_size"),
        CommandError::unavailable("No monitor connection available"),
        CommandError::unavailable("tmux monitor did not answer with the initial state"),
    ]
    .iter()
    .map(|error| serde_json::to_value(error).unwrap())
    .collect();
    assert_fixture("command_errors.json", &serde_json::Value::Array(bodies));
}

/// An SSE frame as the browser sees it: the `event:` name comes from
/// `sse_event_type`, the `data:` line from the serialised payload.
fn frame(payload: &str) -> serde_json::Value {
    serde_json::json!({
        "event": sse_event_type(payload),
        "data": serde_json::from_str::<serde_json::Value>(payload).unwrap()["data"],
    })
}
