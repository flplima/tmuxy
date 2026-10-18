use serde::{Deserialize, Serialize};

use crate::{
    control_mode, layout, GroupId, PaneId, TerminalLine, TmuxPane, TmuxState, TmuxWindow, WindowId,
    WindowType,
};

/// Serialize a line-number-keyed map with STRING keys. serde_json does this
/// implicitly (JSON object keys are strings — the wire shape the frontend
/// already speaks), but serde-wasm-bindgen's maps-as-objects mode REFUSES
/// non-string keys ("Map key is not a string"), which aborted serialization of
/// every content-carrying delta on the wasm path.
fn ser_line_map<S: serde::Serializer>(
    v: &Option<std::collections::HashMap<usize, TerminalLine>>,
    s: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    match v {
        None => s.serialize_none(),
        Some(m) => {
            let mut map = s.serialize_map(Some(m.len()))?;
            for (k, val) in m {
                map.serialize_entry(&k.to_string(), val)?;
            }
            map.end()
        }
    }
}

/// Delta update for a single pane (only changed fields)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaneDelta {
    /// Window ID (only if changed, e.g. after swap-pane across windows)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<WindowId>,
    /// Content (only changed lines) - line index → line content
    /// Only lines that differ from the previous state are included.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_line_map"
    )]
    pub content: Option<std::collections::HashMap<usize, TerminalLine>>,
    /// Cursor position (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_y: Option<u32>,
    /// Dimensions (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Position (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<u32>,
    /// Active state (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    /// Command (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Title (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Border title (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_title: Option<String>,
    /// Pane-group id (only if changed). Outer `Option` = "changed?"; inner
    /// `Option` = the new value (`None` clears it — the pane left its group).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Option<GroupId>>,
    /// Place in the group (only if changed); nested like `group_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_pos: Option<Option<u32>>,
    /// Pane state from `@tmuxy-pane-state` (only if changed). Nested the same
    /// way as `group_id`: the inner `None` clears it, which is what an agent
    /// unsetting the option on exit looks like.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_state: Option<Option<String>>,
    /// Pending confirmation from `@tmuxy-ask` (only if changed). Nested the
    /// same way as `pane_state`: the inner `None` clears it, which is what
    /// answering the question looks like.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_ask: Option<Option<String>>,
    /// Widget authorisation from `@tmuxy-pane-widget` (only if changed).
    /// Nested like `pane_state`: the inner `None` clears it, which is what
    /// the widget exiting looks like.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_widget: Option<Option<String>>,
    /// `@tmuxy-pane-restore` (only if changed); nested like `pane_widget`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_restore: Option<Option<String>>,
    /// `@tmuxy-pane-url` (only if changed); nested like `pane_widget`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_url: Option<Option<String>>,
    /// Copy mode state (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_cursor_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_cursor_y: Option<u32>,
    /// Alternate screen mode (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternate_on: Option<bool>,
    /// Mouse any flag (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mouse_any_flag: Option<bool>,
    /// Marked pane flag (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marked: Option<bool>,
    /// Flow control pause state (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    /// History size (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_size: Option<u64>,
    /// Selection present (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_present: Option<bool>,
    /// Selection start X (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_start_x: Option<u32>,
    /// Selection start Y (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_start_y: Option<i32>,
    /// Image placements (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<control_mode::images::ImagePlacement>>,
    /// Cursor shape (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_shape: Option<u8>,
    /// Cursor hidden (only if changed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_hidden: Option<bool>,
}

impl PaneDelta {
    /// True when the delta carries no change at all — such a delta is dropped
    /// rather than emitted.
    ///
    /// Read off the SERIALIZED form rather than a hand-written list of fields.
    /// Every field is `skip_serializing_if = "Option::is_none"`, so an empty
    /// object means nothing changed, and a field added to the struct is
    /// covered the moment it exists. The list this replaces had silently
    /// fallen behind: `pane_state` was missing from it, so a pane that only
    /// declared a new state produced a delta judged empty and thrown away —
    /// the change reached no client until something else about the pane
    /// happened to change too. `@tmuxy-ask` would have inherited the same
    /// fate, which is a question that never appears.
    ///
    /// `content` is tested first because it is the one large field and a
    /// content change is the common case, so the usual call never serializes
    /// anything. A serialization that fails is reported as NOT empty: emitting
    /// a delta that turns out to be a no-op costs a round trip, while dropping
    /// a real one loses the change for good.
    pub fn is_empty(&self) -> bool {
        if self.content.is_some() {
            return false;
        }
        match serde_json::to_value(self) {
            Ok(serde_json::Value::Object(fields)) => fields.is_empty(),
            _ => false,
        }
    }
}

/// Delta update for a single window (only changed fields)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowDelta {
    /// The window's index moved: `move-window` / `swap-window` renumber the
    /// windows behind the moved one too, and the strip is ordered by index.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_type: Option<Option<WindowType>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_parent: Option<Option<WindowId>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_width: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_height: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_drawer: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_bg: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_noheader: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_cols: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collapsible: Option<bool>,
    /// True while this window has a zoomed pane. tmux hides the other panes
    /// entirely when zoomed, so the frontend needs this to do the same.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoomed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<Option<PaneId>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_tree: Option<Option<layout::PaneTree>>,
}

impl WindowDelta {
    /// True when the delta carries no change at all. Read off the serialized
    /// form for the same reason `PaneDelta::is_empty` is: every field is
    /// `skip_serializing_if = "Option::is_none"`, so a field added to the
    /// struct is covered the moment it exists, where a hand-written list
    /// silently drops the change it forgot.
    pub fn is_empty(&self) -> bool {
        match serde_json::to_value(self) {
            Ok(serde_json::Value::Object(fields)) => fields.is_empty(),
            _ => false,
        }
    }
}

/// Delta state update - only includes what changed
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TmuxDelta {
    /// Sequence number for ordering
    pub seq: u64,
    /// Changed panes: pane_id -> delta (None = pane removed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panes: Option<std::collections::HashMap<PaneId, Option<PaneDelta>>>,
    /// Changed windows: window_id -> delta (None = window removed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows: Option<std::collections::HashMap<WindowId, Option<WindowDelta>>>,
    /// New panes (full data for newly added panes)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_panes: Option<Vec<TmuxPane>>,
    /// New windows (full data for newly added windows)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_windows: Option<Vec<TmuxWindow>>,
    /// Active window changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_window_id: Option<WindowId>,
    /// Active pane changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<PaneId>,
    /// A shell helper queued (or cleared) a focus request. `Some("")` means it
    /// was cleared — the option is gone — so the field distinguishes "no change"
    /// (absent) from "no longer pending" (empty string).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus_request: Option<String>,
    /// Total dimensions changed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_height: Option<u32>,
}

impl TmuxDelta {
    pub fn is_empty(&self) -> bool {
        self.panes.is_none()
            && self.windows.is_none()
            && self.new_panes.is_none()
            && self.new_windows.is_none()
            && self.active_window_id.is_none()
            && self.active_pane_id.is_none()
            && self.focus_request.is_none()
            && self.total_width.is_none()
            && self.total_height.is_none()
    }
}

/// Message type for state updates (full or delta)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StateUpdate {
    /// Full state (used for initial sync and reconnection)
    #[serde(rename = "full")]
    Full { state: TmuxState },
    /// Delta update (used for incremental updates)
    #[serde(rename = "delta")]
    Delta { delta: TmuxDelta },
}
