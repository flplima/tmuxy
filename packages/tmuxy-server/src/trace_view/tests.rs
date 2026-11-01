use super::*;

fn ev(json: Value) -> Map<String, Value> {
    match json {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

fn lifecycle(name: &str, pane: &str, ts: u64, extra: Value) -> Map<String, Value> {
    let mut m = ev(serde_json::json!({
        "layer": "monitor", "name": name, "phase": "event",
        "session": "s", "pane": pane, "ts_wall": ts
    }));
    if let Value::Object(x) = extra {
        m.extend(x);
    }
    m
}

/// A shell pane that never shows a byte is found, with the test it
/// appeared in; one that spoke — live, replayed, or only through a
/// capture — is not, nor is a non-shell, nor one that was not alive long.
#[test]
fn a_shell_pane_that_never_spoke_is_reported_with_its_test() {
    let mark = ev(serde_json::json!({
        "layer": "marker", "name": "mark", "label": "suite › first test start", "ts_wall": 0
    }));
    let events = vec![
        mark,
        lifecycle(
            "pane appeared",
            "%1",
            1_000,
            serde_json::json!({"shell": true, "bytes": 0, "cols": 80, "rows": 24}),
        ),
        lifecycle(
            "pane captured",
            "%1",
            1_100,
            serde_json::json!({"lines": 0}),
        ),
        lifecycle(
            "pane appeared",
            "%2",
            1_000,
            serde_json::json!({"shell": true, "bytes": 0}),
        ),
        lifecycle(
            "pane captured",
            "%2",
            1_100,
            serde_json::json!({"lines": 2}),
        ),
        lifecycle(
            "pane appeared",
            "%3",
            1_000,
            serde_json::json!({"shell": true, "bytes": 90}),
        ),
        lifecycle(
            "pane appeared",
            "%4",
            1_000,
            serde_json::json!({"shell": false, "bytes": 0}),
        ),
        lifecycle(
            "pane appeared",
            "%5",
            1_000,
            serde_json::json!({"shell": true, "bytes": 0}),
        ),
        lifecycle(
            "pane first output",
            "%5",
            1_200,
            serde_json::json!({"bytes": 40}),
        ),
        lifecycle(
            "pane appeared",
            "%6",
            40_000,
            serde_json::json!({"shell": true, "bytes": 0}),
        ),
        lifecycle("pane gone", "%6", 41_000, serde_json::json!({})),
        lifecycle(
            "pane resized",
            "%1",
            2_000,
            serde_json::json!({"cols": 139, "rows": 27}),
        ),
        lifecycle("pane gone", "%1", 46_000, serde_json::json!({})),
    ];
    let silent = silent_panes(&events, SILENT_PANE_MIN_MS);
    assert_eq!(
        silent,
        vec![SilentPane {
            session: "s".into(),
            pane: "%1".into(),
            alive_ms: 45_000,
            captures: 1,
            size: Some((139, 27)),
            during: Some("suite › first test start".into()),
        }]
    );
    let annotation = github_annotations(&events);
    assert!(
        annotation.starts_with("::warning title=Silent shell pane::%251 in s"),
        "{annotation}"
    );
}

/// A session's first `connect` is not a reconnect, however many of its
/// events came first (a span is written when it closes, after the events
/// it contained); its second is.
#[test]
fn only_a_second_connect_is_a_reconnect() {
    let e = |name: &str, phase: &str| {
        ev(serde_json::json!({"layer": "monitor", "name": name, "phase": phase, "session": "s"}))
    };
    let once = vec![
        e("pane appeared", "event"),
        e("pane captured", "event"),
        e("connect", "span"),
    ];
    assert!(
        health_check(&once).contains("reconnects: 0"),
        "{}",
        health_check(&once)
    );
    let twice = vec![
        e("connect", "span"),
        e("pane appeared", "event"),
        e("connect", "span"),
    ];
    assert!(
        health_check(&twice).contains("reconnects: 1"),
        "{}",
        health_check(&twice)
    );
}

/// One test's slice: from its marker up to the next marker.
#[test]
fn a_window_is_the_events_between_a_marker_and_the_next() {
    let m =
        |label: &str| ev(serde_json::json!({"layer": "marker", "name": "mark", "label": label}));
    let e = |n: &str| ev(serde_json::json!({"layer": "monitor", "name": n}));
    let events = vec![
        e("before"),
        m("a"),
        e("in-a"),
        e("also-in-a"),
        m("b"),
        e("in-b"),
    ];
    let names: Vec<_> = window(&events, "a")
        .iter()
        .map(|x| x.get("name").unwrap().as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["mark", "in-a", "also-in-a"]);
    assert!(window(&events, "missing").is_empty());
}

#[test]
fn parse_lines_skips_blank_and_malformed() {
    let content = "{\"layer\":\"server\",\"name\":\"a\"}\n\nnot json\n{\"layer\":\"monitor\",\"name\":\"b\"}\n";
    let parsed = parse_lines(content);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].get("name").unwrap(), "a");
    assert_eq!(parsed[1].get("name").unwrap(), "b");
}

