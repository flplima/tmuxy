use serde_json::{json, Map, Value};

use super::redact_for_sharing;

fn events(lines: Value) -> Vec<Map<String, Value>> {
    lines
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_object().unwrap().clone())
        .collect()
}

/// A synthetic trace taken at `full`: everything a user would not want to
/// share, in the fields a real one carries it in.
fn synthetic() -> Vec<Map<String, Value>> {
    events(json!([
        {"ts_wall": 1700000000123u64, "layer": "server", "name": "connect", "phase": "event",
         "session": "acme-payroll", "conn_id": "c7", "component": "tmuxy_server::sse"},
        {"ts_wall": 1700000000200u64, "layer": "tmux", "name": "command", "op": "Split",
         "action_id": "a-12", "pane": "%3", "window": "@1", "session": "acme-payroll",
         "command": "run-shell 'ssh prod-db.internal cat /home/alice/.env'",
         "args": "TOKEN=hunter2", "path": "/home/alice/src/payroll", "dur_us": 1830},
        {"ts_wall": 1700000000300u64, "layer": "tmux", "name": "error", "code": "no_such_pane",
         "error": "can't find pane: %9 in alice@prod-db.internal", "seq": 41,
         "session": "other-session"},
        {"layer": "marker", "name": "marker", "label": "float stuck after alice pressed Esc"},
        {"layer": "client", "name": "op", "op": "send keys; rm -rf /", "pane": "not an id/../x",
         "nested": {"cwd": "/srv/secret", "list": ["prod-db.internal", 3]}}
    ]))
}

#[test]
fn nothing_about_the_user_survives() {
    let shared = serde_json::to_string(&redact_for_sharing(&synthetic())).unwrap();
    for held in [
        "acme", "payroll", "alice", "prod-db", "internal", "hunter2", "TOKEN", ".env", "/home",
        "/srv", "secret", "rm -rf", "Esc", "%9",
    ] {
        assert!(!shared.contains(held), "{held:?} survived: {shared}");
    }
}

#[test]
fn the_shape_of_what_happened_survives() {
    let shared = redact_for_sharing(&synthetic());
    let line = &shared[1];
    assert_eq!(line["layer"], "tmux");
    assert_eq!(line["op"], "Split");
    assert_eq!(line["pane"], "%3");
    assert_eq!(line["window"], "@1");
    assert_eq!(line["action_id"], "a-12");
    assert_eq!(line["dur_us"], 1830);
    assert_eq!(line["ts_wall"], 1700000000200u64);
    // A command keeps its tmux verb, not its arguments.
    assert_eq!(line["command"], "run-shell …");
    assert_eq!(shared[2]["code"], "no_such_pane");
    assert_eq!(shared[2]["seq"], 41);
    assert_eq!(shared[0]["component"], "tmuxy_server::sse");
}

#[test]
fn one_value_reads_the_same_placeholder_everywhere() {
    let shared = redact_for_sharing(&synthetic());
    assert_eq!(shared[0]["session"], "session-1");
    assert_eq!(shared[1]["session"], "session-1", "the same session");
    assert_eq!(shared[2]["session"], "session-2", "another one");
    assert_eq!(shared[1]["path"], "path-1");
    assert_eq!(shared[2]["error"], "text-1");
    assert_eq!(shared[3]["label"], "label-1");
    // An op or id that does not look like one is replaced too.
    assert_eq!(shared[4]["op"], "op-1");
    assert_eq!(shared[4]["pane"], "pane-1");
    assert_eq!(shared[4]["nested"]["cwd"], "cwd-1");
    assert_eq!(shared[4]["nested"]["list"], json!(["list-1", 3]));
}

#[test]
fn a_key_that_is_not_a_field_name_is_replaced_too() {
    let shared = redact_for_sharing(&events(json!([
        {"layer": "client", "counts": {"acme-payroll": 3, "lines": 2}}
    ])));
    let text = serde_json::to_string(&shared).unwrap();
    assert!(!text.contains("acme"), "{text}");
    assert_eq!(shared[0]["counts"]["key-1"], 3);
    assert_eq!(shared[0]["counts"]["lines"], 2);
}
