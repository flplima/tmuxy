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

/// Discriminator for [`ClientCommand::SelectPane`] — replaces the bare
/// `"up"|"down"|"left"|"right"` strings the old handler matched on.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

impl Direction {
    /// Tmux's `selectp -<flag>` short form for this direction.
    pub fn flag(self) -> &'static str {
        match self {
            Direction::Up => "-U",
            Direction::Down => "-D",
            Direction::Left => "-L",
            Direction::Right => "-R",
        }
    }
}

/// `resize-pane -<flag>` requires the same U/D/L/R alphabet but the
/// frontend currently sends the raw "U"/"D"/"L"/"R" capital letters.
/// Kept separate from [`Direction`] so we don't overload its lowercase
/// serialization with single-letter aliases.
#[derive(Debug, Clone, Copy, Deserialize)]
pub enum ResizeDirection {
    U,
    D,
    L,
    R,
}

impl ResizeDirection {
    pub fn flag(self) -> &'static str {
        match self {
            ResizeDirection::U => "-U",
            ResizeDirection::D => "-D",
            ResizeDirection::L => "-L",
            ResizeDirection::R => "-R",
        }
    }
}

/// Scroll direction is its own type so we can keep `Direction` pane-only.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
}

impl ScrollDirection {
    pub fn tmux_cmd(self) -> &'static str {
        match self {
            ScrollDirection::Up => "scroll-up",
            ScrollDirection::Down => "scroll-down",
        }
    }
}

/// All client → server commands. The wire JSON looks like
/// `{ "cmd": "...", "args": { ... } }`. Variants with no fields require no
/// `args` key (or accept an empty object); serde's default rules handle that.
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case")]
pub enum ClientCommand {
    SendKeysToTmux {
        #[serde(default)]
        keys: String,
    },
    ProcessKey {
        #[serde(default)]
        key: String,
    },
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
    InitializeSession,
    GetScrollbackHistory,
    GetBuffer,
    SplitPaneHorizontal,
    SplitPaneVertical,
    NewWindow,
    SelectPane {
        direction: Direction,
    },
    SelectWindow {
        window: String,
    },
    NextWindow,
    PreviousWindow,
    KillPane,
    SelectPaneById {
        #[serde(rename = "paneId")]
        pane_id: String,
    },
    ScrollPane {
        #[serde(rename = "paneId")]
        pane_id: String,
        direction: ScrollDirection,
        #[serde(default = "default_scroll_amount")]
        amount: u32,
    },
    SendMouseEvent {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(rename = "eventType")]
        event_type: String,
        button: u32,
        x: u32,
        y: u32,
    },
    ExecutePrefixBinding {
        key: String,
    },
    KillWindow,
    RefreshKeybindings,
    RunTmuxCommand {
        command: String,
    },
    ResizePane {
        #[serde(rename = "paneId")]
        pane_id: String,
        direction: ResizeDirection,
        #[serde(default = "default_resize_adjustment")]
        adjustment: u32,
    },
    ResizeWindow {
        #[serde(default = "default_resize_cols")]
        cols: u32,
        #[serde(default = "default_resize_rows")]
        rows: u32,
    },
    GetKeyBindings,
    GetScrollbackCells {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(default = "default_scrollback_start")]
        start: i64,
        #[serde(default = "default_scrollback_end")]
        end: i64,
    },
    ListDirectory {
        #[serde(default = "default_directory_path")]
        path: String,
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
    Ping,
}

fn default_scroll_amount() -> u32 {
    1
}

fn default_resize_adjustment() -> u32 {
    1
}

fn default_resize_cols() -> u32 {
    80
}

fn default_resize_rows() -> u32 {
    24
}

fn default_scrollback_start() -> i64 {
    -200
}

fn default_scrollback_end() -> i64 {
    -1
}

fn default_directory_path() -> String {
    ".".to_string()
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
    fn unit_variant_accepts_missing_args() {
        let cmd = parse(json!({ "cmd": "ping" }));
        assert!(matches!(cmd, ClientCommand::Ping));
    }

    #[test]
    fn camel_case_paneid_rename_round_trips() {
        let cmd = parse(json!({
            "cmd": "select_pane_by_id",
            "args": { "paneId": "%3" }
        }));
        match cmd {
            ClientCommand::SelectPaneById { pane_id } => assert_eq!(pane_id, "%3"),
            other => panic!("expected SelectPaneById, got {:?}", other),
        }
    }

    #[test]
    fn directions_deserialize_lowercase() {
        let cmd = parse(json!({
            "cmd": "select_pane",
            "args": { "direction": "right" }
        }));
        match cmd {
            ClientCommand::SelectPane { direction } => assert_eq!(direction.flag(), "-R"),
            other => panic!("expected SelectPane, got {:?}", other),
        }
    }

    #[test]
    fn resize_direction_uppercase_letters() {
        let cmd = parse(json!({
            "cmd": "resize_pane",
            "args": { "paneId": "%0", "direction": "L", "adjustment": 4 }
        }));
        match cmd {
            ClientCommand::ResizePane {
                pane_id,
                direction,
                adjustment,
            } => {
                assert_eq!(pane_id, "%0");
                assert_eq!(direction.flag(), "-L");
                assert_eq!(adjustment, 4);
            }
            other => panic!("expected ResizePane, got {:?}", other),
        }
    }

    #[test]
    fn defaults_fill_missing_optional_fields() {
        let cmd = parse(json!({
            "cmd": "scroll_pane",
            "args": { "paneId": "%1", "direction": "up" }
        }));
        match cmd {
            ClientCommand::ScrollPane { amount, .. } => assert_eq!(amount, 1),
            other => panic!("expected ScrollPane, got {:?}", other),
        }
    }

    #[test]
    fn mouse_event_camel_case_eventtype() {
        let cmd = parse(json!({
            "cmd": "send_mouse_event",
            "args": {
                "paneId": "%2",
                "eventType": "press",
                "button": 0,
                "x": 1,
                "y": 2,
            }
        }));
        match cmd {
            ClientCommand::SendMouseEvent {
                pane_id,
                event_type,
                button,
                x,
                y,
            } => {
                assert_eq!(pane_id, "%2");
                assert_eq!(event_type, "press");
                assert_eq!(button, 0);
                assert_eq!(x, 1);
                assert_eq!(y, 2);
            }
            other => panic!("expected SendMouseEvent, got {:?}", other),
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
