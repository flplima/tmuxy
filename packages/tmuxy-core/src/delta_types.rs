use serde::{Deserialize, Serialize};

use crate::{
    control_mode, layout, GroupId, PaneId, TerminalLine, TmuxPane, TmuxState, TmuxWindow, WindowId,
    WindowType,
};

/// A line-number-keyed map with STRING keys. serde_json does this implicitly,
/// but serde-wasm-bindgen's maps-as-objects mode refuses non-string keys
/// ("Map key is not a string"), which aborted every content-carrying delta on
/// the wasm path.
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

/// A pane's changed fields; an absent field did not change.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaneDelta {
    /// Set after a swap-pane across windows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<WindowId>,
    /// The lines that changed, by line index.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_line_map"
    )]
    pub content: Option<std::collections::HashMap<usize, TerminalLine>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_y: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_title: Option<String>,
    /// Outer `Option` = "changed?"; inner `Option` = the new value (`None`
    /// clears it: the pane left its group).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Option<GroupId>>,
    /// Nested like `group_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_pos: Option<Option<u32>>,
    /// Nested like `group_id`: the inner `None` is an agent unsetting
    /// `@tmuxy-pane-state` on exit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_state: Option<Option<String>>,
    /// Nested like `group_id`: the inner `None` is the `@tmuxy-ask` question
    /// answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_ask: Option<Option<String>>,
    /// Nested like `group_id`: the inner `None` is the widget exiting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_widget: Option<Option<String>>,
    /// Nested like `group_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_restore: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_cursor_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_cursor_y: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternate_on: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mouse_any_flag: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_present: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_start_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_start_y: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<control_mode::images::ImagePlacement>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_shape: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_hidden: Option<bool>,
}

impl PaneDelta {
    /// True when the delta carries no change at all; such a delta is dropped.
    ///
    /// Read off the serialized form (every field skips when `None`), so a
    /// field added to the struct is covered the moment it exists: a
    /// hand-written list once missed `pane_state`, and a pane that only
    /// declared a new state reached no client. A serialization that fails
    /// counts as NOT empty: a no-op delta costs a round trip, a dropped one
    /// loses the change for good.
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
    pub float_minimized: Option<bool>,
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
    /// Read off the serialized form, as [`PaneDelta::is_empty`] is.
    pub fn is_empty(&self) -> bool {
        match serde_json::to_value(self) {
            Ok(serde_json::Value::Object(fields)) => fields.is_empty(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TmuxDelta {
    pub seq: u64,
    /// Changed panes: pane_id -> delta (None = pane removed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panes: Option<std::collections::HashMap<PaneId, Option<PaneDelta>>>,
    /// Changed windows: window_id -> delta (None = window removed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows: Option<std::collections::HashMap<WindowId, Option<WindowDelta>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_panes: Option<Vec<TmuxPane>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_windows: Option<Vec<TmuxWindow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_window_id: Option<WindowId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<PaneId>,
    /// A shell helper queued (or cleared) a focus request. `Some("")` means it
    /// was cleared — the option is gone — so the field distinguishes "no change"
    /// (absent) from "no longer pending" (empty string).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus_request: Option<String>,
    /// The plugin inventory's revision changed; `Some("")` when the option
    /// is gone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugins_rev: Option<String>,
    /// The theme or its mode changed; `Some("")` when neither is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme_rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_height: Option<u32>,
}

impl TmuxDelta {
    /// True when the delta carries no change; `seq` alone is not one. Every
    /// field is named (no `..`), so a field added to the struct does not
    /// compile until it is counted here. Not read off the serialized form
    /// like [`PaneDelta::is_empty`]: that would serialize every pane's lines
    /// once more on each emit.
    pub fn is_empty(&self) -> bool {
        let Self {
            seq: _,
            panes,
            windows,
            new_panes,
            new_windows,
            active_window_id,
            active_pane_id,
            focus_request,
            plugins_rev,
            theme_rev,
            total_width,
            total_height,
        } = self;
        panes.is_none()
            && windows.is_none()
            && new_panes.is_none()
            && new_windows.is_none()
            && active_window_id.is_none()
            && active_pane_id.is_none()
            && focus_request.is_none()
            && plugins_rev.is_none()
            && theme_rev.is_none()
            && total_width.is_none()
            && total_height.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StateUpdate {
    /// Initial sync and reconnection.
    #[serde(rename = "full")]
    Full { state: TmuxState },
    #[serde(rename = "delta")]
    Delta { delta: TmuxDelta },
}
