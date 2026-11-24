use serde_json::json;

use super::question::question_status;
use super::*;

/// Every place an agent's config is read from or written to, under one
/// fresh directory in the system's temp dir: never the developer's own
/// `~/.claude`, `~/.codex` or `~/.agents`, which every agent on the machine
/// is reading right now. `write_doc` and the skill writes refuse anything
/// outside the temp dir in a test as well.
pub(super) fn scratch(name: &str) -> Places {
    let root = std::env::temp_dir().join(format!("tmuxy-agents-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let places = Places {
        claude_dir: root.join("home/.claude"),
        codex_home: root.join("home/.codex"),
        config_home: root.join("home/.config"),
        crush_skills: root.join("home/.config/crush/skills"),
        home: root.join("home"),
        cwd: root.join("project"),
        path: None,
    };
    for dir in [
        &places.claude_dir,
        &places.codex_home,
        &places.config_home,
        &places.crush_skills,
        &places.home,
        &places.cwd,
    ] {
        assert!(
            dir.starts_with(&root),
            "{} is outside {}",
            dir.display(),
            root.display()
        );
    }
    places
}

pub(super) fn which(agents: &[Agent]) -> Which {
    Which {
        agents: agents.to_vec(),
        hooks_only: false,
        skill_only: false,
        project: false,
        dry_run: false,
    }
}

#[test]
fn each_event_means_a_state() {
    let none = Value::Null;
    assert_eq!(
        state(Agent::Claude, "UserPromptSubmit", &none),
        Some("working")
    );
    assert_eq!(
        state(Agent::Claude, "PermissionRequest", &none),
        Some("needs-input")
    );
    assert_eq!(state(Agent::Claude, "Stop", &none), Some("idle"));
    assert_eq!(state(Agent::Claude, "StopFailure", &none), Some("error"));
    assert_eq!(state(Agent::Claude, "SessionEnd", &none), Some("clear"));
    let asked = json!({ "notification_type": "permission_prompt" });
    assert_eq!(
        state(Agent::Claude, "Notification", &asked),
        Some("needs-input")
    );
    let idle = json!({ "notification_type": "idle_prompt" });
    assert_eq!(state(Agent::Claude, "Notification", &idle), None);
    assert_eq!(state(Agent::Codex, "Interrupt", &none), Some("idle"));
    assert_eq!(state(Agent::Agy, "PreInvocation", &none), Some("working"));
    // Antigravity has no permission hook; a tool finishing is working again.
    assert_eq!(state(Agent::Agy, "PostToolUse", &none), Some("working"));
    // A failed model request is the turn's error; the retry that answers is
    // working again.
    let refused = json!({ "status": "failed", "error": "rate limited" });
    assert_eq!(
        state(Agent::Codex, "PostModelRequest", &refused),
        Some("error")
    );
    let answered = json!({ "status": "ok", "error": null });
    assert_eq!(
        state(Agent::Codex, "PostModelRequest", &answered),
        Some("working")
    );
    let failed = json!({ "terminationReason": "error", "error": "", "fullyIdle": true });
    assert_eq!(state(Agent::Agy, "Stop", &failed), Some("error"));
    let done = json!({ "terminationReason": "model_stop", "fullyIdle": true });
    assert_eq!(state(Agent::Agy, "Stop", &done), Some("idle"));
    assert_eq!(state(Agent::Codex, "PreCompact", &none), None);
}

/// What the user is asked, read back as the pane's status says it.
fn asked(agent: Agent, event: &str, payload: Value) -> Option<String> {
    let status = question_status(agent, event, &payload)?;
    tmuxy_core::control_mode::status_message(&status, "needs-input")
}

/// A `needs-input` event says what for: the question itself, or the tool and
/// what it would do; the permission notification, seconds later and saying
/// only that, says nothing over it.
#[test]
fn a_needs_input_event_says_what_the_user_is_asked() {
    let question = json!({
        "tool_name": "AskUserQuestion",
        "tool_input": { "questions": [
            { "question": "Which framework?", "header": "Framework", "options": [] },
            { "question": "Which test runner?", "header": "Tests", "options": [] }
        ] }
    });
    assert_eq!(
        state(Agent::Claude, "PreToolUse", &question),
        Some("needs-input")
    );
    assert_eq!(
        asked(Agent::Claude, "PreToolUse", question.clone()).as_deref(),
        Some("Which framework? (+1 more)")
    );
    assert!(question_status(Agent::Claude, "PreToolUse", &question)
        .unwrap()
        .contains(":kind=question:app=claude:"));
    assert_eq!(
        asked(Agent::Claude, "PermissionRequest", question).as_deref(),
        Some("Which framework? (+1 more)")
    );

    let bash = json!({
        "tool_name": "Bash",
        "tool_input": { "command": "npm test\n  -- --watch", "description": "Run tests" }
    });
    assert_eq!(
        asked(Agent::Claude, "PermissionRequest", bash).as_deref(),
        Some("Allow Bash: npm test -- --watch")
    );
    let edit = json!({ "tool_name": "Edit", "tool_input": { "file_path": "src/app.ts" } });
    assert_eq!(
        asked(Agent::Claude, "PermissionRequest", edit).as_deref(),
        Some("Allow Edit: src/app.ts")
    );
    let argv = json!({ "tool_name": "shell", "tool_input": { "command": ["git", "push"] } });
    assert_eq!(
        asked(Agent::Codex, "PermissionRequest", argv).as_deref(),
        Some("Allow shell: git push")
    );
    let plan = json!({
        "tool_name": "ExitPlanMode",
        "tool_input": { "plan": "\n# Move auth to magic links\n\n1. …" }
    });
    assert_eq!(
        asked(Agent::Claude, "PreToolUse", plan).as_deref(),
        Some("Approve the plan: Move auth to magic links")
    );

    let elicited = json!({
        "notification_type": "elicitation_dialog",
        "message": "Which repository should I open?"
    });
    assert_eq!(
        asked(Agent::Claude, "Notification", elicited).as_deref(),
        Some("Which repository should I open?")
    );
    let permission = json!({
        "notification_type": "permission_prompt",
        "message": "Claude needs your permission"
    });
    assert_eq!(
        question_status(Agent::Claude, "Notification", &permission),
        None
    );
    assert_eq!(question_status(Agent::Claude, "Stop", &Value::Null), None);
    assert_eq!(
        question_status(Agent::Claude, "PermissionRequest", &Value::Null),
        None
    );
}

/// The hook script's second line: the question on `needs-input`, nothing
/// when that event says nothing more, and `-` (off) on every other state.
#[test]
fn the_status_line_puts_the_question_up_and_takes_it_off() {
    let question = json!({
        "tool_name": "AskUserQuestion",
        "tool_input": { "questions": [{ "question": "Ship it?" }] }
    });
    let up = status_line(Agent::Claude, "PreToolUse", &question, "needs-input").unwrap();
    assert!(up.starts_with("state=blocked:kind=question:"), "{up}");
    let later = json!({ "notification_type": "permission_prompt" });
    assert_eq!(
        status_line(Agent::Claude, "Notification", &later, "needs-input"),
        None
    );
    for state in ["working", "idle", "error", "clear"] {
        assert_eq!(
            status_line(Agent::Claude, "PostToolUse", &Value::Null, state).as_deref(),
            Some("-")
        );
    }
}

#[test]
fn every_installed_event_means_something() {
    for agent in ALL {
        for hook in agent.hooks() {
            let payload = json!({ "notification_type": "permission_prompt" });
            assert!(
                state(agent, hook.event, &payload).is_some(),
                "{:?} {}",
                agent,
                hook.event
            );
        }
    }
}

#[test]
fn install_keeps_the_users_settings_and_hooks_and_uninstall_restores_them() {
    let places = scratch("claude");
    let path = places.hooks_file(Agent::Claude, Scope::Home).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = r#"{
  "theme": "dark",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "say done"
          }
        ]
      }
    ]
  },
  "model": "opus"
}
"#;
    std::fs::write(&path, original).unwrap();

    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Claude]),
        false,
        "/bin/tmuxy",
    )
    .unwrap();
    let doc = read_doc(&path).unwrap();
    let keys: Vec<&str> = doc.keys().map(String::as_str).collect();
    assert_eq!(keys, ["theme", "hooks", "model"], "order kept");
    let stop = doc["hooks"]["Stop"].as_array().unwrap();
    assert_eq!(stop[0]["hooks"][0]["command"], "say done");
    assert_eq!(
        stop[1]["hooks"][0]["command"],
        hook_command(Agent::Claude, "Stop", "/bin/tmuxy")
    );
    assert_eq!(
        doc["hooks"]["Notification"][0]["matcher"],
        CLAUDE_NEEDS_INPUT
    );
    assert_eq!(
        hooked_events(&doc, Agent::Claude),
        Agent::Claude.hooks().len()
    );
    assert_eq!(
        std::fs::read_to_string(backup_path(&path)).unwrap(),
        original
    );

    // Installing again replaces tmuxy's entries rather than adding more.
    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Claude]),
        false,
        "/usr/local/bin/tmuxy",
    )
    .unwrap();
    let doc = read_doc(&path).unwrap();
    assert_eq!(doc["hooks"]["Stop"].as_array().unwrap().len(), 2);
    assert_eq!(
        doc["hooks"]["Stop"][1]["hooks"][0]["command"],
        hook_command(Agent::Claude, "Stop", "/usr/local/bin/tmuxy")
    );

    uninstall(&mut String::new(), &places, &which(&[Agent::Claude])).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn antigravity_gets_a_named_hook_set_beside_the_users() {
    let places = scratch("agy");
    let path = places.hooks_file(Agent::Agy, Scope::Home).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        r#"{"browser-cleanup":{"Stop":[{"type":"command","command":"reap"}]}}"#,
    )
    .unwrap();

    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Agy]),
        false,
        "tmuxy",
    )
    .unwrap();
    let doc = read_doc(&path).unwrap();
    assert_eq!(doc["browser-cleanup"]["Stop"][0]["command"], "reap");
    assert_eq!(
        doc["tmuxy"]["Stop"][0]["command"],
        hook_command(Agent::Agy, "Stop", "tmuxy")
    );
    assert_eq!(hooked_events(&doc, Agent::Agy), Agent::Agy.hooks().len());

    uninstall(&mut String::new(), &places, &which(&[Agent::Agy])).unwrap();
    let doc = read_doc(&path).unwrap();
    assert!(doc.get("tmuxy").is_none());
    assert_eq!(doc["browser-cleanup"]["Stop"][0]["command"], "reap");
}

