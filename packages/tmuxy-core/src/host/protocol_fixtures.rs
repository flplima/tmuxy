//! Canonical wire-shape fixtures, written by Rust and read back by the
//! TypeScript decoders (`packages/tmuxy-ui/src/infra/transport/__tests__/`):
//! every event both hosts push ([`HostEvent`]), every command's answer, and
//! the state shapes.
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
//! UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-core protocol_fixtures
//! ```

use super::{ConnectionInfo, HostEvent};
use crate::control_mode::LogKind;
use crate::transport::{KeyBinding, KeyBindings};
use crate::{CommandError, StateUpdate};

mod answers;
mod canonical;
use canonical::{canonical_delta, canonical_state, cell, styled_cell};

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
             Regenerate with UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-core protocol_fixtures"
        )
    });
    assert_eq!(
        committed, rendered,
        "protocol fixture {name} no longer matches what the Rust types emit. \
         The TypeScript decoders are pinned to this file — update both sides, then \
         regenerate with UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-core protocol_fixtures"
    );
}

/// `get_initial_state`'s 200 body on the web — the `{ result }` envelope the
/// adapter unwraps before decoding a `ServerState` out of `result`.
#[test]
fn get_initial_state_response_matches_its_fixture() {
    assert_fixture(
        "get_initial_state.json",
        &serde_json::json!({ "result": canonical_state() }),
    );
}

/// The two `state-update` frames, exactly as they go down the SSE wire.
#[test]
fn state_update_frames_match_their_fixtures() {
    for (name, update) in [
        (
            "event_state_update_full.json",
            StateUpdate::Full {
                state: canonical_state(),
            },
        ),
        (
            "event_state_update_delta.json",
            StateUpdate::Delta {
                delta: canonical_delta(),
            },
        ),
    ] {
        let event = HostEvent::StateUpdate(Box::new(update));
        assert_fixture(name, &serde_json::to_value(&event).unwrap());
    }
}

fn binding(key: &str, command: &str, description: &str, repeat: bool) -> KeyBinding {
    KeyBinding {
        key: key.to_string(),
        command: command.to_string(),
        description: description.to_string(),
        repeat,
    }
}

fn canonical_bindings() -> KeyBindings {
    KeyBindings {
        prefix_key: "C-b".to_string(),
        prefix_bindings: vec![binding("c", "new-window", "new window", false)],
        root_bindings: vec![binding("M-Left", "select-pane -L", "pane left", true)],
        tables: [(
            "pane".to_string(),
            vec![binding(
                "x",
                "kill-pane \\; switch-client -T pane",
                "kill-pane \\; switch-client -T pane",
                false,
            )],
        )]
        .into(),
    }
}

/// Settings with every field populated: a css variable, a text icon and an
/// inlined SVG, a pinned option, and a fixed size (the policy with fields).
fn canonical_theme_settings() -> crate::theme::ThemeSettings {
    crate::theme::ThemeSettings {
        theme: "nord".to_string(),
        mode: "dark".to_string(),
        appearance: crate::theme::Appearance {
            size: crate::client_size::SizePolicy::Fixed {
                cols: 120,
                rows: 40,
            },
            ..crate::theme::Appearance::default()
        },
        css_vars: [("term-red".to_string(), "#ff0000".into())]
            .into_iter()
            .collect(),
        icons: [
            ("claude".to_string(), "*".into()),
            (
                "codex".to_string(),
                "data:image/svg+xml;base64,PHN2Zy8+".into(),
            ),
        ]
        .into_iter()
        .collect(),
        pinned: vec!["@tmuxy-opacity"],
    }
}

/// Every event other than `state-update`. One list, so the fixture and the
/// client's table of names can never disagree about what a host can emit.
fn every_other_event() -> Vec<HostEvent> {
    vec![
        HostEvent::ConnectionInfo(ConnectionInfo {
            connection_id: 3,
            default_shell: "zsh".to_string(),
            trace_enabled: true,
            hostname: "gaphs04".to_string(),
        }),
        HostEvent::Error {
            message: "unknown command: frobnicate".to_string(),
        },
        HostEvent::Reconnecting {
            message: "Failed to connect to control mode: no server (attempt 1 of 5)".to_string(),
        },
        HostEvent::KeyBindings(canonical_bindings()),
        HostEvent::ThemeSettings(Box::new(canonical_theme_settings())),
        HostEvent::CssChanged,
        HostEvent::Log {
            kind: LogKind::Command,
            message: "tmux has-session -t tmuxy".to_string(),
        },
        HostEvent::Fatal {
            message: "tmux exited and will not be retried".to_string(),
        },
        HostEvent::Detached {
            reason: Some("detached".to_string()),
        },
        HostEvent::Clipboard {
            pane_id: "%2".to_string(),
            text: "copied".to_string(),
        },
        HostEvent::Message {
            text: "build done".to_string(),
        },
    ]
}

/// Every other event, in one fixture the TypeScript suite walks so a new
/// variant cannot be added without the client learning to read it. The
/// desktop's Tauri event is a frame's `data`, under its `event` name.
#[test]
fn every_event_matches_its_fixture() {
    let frames: Vec<serde_json::Value> = every_other_event()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    assert_fixture("events.json", &serde_json::Value::Array(frames));
}

/// The error bodies a client has to render: one of each kind.
#[test]
fn command_error_responses_match_their_fixture() {
    let bodies: Vec<serde_json::Value> = [
        CommandError::tmux("can't find pane: %99"),
        CommandError::invalid("invalid command payload: unknown variant `frobnicate`"),
        CommandError::forbidden("resize-window must go through set_client_size"),
        CommandError::unavailable("No monitor connection available"),
        CommandError::unavailable("tmux monitor did not answer with the initial state"),
        CommandError::unavailable("detaching is not available here"),
    ]
    .iter()
    .map(|error| serde_json::to_value(error).unwrap())
    .collect();
    assert_fixture("command_errors.json", &serde_json::Value::Array(bodies));
}
