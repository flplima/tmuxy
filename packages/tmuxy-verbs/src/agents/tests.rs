use serde_json::json;

use super::*;

/// Every place an agent's config is read from or written to, under one
/// fresh directory in the system's temp dir: never the developer's own
/// `~/.claude`, `~/.codex` or `~/.agents`, which every agent on the machine
/// is reading right now. `write_doc` and the skill writes refuse anything
/// outside the temp dir in a test as well.
fn scratch(name: &str) -> Places {
    let root = std::env::temp_dir().join(format!("tmuxy-agents-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let places = Places {
        claude_dir: root.join("home/.claude"),
        codex_home: root.join("home/.codex"),
        home: root.join("home"),
        cwd: root.join("project"),
        path: None,
    };
    for dir in [
        &places.claude_dir,
        &places.codex_home,
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
    let path = places.hooks_file(Agent::Agy, Scope::Home);
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
    let path = places.hooks_file(Agent::Claude, Scope::Home);
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
    assert_eq!(hooked_events(&read_doc(&real).unwrap(), Agent::Claude), 8);
}

#[test]
fn a_file_that_is_not_json_is_refused_untouched() {
    let places = scratch("broken");
    let path = places.hooks_file(Agent::Claude, Scope::Home);
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
    for agent in ALL {
        assert!(
            tmuxy_core::host::socket_watch::agent_screen::is_agent(agent.name()),
            "{}",
            agent.name()
        );
    }
}

/// What `status` says of each of an agent's two items, as words.
fn items(places: &Places, agent: Agent) -> (String, String) {
    let read = status(&mut String::new(), places, &[agent], Scope::Home);
    (read[0].hooks.said(), read[0].skill.said())
}

#[test]
fn status_says_missing_then_current_after_an_install() {
    let places = scratch("status-current");
    for agent in ALL {
        assert_eq!(items(&places, agent), ("missing".into(), "missing".into()));
    }
    install(&mut String::new(), &places, &which(&ALL), false, "tmuxy").unwrap();
    for agent in ALL {
        assert_eq!(
            items(&places, agent),
            ("current".into(), "current".into()),
            "{agent:?}"
        );
    }
}

/// A hook path chosen with `--hook-command` is still the install's own.
#[test]
fn hooks_installed_with_another_tmuxy_path_are_current() {
    let places = scratch("status-path");
    let path = "/Applications/tmuxy app/tmuxy";
    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Claude]),
        false,
        path,
    )
    .unwrap();
    assert_eq!(items(&places, Agent::Claude).0, "current");
}

/// The skill's text changes between two builds of one version (a dev build,
/// an update from main): the version alone said "installed" over old text.
#[test]
fn a_skill_whose_text_changed_is_outdated_and_an_install_makes_it_current() {
    let places = scratch("status-skill");
    let skill_only = Which {
        skill_only: true,
        ..which(&[Agent::Claude])
    };
    install(&mut String::new(), &places, &skill_only, false, "tmuxy").unwrap();
    let dir = places.skill_dir(Agent::Claude, Scope::Home);
    std::fs::write(dir.join("SKILL.md"), "an older text").unwrap();
    assert_eq!(
        items(&places, Agent::Claude).1,
        "outdated: the skill's text changed"
    );

    std::fs::write(dir.join(".tmuxy-version"), "0.0.1\n").unwrap();
    assert_eq!(
        items(&places, Agent::Claude).1,
        format!("outdated: written by 0.0.1, this is {VERSION}")
    );

    let mut out = String::new();
    install(&mut out, &places, &skill_only, false, "tmuxy").unwrap();
    assert!(out.contains("installed"), "{out}");
    assert_eq!(items(&places, Agent::Claude).1, "current");
}

#[test]
fn hooks_that_lost_an_event_or_changed_a_setting_are_outdated() {
    let places = scratch("status-hooks");
    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Claude]),
        false,
        "tmuxy",
    )
    .unwrap();
    let path = places.hooks_file(Agent::Claude, Scope::Home);

    let mut doc = read_doc(&path).unwrap();
    doc["hooks"].as_object_mut().unwrap().remove("Stop");
    write_doc(&path, &doc).unwrap();
    let all = Agent::Claude.hooks().len();
    assert_eq!(
        items(&places, Agent::Claude).0,
        format!("outdated: {} of {all} events", all - 1)
    );

    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Claude]),
        false,
        "tmuxy",
    )
    .unwrap();
    let mut doc = read_doc(&path).unwrap();
    doc["hooks"]["SessionStart"][0]["hooks"][0]["timeout"] = json!(60);
    write_doc(&path, &doc).unwrap();
    assert_eq!(
        items(&places, Agent::Claude).0,
        "outdated: the events or their settings changed"
    );
}

#[test]
fn a_skill_tmuxy_did_not_write_is_foreign_and_a_broken_file_unreadable() {
    let places = scratch("status-foreign");
    let dir = places.skill_dir(Agent::Codex, Scope::Home);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "mine").unwrap();
    let path = places.hooks_file(Agent::Codex, Scope::Home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{ not json").unwrap();
    let (hooks, skill) = items(&places, Agent::Codex);
    assert!(hooks.starts_with("unreadable: "), "{hooks}");
    assert_eq!(skill, "foreign: not written by tmuxy");
}

/// A dry run says what an install would do to each item, and writes nothing.
#[test]
fn a_dry_run_says_installed_updated_or_up_to_date() {
    let places = scratch("dry-run");
    let dry = Which {
        dry_run: true,
        ..which(&[Agent::Claude])
    };
    let said = |places: &Places| {
        let mut out = String::new();
        install(&mut out, places, &dry, false, "tmuxy").unwrap();
        out
    };
    let first = said(&places);
    assert_eq!(first.matches("would be installed").count(), 2, "{first}");
    assert!(!places.hooks_file(Agent::Claude, Scope::Home).exists());

    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Claude]),
        false,
        "tmuxy",
    )
    .unwrap();
    let again = said(&places);
    assert_eq!(again.matches("up to date").count(), 1, "{again}");

    let dir = places.skill_dir(Agent::Claude, Scope::Home);
    std::fs::write(dir.join("SKILL.md"), "an older text").unwrap();
    let changed = said(&places);
    assert!(
        changed.contains("skill") && changed.contains("would be updated"),
        "{changed}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        "an older text"
    );
}

#[test]
fn status_in_json_names_each_items_path_state_and_why() {
    let places = scratch("status-json");
    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Codex]),
        false,
        "tmuxy",
    )
    .unwrap();
    let read = status(&mut String::new(), &places, &[Agent::Codex], Scope::Home);
    assert_eq!(
        read[0].json(),
        json!({
            "agent": "codex",
            "found": true,
            "hooks": { "path": "~/.codex/hooks.json", "state": "current", "why": null },
            "skill": { "path": "~/.agents/skills/tmuxy", "state": "current", "why": null },
        })
    );
}

/// The guard that keeps a test off the developer's own agent config.
#[test]
#[should_panic(expected = "a test wrote outside the temp dir")]
fn a_test_cannot_write_outside_the_temp_dir() {
    let outside = std::env::current_dir()
        .unwrap()
        .join("not-a-real-settings.json");
    let _ = write_doc(&outside, &serde_json::Map::new());
}