#[test]
fn codex_hooks_go_in_hooks_json_and_session_end_fits_its_limit() {
    let places = scratch("codex");
    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Codex]),
        false,
        "tmuxy",
    )
    .unwrap();
    let doc = read_doc(&places.codex_home.join("hooks.json")).unwrap();
    assert_eq!(doc["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 3);
    assert_eq!(
        doc["hooks"]["PermissionRequest"][0]["hooks"][0]["command"],
        hook_command(Agent::Codex, "PermissionRequest", "tmuxy")
    );
    assert_eq!(
        places.skill_dir(Agent::Codex, Scope::Home).unwrap(),
        places.home.join(".agents/skills/tmuxy")
    );
}

#[test]
fn a_skill_tmuxy_did_not_write_is_left_alone_unless_forced() {
    let places = scratch("skill");
    let dir = places.skill_dir(Agent::Claude, Scope::Home).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "mine").unwrap();
    let skill_only = Which {
        skill_only: true,
        ..which(&[Agent::Claude])
    };

    install(&mut String::new(), &places, &skill_only, false, "tmuxy").unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        "mine"
    );
    uninstall(&mut String::new(), &places, &skill_only).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        "mine"
    );

    install(&mut String::new(), &places, &skill_only, true, "tmuxy").unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        SKILL
    );
    assert_eq!(
        std::fs::read_to_string(backup_path(&dir).join("SKILL.md")).unwrap(),
        "mine"
    );
    assert!(matches!(skill_state(&dir), SkillState::Ours(v) if v == VERSION));

    uninstall(&mut String::new(), &places, &skill_only).unwrap();
    assert!(!dir.exists());
}

