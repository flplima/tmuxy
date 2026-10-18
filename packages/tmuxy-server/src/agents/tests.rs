use serde_json::json;

use super::*;

fn scratch(name: &str) -> Places {
    let root = std::env::temp_dir().join(format!("tmuxy-agents-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    Places {
        claude_dir: root.join("home/.claude"),
        codex_home: root.join("home/.codex"),
        home: root.join("home"),
        cwd: root.join("project"),
        path: None,
    }
}

fn which(agents: &[Agent]) -> Which {
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
    let failed = json!({ "terminationReason": "error", "error": "", "fullyIdle": true });
    assert_eq!(state(Agent::Agy, "Stop", &failed), Some("error"));
    let done = json!({ "terminationReason": "model_stop", "fullyIdle": true });
    assert_eq!(state(Agent::Agy, "Stop", &done), Some("idle"));
    assert_eq!(state(Agent::Codex, "PreCompact", &none), None);
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
    let path = places.hooks_file(Agent::Claude, Scope::Home);
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

    install(&places, &which(&[Agent::Claude]), false, "/bin/tmuxy").unwrap();
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

    uninstall(&places, &which(&[Agent::Claude])).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn antigravity_gets_a_named_hook_set_beside_the_users() {
    let places = scratch("agy");
    let path = places.hooks_file(Agent::Agy, Scope::Home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        r#"{"browser-cleanup":{"Stop":[{"type":"command","command":"reap"}]}}"#,
    )
    .unwrap();

    install(&places, &which(&[Agent::Agy]), false, "tmuxy").unwrap();
    let doc = read_doc(&path).unwrap();
    assert_eq!(doc["browser-cleanup"]["Stop"][0]["command"], "reap");
    assert_eq!(
        doc["tmuxy"]["Stop"][0]["command"],
        hook_command(Agent::Agy, "Stop", "tmuxy")
    );
    assert_eq!(hooked_events(&doc, Agent::Agy), 3);

    uninstall(&places, &which(&[Agent::Agy])).unwrap();
    let doc = read_doc(&path).unwrap();
    assert!(doc.get("tmuxy").is_none());
    assert_eq!(doc["browser-cleanup"]["Stop"][0]["command"], "reap");
}

#[test]
fn codex_hooks_go_in_hooks_json_and_session_end_fits_its_limit() {
    let places = scratch("codex");
    install(&places, &which(&[Agent::Codex]), false, "tmuxy").unwrap();
    let doc = read_doc(&places.codex_home.join("hooks.json")).unwrap();
    assert_eq!(doc["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 3);
    assert_eq!(
        doc["hooks"]["PermissionRequest"][0]["hooks"][0]["command"],
        hook_command(Agent::Codex, "PermissionRequest", "tmuxy")
    );
    assert_eq!(
        places.skill_dir(Agent::Codex, Scope::Home),
        places.home.join(".agents/skills/tmuxy")
    );
}

#[test]
fn a_skill_tmuxy_did_not_write_is_left_alone_unless_forced() {
    let places = scratch("skill");
    let dir = places.skill_dir(Agent::Claude, Scope::Home);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "mine").unwrap();
    let skill_only = Which {
        skill_only: true,
        ..which(&[Agent::Claude])
    };

    install(&places, &skill_only, false, "tmuxy").unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        "mine"
    );
    uninstall(&places, &skill_only).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        "mine"
    );

    install(&places, &skill_only, true, "tmuxy").unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        SKILL
    );
    assert_eq!(
        std::fs::read_to_string(backup_path(&dir).join("SKILL.md")).unwrap(),
        "mine"
    );
    assert!(matches!(skill_state(&dir), SkillState::Ours(v) if v == VERSION));

    uninstall(&places, &skill_only).unwrap();
    assert!(!dir.exists());
}

#[cfg(unix)]
#[test]
fn a_settings_file_that_is_a_symlink_stays_one() {
    let places = scratch("symlink");
    let path = places.hooks_file(Agent::Claude, Scope::Home);
    let real = places.home.join("dotfiles/claude-settings.json");
    std::fs::create_dir_all(real.parent().unwrap()).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&real, "{\"theme\": \"dark\"}\n").unwrap();
    std::os::unix::fs::symlink(&real, &path).unwrap();

    install(&places, &which(&[Agent::Claude]), false, "tmuxy").unwrap();
    assert!(std::fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(hooked_events(&read_doc(&real).unwrap(), Agent::Claude), 8);
}

#[test]
fn a_file_that_is_not_json_is_refused_untouched() {
    let places = scratch("broken");
    let path = places.hooks_file(Agent::Claude, Scope::Home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{ not json").unwrap();
    assert!(install(&places, &which(&[Agent::Claude]), false, "tmuxy").is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
}
