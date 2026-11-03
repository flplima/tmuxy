use super::tmux::{parse_panes, parse_tabs, resolve_pane, PaneKind};
use super::tools::{
    find_on_screen, float_command, float_create_args, preview_path, screen_pattern, split_command,
    tab_command, trim_screen, FloatArgs, FloatPosition, SplitDirection, TabArgs,
};
use crate::request_guard::HostPolicy;
use crate::state::{api_routes, AppState};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tmuxy_core::PaneId;
use tower::ServiceExt;

fn app() -> Router {
    api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(Arc::new(AppState::new()))
}

/// A JSON-RPC message posted the way an MCP client posts it: no browser
/// headers, JSON in, either JSON or an event stream accepted back.
fn rpc(path: &str, message: Value) -> Request<Body> {
    Request::post(path)
        .header("host", "127.0.0.1:9000")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(Body::from(message.to_string()))
        .unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn the_handshake_agrees_on_a_revision_and_hands_out_a_session() {
    for (asked, agreed) in [
        ("2025-03-26", "2025-03-26"),
        ("2024-11-05", "2024-11-05"),
        ("1999-01-01", "2025-06-18"),
    ] {
        let response = app()
            .oneshot(rpc(
                "/mcp",
                json!({
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {
                        "protocolVersion": asked,
                        "capabilities": {},
                        "clientInfo": { "name": "claude-code", "version": "2" },
                    },
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("mcp-session-id").is_some());
        let body = json_body(response).await;
        assert_eq!(body["id"], 1);
        assert_eq!(body["result"]["protocolVersion"], agreed, "{asked}");
        assert_eq!(body["result"]["serverInfo"]["name"], "tmuxy");
        assert!(body["result"]["capabilities"]["tools"].is_object());
    }
}

/// The name a client gave at the handshake is the one its later requests are
/// asked under; an unknown session id is only named generically.
#[test]
fn a_client_is_known_by_its_session_id() {
    let clients = super::Clients::default();
    let id = clients.register("claude-code".into());
    assert_eq!(clients.name(&id).as_deref(), Some("claude-code"));
    assert_eq!(clients.name("not-a-session"), None);
    assert_ne!(clients.register("x".into()), id);
}

#[tokio::test]
async fn notifications_are_acknowledged_and_batches_refused() {
    let response = app()
        .oneshot(rpc(
            "/mcp",
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);

    let response = app()
        .oneshot(rpc(
            "/mcp",
            json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }]),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["error"]["code"], -32600);

    let response = app()
        .oneshot(rpc(
            "/mcp",
            json!({ "jsonrpc": "2.0", "id": 7, "method": "resources/list" }),
        ))
        .await
        .unwrap();
    let body = json_body(response).await;
    assert_eq!(body["id"], 7);
    assert_eq!(body["error"]["code"], -32601);
}

async fn listed_tools(path: &str) -> Vec<String> {
    let response = app()
        .oneshot(rpc(
            path,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        ))
        .await
        .unwrap();
    let body = json_body(response).await;
    body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| {
            assert!(tool["inputSchema"]["type"] == "object", "{tool}");
            tool["name"].as_str().unwrap().to_string()
        })
        .collect()
}

/// `?read-only` gives an agent eyes without hands: the tools that change the
/// session are neither listed nor callable.
#[tokio::test]
async fn a_read_only_endpoint_offers_only_the_tools_that_change_nothing() {
    let all = listed_tools("/mcp").await;
    for tool in [
        "status",
        "pane_capture",
        "pane_send_keys",
        "pane_kill",
        "open_preview",
    ] {
        assert!(
            all.contains(&tool.to_string()),
            "{tool} missing from {all:?}"
        );
    }
    let read_only = listed_tools("/mcp?read-only").await;
    assert_eq!(
        read_only,
        [
            "status",
            "pane_list",
            "tab_list",
            "pane_capture",
            "pane_wait_for"
        ]
    );
    assert_eq!(listed_tools("/mcp?read-only=0").await, all);

    let response = app()
        .oneshot(rpc(
            "/mcp?read-only",
            json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "pane_kill", "arguments": { "pane": "%1" } },
            }),
        ))
        .await
        .unwrap();
    let body = json_body(response).await;
    assert_eq!(body["error"]["code"], -32602, "{body}");
}

