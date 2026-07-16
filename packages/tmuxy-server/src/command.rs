//! Typed wire schema for client → server commands.
//!
//! `ClientCommand` is the canonical Rust mirror of the JSON payload the
//! frontend POSTs to `/commands`. The old code parsed each branch by
//! reaching into `serde_json::Value` (`args.get("paneId").and_then(...)`),
//! which made every typo silent and every signature change a runtime hunt
//! through the SSE handler.
//!
//! The wire shape is preserved exactly:
//!
//! ```json
//! { "cmd": "send_keys_to_tmux", "args": { "keys": "ls Enter" } }
//! ```
//!
//! `#[serde(tag = "cmd", content = "args", rename_all = "snake_case")]`
//! matches the frontend's existing format. Field names that the TS adapter
//! sends in camelCase (`paneId`, `eventType`) are remapped explicitly with
//! `#[serde(rename = "...")]`.
//!
//! Adding a new command becomes a single-place change: add a variant here,
//! match it in `handle_command`. The compiler enforces the rest.

use serde::Deserialize;
use serde_json::Value;

/// All client → server commands the frontend actually sends. The wire JSON
/// looks like `{ "cmd": "...", "args": { ... } }`. Variants with no fields
/// require no `args` key; the TS adapter still sends an empty `args` object for
/// them, which [`ClientCommand::decode`] strips before deserializing (serde's
/// adjacently-tagged rules reject a `{}` map for a unit variant on their own).
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case")]
pub enum ClientCommand {
    GetInitialState {
        #[serde(default)]
        cols: Option<u32>,
        #[serde(default)]
        rows: Option<u32>,
    },
    SetClientSize {
        cols: u32,
        rows: u32,
    },
    RunTmuxCommand {
        command: String,
    },
    GetScrollbackCells {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default = "default_scrollback_start")]
        start: i64,
        #[serde(default = "default_scrollback_end")]
        end: i64,
    },
    GetThemeSettings,
    SetTheme {
        name: String,
        #[serde(default)]
        mode: Option<String>,
    },
    GetThemesList,
    SetThemeMode {
        mode: String,
    },
}

impl ClientCommand {
    /// Decode a `/commands` request body into a [`ClientCommand`].
    ///
    /// The TS adapter always sends `{ "cmd": ..., "args": ... }`, defaulting
    /// `args` to an empty object `{}` even for commands that take no
    /// arguments (`get_theme_settings`, `get_themes_list`, `ping`, …). serde's
    /// adjacently-tagged representation rejects an empty map where a unit
    /// variant is expected ("invalid type: map, expected unit variant"), which
    /// broke those commands on the wire.
    ///
    /// We honor the documented contract — unit variants accept an empty `args`
    /// object — by stripping an empty `args` map and retrying. Payloads that
    /// already parse (struct variants whose fields are all defaulted still
    /// accept `{}`) succeed on the first attempt and never reach the retry,
    /// so this only rescues the unit-variant case.
    pub fn decode(body: &[u8]) -> Result<Self, serde_json::Error> {
        match serde_json::from_slice(body) {
            Ok(cmd) => Ok(cmd),
            Err(first_err) => {
                let mut value: Value = serde_json::from_slice(body)?;
                let stripped = value
                    .as_object_mut()
                    .and_then(|obj| match obj.get("args") {
                        Some(Value::Object(map)) if map.is_empty() => obj.remove("args"),
                        _ => None,
                    })
                    .is_some();
                if stripped {
                    serde_json::from_value(value)
                } else {
                    Err(first_err)
                }
            }
        }
    }
}

fn default_scrollback_start() -> i64 {
    -200
}

fn default_scrollback_end() -> i64 {
    -1
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: serde_json::Value) -> ClientCommand {
        serde_json::from_value(v).expect("should parse")
    }

    #[test]
    fn unit_variant_accepts_empty_args_object() {
        // The TS adapter sends `args: {}` for no-arg commands. serde rejects
        // an empty map for a unit variant, so `decode` must strip it.
        for cmd_name in ["get_theme_settings", "get_themes_list"] {
            let body = serde_json::to_vec(&json!({ "cmd": cmd_name, "args": {} })).unwrap();
            ClientCommand::decode(&body)
                .unwrap_or_else(|e| panic!("'{cmd_name}' with empty args should decode: {e}"));
        }
    }

    #[test]
    fn struct_variant_still_decodes_with_empty_args() {
        // All-defaulted struct variants accept `{}` directly; `decode` must
        // not regress that path while rescuing unit variants.
        let body = serde_json::to_vec(&json!({ "cmd": "get_initial_state", "args": {} })).unwrap();
        match ClientCommand::decode(&body).expect("should decode") {
            ClientCommand::GetInitialState { cols, rows } => {
                assert_eq!(cols, None);
                assert_eq!(rows, None);
            }
            other => panic!("expected GetInitialState, got {other:?}"),
        }
    }

    #[test]
    fn struct_variant_decodes_with_populated_args() {
        let body =
            serde_json::to_vec(&json!({ "cmd": "set_theme", "args": { "name": "solarized" } }))
                .unwrap();
        match ClientCommand::decode(&body).expect("should decode") {
            ClientCommand::SetTheme { name, mode } => {
                assert_eq!(name, "solarized");
                assert_eq!(mode, None);
            }
            other => panic!("expected SetTheme, got {other:?}"),
        }
    }

    #[test]
    fn decode_rejects_genuinely_invalid_payload() {
        let body = serde_json::to_vec(&json!({ "cmd": "no_such_command" })).unwrap();
        assert!(ClientCommand::decode(&body).is_err());
    }

    #[test]
    fn camel_case_paneid_rename_round_trips() {
        let cmd = parse(json!({
            "cmd": "get_scrollback_cells",
            "args": { "paneId": "%3" }
        }));
        match cmd {
            ClientCommand::GetScrollbackCells { pane_id, .. } => assert_eq!(pane_id, "%3"),
            other => panic!("expected GetScrollbackCells, got {:?}", other),
        }
    }

    #[test]
    fn scrollback_defaults_match_legacy_handler() {
        let cmd = parse(json!({
            "cmd": "get_scrollback_cells",
            "args": { "paneId": "%0" }
        }));
        match cmd {
            ClientCommand::GetScrollbackCells { start, end, .. } => {
                assert_eq!(start, -200);
                assert_eq!(end, -1);
            }
            other => panic!("expected GetScrollbackCells, got {:?}", other),
        }
    }
}
