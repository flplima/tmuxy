use super::*;

#[test]
fn allowlist_admits_only_tmuxy_targets() {
    assert!(target_allowed("tmuxy_core::control_mode::monitor"));
    assert!(target_allowed("tmuxy_server::sse"));
    assert!(!target_allowed("hyper::proto"));
    assert!(!target_allowed("tower::buffer"));
}

#[test]
fn verbatim_keys_pass_through_but_unknown_keys_drop() {
    let mut v = FieldVisitor::default();
    v.put_str("op", "split-window");
    v.put_str("session", "work");
    v.put_str("command", "send-keys -l secret-password");
    v.put_num("seq", Value::from(42u64));
    v.put_num("secret_count", Value::from(9u64));

    assert_eq!(v.fields.get("op").unwrap(), "split-window");
    assert_eq!(v.fields.get("session").unwrap(), "work");
    assert_eq!(v.fields.get("seq").unwrap(), 42);
    // Not on any list → dropped entirely.
    assert!(!v.fields.contains_key("command"));
    assert!(!v.fields.contains_key("secret_count"));
}

#[test]
fn name_and_path_fields_are_hashed_not_stored_raw() {
    let mut v = FieldVisitor::default();
    v.put_str("name", "my-secret-window-title");
    v.put_str("path", "/home/alice/projects/acme/secret.txt");

    let name = v.fields.get("name").unwrap().as_str().unwrap();
    let path = v.fields.get("path").unwrap().as_str().unwrap();
    assert!(name.starts_with("h:"));
    assert!(path.starts_with("h:"));
    assert!(!name.contains("secret"));
    assert!(!path.contains("secret"));
    // Stable: same input → same id.
    assert_eq!(name, hash_str("my-secret-window-title"));
}

#[test]
fn error_and_message_are_scrubbed_and_truncated() {
    let mut v = FieldVisitor::default();
    let long = "x".repeat(500);
    v.put_str("error", &long);
    assert_eq!(
        v.fields.get("error").unwrap().as_str().unwrap().len(),
        MAX_SCRUB
    );

    // message is captured separately as the event name, still scrubbed.
    let mut v2 = FieldVisitor::default();
    v2.put_str("message", &"y".repeat(500));
    assert_eq!(v2.message.as_ref().unwrap().len(), MAX_SCRUB);
}

#[test]
fn sanitize_client_fields_drops_content_and_hashes_names() {
    let mut input = Map::new();
    input.insert("layer".into(), Value::from("xstate"));
    input.insert("name".into(), Value::from("SEND_TMUX_COMMAND"));
    input.insert("phase".into(), Value::from("event"));
    input.insert("op".into(), Value::from("split-window"));
    input.insert("pane".into(), Value::from("%3"));
    input.insert("ts_wall".into(), Value::from(1_700_000_000_000u64));
    // A hostile/careless client trying to smuggle terminal content:
    input.insert("command".into(), Value::from("send-keys -l my-password"));
    input.insert("keys".into(), Value::from("password123"));
    input.insert("title".into(), Value::from("secret-project"));

    let out = super::sanitize_client_fields(input);

    assert_eq!(out.get("layer").unwrap(), "xstate");
    assert_eq!(out.get("op").unwrap(), "split-window");
    assert_eq!(out.get("pane").unwrap(), "%3");
    assert_eq!(out.get("ts_wall").unwrap(), 1_700_000_000_000u64);
    // Content-bearing keys not on any list are dropped.
    assert!(!out.contains_key("command"));
    assert!(!out.contains_key("keys"));
    // A name/path key is admitted only as an opaque hash.
    let title = out.get("title").unwrap().as_str().unwrap();
    assert!(title.starts_with("h:"));
    assert!(!title.contains("secret"));
}

#[test]
fn levels_trade_hashing_and_command_strings() {
    // Shape: names hashed, command dropped (safe/shareable default).
    assert!(
        super::admit_json_at("title", Value::from("secret-proj"), TraceLevel::Shape)
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("h:")
    );
    assert!(
        super::admit_json_at("command", Value::from("split-window -h"), TraceLevel::Shape)
            .is_none()
    );

    // Labeled: names in the clear, command still dropped.
    assert_eq!(
        super::admit_json_at("title", Value::from("secret-proj"), TraceLevel::Labeled).unwrap(),
        "secret-proj"
    );
    assert!(super::admit_json_at(
        "command",
        Value::from("split-window -h"),
        TraceLevel::Labeled
    )
    .is_none());

    // Full: command string admitted (local-debug only).
    assert_eq!(
        super::admit_json_at("command", Value::from("split-window -h"), TraceLevel::Full).unwrap(),
        "split-window -h"
    );
}

#[test]
fn kill_switch_env_disables() {
    std::env::set_var("TMUXY_NO_TRACE", "1");
    assert!(kill_switch());
    std::env::remove_var("TMUXY_NO_TRACE");
    std::env::set_var("DO_NOT_TRACK", "1");
    assert!(kill_switch());
    std::env::remove_var("DO_NOT_TRACK");
    assert!(!kill_switch());
}

#[test]
fn level_names_round_trip() {
    for level in [TraceLevel::Shape, TraceLevel::Labeled, TraceLevel::Full] {
        assert_eq!(TraceLevel::parse(level.as_str()), level);
        assert_eq!(TraceLevel::from_u8(level as u8), level);
    }
}

#[test]
fn unknown_level_falls_back_to_the_safe_default() {
    // A stale config or a typo must never silently raise sensitivity.
    assert_eq!(TraceLevel::parse("verbose"), TraceLevel::Shape);
    assert_eq!(TraceLevel::parse(""), TraceLevel::Shape);
    assert_eq!(TraceLevel::from_u8(9), TraceLevel::Shape);
}

#[test]
fn explicit_flag_beats_everything_below_it() {
    assert!(resolve_enabled(true, Some(false), false));
    assert!(resolve_enabled(true, None, false));
}

#[test]
fn saved_preference_overrides_the_dev_build_default() {
    // The menu switch must be able to turn a development build's automatic
    // tracing OFF, not just decorate it.
    assert!(!resolve_enabled(false, Some(false), true));
    // ...and to turn a release build ON, which is the whole point.
    assert!(resolve_enabled(false, Some(true), false));
}

#[test]
fn with_no_saved_preference_the_build_kind_decides() {
    assert!(resolve_enabled(false, None, true));
    assert!(!resolve_enabled(false, None, false));
}
