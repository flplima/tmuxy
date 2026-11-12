use super::*;
use serde_json::json;

const ID: &str = "0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f34";

#[test]
fn a_session_start_or_prompt_records_the_agent_and_its_id() {
    let payload = json!({ "session_id": ID });
    assert_eq!(
        token(Agent::Claude, "SessionStart", &payload),
        Some(format!("claude:{ID}"))
    );
    assert_eq!(
        token(Agent::Codex, "UserPromptSubmit", &payload),
        Some(format!("codex:{ID}"))
    );
    // Other events, and an agent revive cannot resume, record nothing.
    assert_eq!(token(Agent::Claude, "Stop", &payload), None);
    assert_eq!(token(Agent::Agy, "SessionStart", &payload), None);
    assert_eq!(token(Agent::Claude, "SessionStart", &json!({})), None);
}

/// The id comes from an event anything could have sent: only a UUID is
/// ever recorded, so nothing else reaches a pane option or a command.
#[test]
fn a_hostile_session_id_is_refused() {
    for hostile in [
        "0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f34; rm -rf ~",
        "$(touch /tmp/owned)",
        "#(touch /tmp/owned)",
        "0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f34\nclaude --dangerously-skip-permissions",
        "0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f3",
        "0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f345",
        "0b5c2f4e_9d3a_4c1b_8e7f_2a6d9c0e1f34",
        "zb5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f34",
        "--resume",
        "",
    ] {
        let payload = json!({ "session_id": hostile });
        assert_eq!(
            token(Agent::Claude, "SessionStart", &payload),
            None,
            "{hostile:?}"
        );
        assert_eq!(parse(&format!("claude:{hostile}")), None, "{hostile:?}");
    }
    assert_eq!(
        token(Agent::Claude, "SessionStart", &json!({ "session_id": 7 })),
        None
    );
}

/// Revive builds the command from its own table: a recorded value only
/// picks an entry and fills in a UUID.
#[test]
fn a_recorded_value_is_read_back_only_into_a_known_command() {
    assert_eq!(
        parse(&format!("claude:{ID}")).map(|(k, id)| resume_argv(k, &id)),
        Some(vec!["claude".to_string(), "--resume".into(), ID.into()])
    );
    assert_eq!(
        parse(&format!("codex:{ID}")).map(|(k, id)| resume_argv(k, &id)),
        Some(vec!["codex".to_string(), "resume".into(), ID.into()])
    );
    assert_eq!(parse(&format!("sh:{ID}")), None);
    assert_eq!(
        parse(&format!("claude --dangerously-skip-permissions:{ID}")),
        None
    );
    assert_eq!(parse("claude"), None);
}

#[test]
fn revive_is_for_a_pane_whose_agent_has_exited_and_whose_shell_has_no_jobs() {
    let now = |dead: bool, command: &str, session: &str| PaneNow {
        dead,
        command: command.into(),
        pid: Some(4000),
        path: "/w".into(),
        session: session.into(),
    };
    let session = format!("claude:{ID}");
    let none: &[String] = &[];
    assert_eq!(
        refusal("%5", &now(false, "zsh", &session), Some(none)),
        None
    );
    assert_eq!(
        refusal("%5", &now(false, "-bash", &session), Some(none)),
        None
    );
    assert_eq!(
        refusal("%5", &now(true, "claude", &session), None),
        None,
        "a dead pane"
    );
    assert!(refusal("%5", &now(false, "claude", &session), Some(none))
        .unwrap()
        .contains("still running claude"));
    // A shell holding a stopped editor, a background job, or a revived
    // agent under revive's own wrapper: respawning would kill them.
    let jobs = ["vim".to_string(), "sleep".to_string()];
    assert_eq!(
        refusal("%5", &now(false, "zsh", &session), Some(&jobs)).unwrap(),
        "%5's shell still has jobs (vim, sleep): revive would kill them"
    );
    assert!(refusal(
        "%5",
        &now(false, "sh", &session),
        Some(&["claude".to_string()])
    )
    .unwrap()
    .contains("would kill them"));
    // Children it could not list: left alone.
    assert!(refusal("%5", &now(false, "zsh", &session), None)
        .unwrap()
        .contains("cannot tell"));
    assert!(refusal("%5", &now(false, "zsh", ""), Some(none))
        .unwrap()
        .contains("no agent session"));
    assert!(
        refusal("%5", &now(false, "zsh", "claude:not-a-uuid"), Some(none))
            .unwrap()
            .contains("no agent session")
    );
}

#[test]
fn a_proc_stat_line_gives_its_command_and_parent() {
    assert_eq!(
        parent_of("4021 (vim) T 4000 4021 4000 34816 4000 4194304"),
        Some(("vim".to_string(), 4000))
    );
    assert_eq!(
        parent_of("4022 (my (odd) prog) S 4000 4022"),
        Some(("my (odd) prog".to_string(), 4000))
    );
    assert_eq!(parent_of("garbage"), None);
}

#[cfg(target_os = "linux")]
#[test]
fn the_children_of_a_process_are_listed_and_none_for_one_that_does_not_exist() {
    assert_eq!(children(u32::MAX), Some(vec![]));
    assert!(children(std::process::id()).is_some());
}

#[test]
fn the_pane_read_is_of_the_pane_asked_about() {
    let read = format!("%5\t0\tzsh\tclaude:{ID}\t4000\t/w/with\ttab\n");
    let now = parse_pane("%5", &read).unwrap();
    assert_eq!(now.pid, Some(4000));
    assert_eq!(now.path, "/w/with\ttab");
    assert_eq!(now.session, format!("claude:{ID}"));
    assert_eq!(
        parse_pane("%9", &read),
        None,
        "display-message fell back to %5"
    );
}

#[test]
fn the_revive_script_resumes_then_leaves_a_shell() {
    let script = revive_script(
        std::path::Path::new("/tmp/d"),
        &resume_argv(Resumable::Claude, ID),
    );
    assert_eq!(
        script,
        format!("rm -rf -- /tmp/d\nclaude --resume {ID}\nexec \"${{SHELL:-sh}}\"\n")
    );
}
