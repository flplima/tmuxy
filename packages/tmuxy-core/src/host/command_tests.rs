use super::*;
use serde_json::json;

fn parse(v: serde_json::Value) -> ClientCommand {
    serde_json::from_value(v).expect("should parse")
}

#[test]
fn unit_variant_accepts_empty_args_object() {
    // The TS adapter sends `args: {}` for no-arg commands. serde rejects
    // an empty map for a unit variant, so `decode` must strip it.
    for cmd_name in [
        "get_theme_settings",
        "get_themes_list",
        "list_git_worktrees",
        "greeting",
    ] {
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
    let body = serde_json::to_vec(&json!({ "cmd": "set_theme", "args": { "name": "solarized" } }))
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
fn scrollback_defaults_to_the_last_two_hundred_rows() {
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

#[test]
fn only_web_links_are_openable() {
    assert!(is_openable_url("https://example.com/a?b=c"));
    assert!(is_openable_url("HTTP://EXAMPLE.COM"));
    assert!(is_openable_url("mailto:someone@example.com"));
    assert!(!is_openable_url("file:///etc/passwd"));
    assert!(!is_openable_url("javascript:alert(1)"));
    assert!(!is_openable_url("ssh://host"));
    assert!(!is_openable_url("https://example.com/\u{1b}[31m"));
    assert!(!is_openable_url(""));
    // What `cmd.exe` would read as its own syntax, were one in the way.
    assert!(is_openable_url("https://example.com/?a=1&b=2"));
    assert!(!is_openable_url("https://example.com/\"&calc.exe"));
    assert!(!is_openable_url("https://example.com/ x"));
    assert!(!is_openable_url("https://example.com/^|x"));
}