#[tokio::test]
async fn a_bad_session_name_is_refused_before_anything_runs() {
    let response = app()
        .oneshot(rpc(
            "/mcp?session=a%0Akill-server",
            json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

// ============================================
// Panes and tabs as tmux lists them
// ============================================

#[test]
fn panes_are_read_with_their_free_text_intact() {
    let listing = "%1\t@1\t80\t24\t1\t\tzsh\t\tbuild\n\
                   %2\t@1\t80\t24\t0\t\tnpm\tlogs\twith\ta tab\n\
                   %9\t@4\t60\t15\t0\tfloat\tbash\t\t\n\
                   %3\t@5\t30\t50\t0\tsidebar-left\ttree\t\t\n\
                   garbage line\n";
    let panes = parse_panes(listing);
    assert_eq!(panes.len(), 4);
    assert!(panes[0].active);
    assert_eq!(panes[0].title, "build");
    assert_eq!(panes[1].label, "logs");
    assert_eq!(panes[1].title, "with\ta tab");
    assert_eq!(panes[2].kind, PaneKind::Float);
    assert_eq!(panes[3].kind, PaneKind::Sidebar);
}

#[test]
fn tabs_leave_out_floats_and_sidebars() {
    let listing = "@1\t0\t1\t2\t\tmain\n@4\t1\t0\t1\tfloat\tfloat\n@5\t2\t0\t1\tsidebar-left\ttree\n@6\t3\t0\t1\t\tname\twith tab\n";
    let tabs = parse_tabs(listing);
    let ids: Vec<&str> = tabs.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["@1", "@6"]);
    assert!(tabs[0].active);
    assert_eq!(tabs[1].name, "name\twith tab");
}

#[test]
fn a_target_is_an_id_a_label_or_a_title_and_never_a_guess() {
    let panes = parse_panes(
        "%1\t@1\t80\t24\t0\t\tzsh\t\tbuild\n\
         %2\t@1\t80\t24\t1\t\tnpm\tlogs\tbuild\n\
         %3\t@2\t80\t24\t0\t\tnpm\tdup\t\n\
         %4\t@2\t80\t24\t0\t\tnpm\tdup\t\n",
    );
    let id = |t: Option<&str>| resolve_pane(panes.clone(), t).map(|p| p.id.to_string());
    assert_eq!(id(None).unwrap(), "%2", "no target is the focused pane");
    assert_eq!(id(Some("%3")).unwrap(), "%3");
    assert_eq!(id(Some("logs")).unwrap(), "%2", "a label wins over a title");
    assert!(id(Some("%7")).is_err(), "a pane of another session");
    assert!(id(Some("dup")).unwrap_err().error.contains("2 panes"));
    assert!(id(Some("nothing")).is_err());
    // Two panes titled `build`, one of them labelled otherwise: the title
    // alone names two, which is ambiguous.
    assert!(id(Some("build")).is_err());
}

// ============================================
// The command lines the tools send
// ============================================

#[test]
fn a_split_or_a_tab_leaves_the_users_focus_where_it_is() {
    let pane = PaneId::parse("%4").unwrap();
    let split = split_command(&pane, SplitDirection::Down, Some("htop; rm -rf x"));
    assert!(split.starts_with("splitw -v -d -t %4 "), "{split}");
    assert!(split.ends_with(" 'htop; rm -rf x'"), "{split}");

    let tab = tab_command(
        "work",
        &pane,
        &TabArgs {
            name: Some("it's".into()),
            command: None,
        },
    );
    assert!(
        tab.contains("breakp -d -t '=work:' -n 'it'\\''s' -P"),
        "{tab}"
    );
    assert!(tab.ends_with("select-pane -t %4"), "{tab}");
    // `new-window` crashes tmux 3.5a with control mode attached.
    assert!(!tab.contains("new-window") && !tab.contains("neww"));
}

/// run-shell expands formats before its shell sees the line: a `#` in the
/// command reaches the float as typed, and a quote cannot end the argument.
#[test]
fn a_float_command_reaches_its_shell_as_written() {
    let pane = PaneId::parse("%2").unwrap();
    let args = float_create_args(
        &FloatArgs {
            position: FloatPosition::Right,
            width: Some(70),
            ..FloatArgs::default()
        },
        &[
            "bash".into(),
            "-c".into(),
            "echo '#{pane_id}' # it's".into(),
        ],
    );
    assert_eq!(
        args,
        [
            "--detach",
            "--right",
            "--width",
            "70",
            "--",
            "bash",
            "-c",
            "echo '#{pane_id}' # it's",
        ]
    );
    let line = float_command("/data/bin/tmuxy/float-create", &pane, &args);
    assert!(line.starts_with("run-shell 'TMUX_PANE=%2 bash "), "{line}");
    assert!(line.contains("##{pane_id}"), "{line}");
    assert!(!line.contains("'#{pane_id}'"), "{line}");
}

#[test]
fn only_an_absolute_markdown_or_html_file_is_previewed() {
    let dir = std::env::temp_dir().join(format!("tmuxy-mcp-preview-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let page = dir.join("notes.md");
    std::fs::write(&page, "# hi").unwrap();
    let script = dir.join("run.sh");
    std::fs::write(&script, "true").unwrap();

    assert!(preview_path(page.to_str().unwrap()).is_ok());
    assert!(preview_path("notes.md").is_err(), "relative");
    assert!(
        preview_path(script.to_str().unwrap()).is_err(),
        "not a page"
    );
    assert!(preview_path(dir.join("gone.md").to_str().unwrap()).is_err());
    #[cfg(unix)]
    {
        let link = dir.join("link.md");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&page, &link).unwrap();
        assert!(preview_path(link.to_str().unwrap()).is_err(), "symlink");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A screen is lines: `^done$` finds the line that says `done`, wherever it
/// is, and the answer names the line the match is on.
#[test]
fn a_wait_pattern_is_anchored_at_each_line() {
    let screen = "$ echo 'done'\ndone\n$ make\nerror: 3 failed";
    let anchored = screen_pattern("^done$").unwrap();
    assert_eq!(find_on_screen(&anchored, screen), Some(("done", "done")));
    let inner = screen_pattern(r"\d+ failed").unwrap();
    assert_eq!(
        find_on_screen(&inner, screen),
        Some(("3 failed", "error: 3 failed"))
    );
    assert_eq!(
        find_on_screen(&screen_pattern("^nope").unwrap(), screen),
        None
    );
    assert!(screen_pattern("(unclosed").is_err());
}

#[test]
fn a_screen_loses_its_trailing_blanks_only() {
    assert_eq!(trim_screen("  a  \n\nb \n\n   \n"), "  a\n\nb");
    assert_eq!(trim_screen("\n\n"), "");
}