#[cfg(unix)]
#[test]
fn a_settings_file_that_is_a_symlink_stays_one() {
    let places = scratch("symlink");
    let path = places.hooks_file(Agent::Claude, Scope::Home).unwrap();
    let real = places.home.join("dotfiles/claude-settings.json");
    std::fs::create_dir_all(real.parent().unwrap()).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&real, "{\"theme\": \"dark\"}\n").unwrap();
    std::os::unix::fs::symlink(&real, &path).unwrap();

    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Claude]),
        false,
        "tmuxy",
    )
    .unwrap();
    assert!(std::fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        hooked_events(&read_doc(&real).unwrap(), Agent::Claude),
        Agent::Claude.hooks().len()
    );
}

#[test]
fn a_file_that_is_not_json_is_refused_untouched() {
    let places = scratch("broken");
    let path = places.hooks_file(Agent::Claude, Scope::Home).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{ not json").unwrap();
    assert!(install(
        &mut String::new(),
        &places,
        &which(&[Agent::Claude]),
        false,
        "tmuxy"
    )
    .is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
}

/// The agent runs the hook through a shell: a path with a space, or a quote,
/// is one word there, never a second command.
#[test]
fn a_hook_command_quotes_the_tmuxy_path() {
    let line = hook_command(
        Agent::Claude,
        "Stop",
        "/Users/me/Application Support/tmuxy; id",
    );
    assert!(
        line.starts_with("command -v '/Users/me/Application Support/tmuxy; id' >/dev/null"),
        "{line}"
    );
    assert!(!line.contains(" id >"), "{line}");
    assert_eq!(
        hook_command(Agent::Claude, "Stop", "/bin/tmuxy"),
        "command -v /bin/tmuxy >/dev/null 2>&1 && /bin/tmuxy agent hook claude Stop 2>/dev/null || true"
    );
}

/// The screen correction runs on every agent tmuxy hooks: each one's process
/// name is one it watches.
#[cfg(feature = "native")]
#[test]
fn every_hooked_agent_is_one_the_screen_watches() {
    for agent in ALL.into_iter().filter(|agent| !agent.hooks().is_empty()) {
        assert!(
            tmuxy_core::host::socket_watch::agent_screen::is_agent(agent.name()),
            "{}",
            agent.name()
        );
    }
}
