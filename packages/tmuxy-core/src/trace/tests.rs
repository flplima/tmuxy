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
    assert!(!v.fields.contains_key("command"));
    assert!(!v.fields.contains_key("secret_count"));
}

#[test]
fn path_fields_are_hashed_not_stored_raw() {
    let mut v = FieldVisitor::default();
    v.put_str("path", "/home/alice/projects/acme/secret.txt");

    let path = v.fields.get("path").unwrap().as_str().unwrap();
    assert!(path.starts_with("h:"));
    assert!(!path.contains("secret"));
    assert_eq!(path, hash_str("/home/alice/projects/acme/secret.txt"));
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
    input.insert("path".into(), Value::from("secret-project"));

    let out = super::sanitize_client_fields(input, TraceLevel::Shape);

    assert_eq!(out.get("layer").unwrap(), "xstate");
    assert_eq!(out.get("op").unwrap(), "split-window");
    assert_eq!(out.get("pane").unwrap(), "%3");
    assert_eq!(out.get("ts_wall").unwrap(), 1_700_000_000_000u64);
    assert!(!out.contains_key("command"));
    assert!(!out.contains_key("keys"));
    let path = out.get("path").unwrap().as_str().unwrap();
    assert!(path.starts_with("h:"));
    assert!(!path.contains("secret"));
}

#[test]
fn levels_trade_hashing_and_command_strings() {
    assert!(
        super::admit("path", Value::from("secret-proj"), TraceLevel::Shape)
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("h:")
    );
    assert!(super::admit("command", Value::from("split-window -h"), TraceLevel::Shape).is_none());

    assert_eq!(
        super::admit("path", Value::from("secret-proj"), TraceLevel::Labeled).unwrap(),
        "secret-proj"
    );
    assert!(super::admit(
        "command",
        Value::from("split-window -h"),
        TraceLevel::Labeled
    )
    .is_none());

    assert_eq!(
        super::admit("command", Value::from("split-window -h"), TraceLevel::Full).unwrap(),
        "split-window -h"
    );
}

/// `Full` keeps command strings, and every keystroke and paste
/// is one — so a password typed at a `sudo` prompt landed in trace.ndjson in
/// the clear, against the promise that keystroke payloads are never captured
/// at any level.
#[test]
fn full_keeps_the_command_but_never_the_keys_or_the_paste() {
    let full = |cmd: &str| {
        super::admit("command", Value::from(cmd), TraceLevel::Full)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    };
    // What the UI sends for typed text, a key, and a paste.
    for (sent, kept) in [
        ("send-keys -t %0 -l -- 'hunter2'", "send-keys …"),
        ("send-keys -t %0 Enter", "send-keys …"),
        ("send -t %0 -l -- hunter2", "send …"),
        ("send-k -t %0 -l -- hunter2", "send-k …"),
        (
            "set-buffer -b tmuxy-paste \"hunter2\" ; paste-buffer -p -d -b tmuxy-paste -t %0",
            "set-buffer …",
        ),
        ("setb -a -b tmuxy-paste hunter2", "setb …"),
        // Further into a compound, a newline-joined batch, or glued to `;`.
        (
            "selectp -t %1 \\; send-keys -l hunter2",
            "selectp -t %1 \\; send-keys …",
        ),
        (
            "send-keys -t %0 -l -- abc\nsend-keys -t %0 Enter\nsend-keys -t %0 -l -- hunter2",
            "send-keys …",
        ),
        (
            "selectp -t %1;send-keys -l hunter2",
            "selectp -t %1;send-keys …",
        ),
    ] {
        assert_eq!(full(sent), kept, "{sent}");
    }
    assert_eq!(full("resizep -t %0 -Z"), "resizep -t %0 -Z");
}

/// A client's structural fields are identifiers; free text in them would slip
/// past the hashing that `name` gets everywhere else.
#[test]
fn client_structural_fields_admit_only_identifiers() {
    let mut input = Map::new();
    input.insert("layer".into(), Value::from("xstate"));
    input.insert("name".into(), Value::from("my password is hunter2"));
    input.insert("component".into(), Value::from("open_url"));
    input.insert("phase".into(), Value::from("x".repeat(65)));
    input.insert("level".into(), Value::from(3));
    let out = sanitize_client_fields(input, TraceLevel::Shape);
    assert_eq!(out.get("layer").unwrap(), "xstate");
    assert_eq!(out.get("component").unwrap(), "open_url");
    assert!(!out.contains_key("name"));
    assert!(!out.contains_key("phase"));
    assert!(!out.contains_key("level"));
}

/// Over a given environment, not the process's: a test that set and removed
/// `DO_NOT_TRACK` raced the others and failed where the machine exports it.
#[test]
fn kill_switch_env_disables() {
    let env = |set: &'static [(&str, &str)]| {
        move |name: &str| {
            set.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    };
    assert!(kill_switch_in(env(&[("TMUXY_NO_TRACE", "1")])));
    assert!(kill_switch_in(env(&[("DO_NOT_TRACK", "1")])));
    assert!(!kill_switch_in(env(&[("DO_NOT_TRACK", "0")])));
    assert!(!kill_switch_in(env(&[])));
}

#[test]
fn a_rust_field_and_a_client_field_are_admitted_alike() {
    for (key, value) in [
        ("session", "~/x"),
        ("path", "/home/a/b"),
        ("error", "failed at /tmp"),
        ("command", "send-keys -l x"),
        ("keys", "hunter2"),
    ] {
        let mut v = FieldVisitor::default();
        v.put_str(key, value);
        let mut client = Map::new();
        client.insert(key.to_string(), Value::from(value));
        assert_eq!(
            v.fields.get(key),
            sanitize_client_fields(client, level()).get(key),
            "{key}"
        );
    }
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
    assert!(!resolve_enabled(false, Some(false), true));
    assert!(resolve_enabled(false, Some(true), false));
}

#[test]
fn with_no_saved_preference_the_build_kind_decides() {
    assert!(resolve_enabled(false, None, true));
    assert!(!resolve_enabled(false, None, false));
}