#[test]
fn spans_export_as_complete_events_with_duration() {
    let events = vec![ev(serde_json::json!({
        "layer": "monitor", "name": "connect", "phase": "span",
        "dur_us": 45976, "ts_wall": 1_700_000_000_000u64, "session": "work"
    }))];
    let trace = to_chrome_trace(&events);
    let arr = trace.get("traceEvents").unwrap().as_array().unwrap();
    // one span event + one thread_name metadata
    let span = &arr[0];
    assert_eq!(span.get("ph").unwrap(), "X");
    assert_eq!(span.get("dur").unwrap(), 45976);
    assert_eq!(span.get("name").unwrap(), "connect");
    // ts is microseconds = ms * 1000
    assert_eq!(span.get("ts").unwrap().as_f64().unwrap(), 1.7e15);
    // moved fields land in args, structural keys stripped
    assert_eq!(span.get("args").unwrap().get("session").unwrap(), "work");
    assert!(span.get("args").unwrap().get("dur_us").is_none());
}

#[test]
fn point_events_export_as_instant() {
    let events = vec![ev(serde_json::json!({
        "layer": "xstate", "name": "SEND_TMUX_COMMAND", "phase": "event",
        "ts_wall": 1_700_000_000_000u64, "action_id": "a-1-2"
    }))];
    let arr = to_chrome_trace(&events);
    let first = &arr.get("traceEvents").unwrap().as_array().unwrap()[0];
    assert_eq!(first.get("ph").unwrap(), "i");
    assert_eq!(
        first.get("args").unwrap().get("action_id").unwrap(),
        "a-1-2"
    );
}

#[test]
fn summarize_correlates_by_action_id() {
    let events = vec![
        ev(
            serde_json::json!({"layer":"xstate","name":"SEND","action_id":"a-1-1","ts_wall":1000u64}),
        ),
        ev(
            serde_json::json!({"layer":"adapter","name":"send","action_id":"a-1-1","ts_wall":1002u64}),
        ),
        ev(
            serde_json::json!({"layer":"server","name":"client command","action_id":"a-1-1","ts_wall":1005u64}),
        ),
        ev(serde_json::json!({"layer":"monitor","name":"run","ts_wall":1010u64})),
    ];
    let s = summarize(&events);
    assert!(s.contains("4 events over 10 ms"));
    assert!(s.contains("correlated actions (by action_id): 1"));
    // the action's layer chain is shown
    assert!(s.contains("xstate → adapter → server"));
}

#[test]
fn health_check_detects_reconnects_and_rejections() {
    let events = vec![
        ev(serde_json::json!({
            "layer": "server", "name": "client connect", "session": "main", "ts_wall": 1000u64
        })),
        ev(serde_json::json!({
            "layer": "server", "name": "client reconnect", "session": "main", "ts_wall": 2000u64
        })),
        ev(serde_json::json!({
            "layer": "effect", "name": "fail", "session": "main", "code": "REJECTED", "ts_wall": 3000u64
        })),
        ev(serde_json::json!({
            "layer": "adapter", "name": "send", "session": "test_sess", "ts_wall": 4000u64
        })),
    ];
    let h = health_check(&events);
    assert!(h.contains("events analyzed: 4"));
    assert!(h.contains("sessions tracked: 2"));
    assert!(h.contains("reconnects: 1"));
    assert!(h.contains("rejected commands: 1"));
    assert!(h.contains("main"));
    assert!(h.contains("test_sess"));
}

#[test]
fn github_workflow_annotations_percent_escape_newlines_and_carriage_returns() {
    assert_eq!(
        health::escape_github_workflow_data("a%b\rc\n::error::x"),
        "a%25b%0Dc%0A::error::x"
    );
    let events = vec![
        ev(serde_json::json!({
            "layer": "marker",
            "name": "mark",
            "label": "line1\r\n::error::injected",
            "ts_wall": 0
        })),
        lifecycle(
            "pane appeared",
            "%1",
            1_000,
            serde_json::json!({"shell": true, "bytes": 0}),
        ),
        lifecycle("pane gone", "%1", 46_000, serde_json::json!({})),
    ];
    let annotation = github_annotations(&events);
    assert_eq!(annotation.lines().count(), 2, "{annotation}");
    assert!(
        annotation.contains("%0D%0A::error::injected"),
        "{annotation}"
    );
}
