use serde_json::{json, Value};

use super::open::SEND_MAX;
use super::read::{MAX_SCROLLBACK, WAIT_MAX};

pub(super) fn no_arguments() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn pane_property(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

const PANE_TARGET: &str = "A pane id (%3), or a pane's label or title. Default: the pane the \
                           user has focused.";

pub(super) fn pane_list_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tab": { "type": "string", "description": "Only this tab's panes (its id, @2)." },
        },
    })
}

pub(super) fn pane_capture_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pane": pane_property(PANE_TARGET),
            "scrollback": {
                "type": "integer", "minimum": 0, "maximum": MAX_SCROLLBACK,
                "description": "Lines of history above the screen to include.",
            },
        },
    })
}

pub(super) fn pane_wait_for_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pane": pane_property(PANE_TARGET),
            "pattern": { "type": "string", "description": "A regular expression." },
            "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": WAIT_MAX.as_secs() },
            "scrollback": { "type": "integer", "minimum": 0, "maximum": MAX_SCROLLBACK },
        },
        "required": ["pattern"],
    })
}

pub(super) fn pane_split_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pane": pane_property(PANE_TARGET),
            "direction": { "type": "string", "enum": ["right", "down"], "default": "right" },
            "command": { "type": "string", "description": "A shell command to run in the new pane." },
        },
    })
}

pub(super) fn pane_send_keys_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pane": pane_property("A pane id (%3), or a pane's label or title."),
            "keys": {
                "type": "array", "items": { "type": "string" }, "minItems": 1,
                "description": "Literal text and key names, e.g. [\"npm test\", \"Enter\"].",
            },
            "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": SEND_MAX.as_secs() },
        },
        "required": ["pane", "keys"],
    })
}

fn float_properties() -> serde_json::Map<String, Value> {
    let Value::Object(map) = json!({
        "position": {
            "type": "string", "enum": ["center", "left", "right", "top", "bottom"],
            "default": "center", "description": "Centred, or a drawer docked to an edge.",
        },
        "width": { "type": "integer", "minimum": 1, "description": "Columns." },
        "height": { "type": "integer", "minimum": 1, "description": "Rows." },
    }) else {
        return serde_json::Map::new();
    };
    map
}

pub(super) fn pane_float_schema() -> Value {
    let mut properties = float_properties();
    properties.insert(
        "command".into(),
        json!({ "type": "string", "description": "A shell command to run in the float." }),
    );
    properties.insert(
        "background".into(),
        json!({ "type": "string", "enum": ["dim", "blur", "none"] }),
    );
    json!({ "type": "object", "properties": properties })
}

pub(super) fn tab_create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string" },
            "command": { "type": "string", "description": "A shell command to run in the tab." },
        },
    })
}

pub(super) fn open_preview_schema() -> Value {
    let mut properties = float_properties();
    properties.insert(
        "path".into(),
        json!({ "type": "string", "description": "Absolute path of a .md or .html file." }),
    );
    json!({ "type": "object", "properties": properties, "required": ["path"] })
}

pub(super) fn pane_kill_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "pane": pane_property("A pane id (%3), or a pane's label or title.") },
        "required": ["pane"],
    })
}
