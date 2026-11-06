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

/// A host that does none of the host-only things, over a session with no
/// monitor: the web server's position for most of them.
struct Bare(std::sync::Arc<SessionRuntime>);

impl HostCtx for Bare {
    fn runtime(&self) -> &SessionRuntime {
        &self.0
    }

    fn client(&self) -> Option<ClientId> {
        None
    }
}

struct Nowhere;

impl super::super::Sink for Nowhere {
    fn emit(&self, _event: HostEvent) {}
}

fn bare() -> Bare {
    let runtime = SessionRuntime::new(
        super::super::RuntimeConfig {
            session: "s".to_string(),
            preview: std::sync::Arc::default(),
            preview_scope: "s".to_string(),
            restore: false,
        },
        std::sync::Arc::new(Nowhere),
    );
    runtime.set_down();
    Bare(runtime)
}

async fn answer(cmd: serde_json::Value) -> Result<Value, CommandError> {
    handle(ClientCommand::from_value(cmd).unwrap(), &bare()).await
}

/// What a host cannot do is refused as `unavailable`, so the client can tell
/// "not here" from "it failed"; a command that needs no monitor is answered
/// without one, and one that does is refused at once when none is coming.
#[tokio::test]
async fn a_host_answers_what_it_cannot_do_as_unavailable() {
    for cmd in ["detach_client", "list_servers", "open_trace_file"] {
        let err = answer(json!({ "cmd": cmd, "args": {} })).await.unwrap_err();
        assert_eq!(err.kind, crate::ErrorKind::Unavailable, "{cmd}: {err}");
    }
    let err = answer(json!({ "cmd": "connect_server", "args": { "id": "localhost" } }))
        .await
        .unwrap_err();
    assert_eq!(err.kind, crate::ErrorKind::Unavailable);

    assert!(answer(json!({ "cmd": "get_themes_list", "args": {} }))
        .await
        .unwrap()
        .is_array());
    let err = answer(json!({ "cmd": "query_tmux", "args": { "command": "list-panes" } }))
        .await
        .unwrap_err();
    assert_eq!(err.kind, crate::ErrorKind::Unavailable);
}

/// A desktop command rejects with `{ error, kind }`, the shape the web
/// server's `/commands` failures have; a link a pane printed is opened only
/// when it is a web or mail link.
#[tokio::test]
async fn a_refused_link_rejects_with_kind_forbidden() {
    let err = answer(json!({ "cmd": "open_url", "args": { "url": "file:///etc/passwd" } }))
        .await
        .unwrap_err();
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["kind"], "forbidden");
    assert!(json["error"]
        .as_str()
        .is_some_and(|e| e.starts_with("refusing to open")));
}
