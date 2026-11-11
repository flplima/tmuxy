//! `tmuxy agent status` and the agents that take the skill alone: each
//! item against what an install writes now, and where it goes.

use serde_json::json;

use super::tests::{scratch, which};
use super::*;

/// What `status` says of each of an agent's two items, as words.
fn items(places: &Places, agent: Agent) -> (String, String) {
    let read = status(&mut String::new(), places, &[agent], Scope::Home);
    (read[0].hooks.said(), read[0].skill.said())
}

#[test]
fn status_says_missing_then_current_after_an_install() {
    let places = scratch("status-current");
    let hooks = |agent: Agent, state: &str| {
        if agent.hooks().is_empty() {
            "unsupported".to_string()
        } else {
            state.to_string()
        }
    };
    for agent in ALL {
        assert_eq!(
            items(&places, agent),
            (hooks(agent, "missing"), "missing".into())
        );
    }
    install(&mut String::new(), &places, &which(&ALL), false, "tmuxy").unwrap();
    for agent in ALL {
        assert_eq!(
            items(&places, agent),
            (hooks(agent, "current"), "current".into()),
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
    let dir = places.skill_dir(Agent::Claude, Scope::Home).unwrap();
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
    let path = places.hooks_file(Agent::Claude, Scope::Home).unwrap();

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
    let dir = places.skill_dir(Agent::Codex, Scope::Home).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "mine").unwrap();
    let path = places.hooks_file(Agent::Codex, Scope::Home).unwrap();
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
    assert!(!places
        .hooks_file(Agent::Claude, Scope::Home)
        .unwrap()
        .exists());

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

    let dir = places.skill_dir(Agent::Claude, Scope::Home).unwrap();
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

/// OpenCode, Pi and Crush keep their hooks in code, so they get the skill
/// alone, each in its own folder, and status says so of their hooks.
#[test]
fn skill_only_agents_get_the_skill_in_their_own_folders() {
    let places = scratch("skill-only");
    let agents = [Agent::Opencode, Agent::Pi, Agent::Crush];
    let mut out = String::new();
    install(&mut out, &places, &which(&agents), false, "tmuxy").unwrap();
    for (agent, folder) in [
        (Agent::Opencode, ".config/opencode/skills/tmuxy"),
        (Agent::Pi, ".pi/agent/skills/tmuxy"),
        (Agent::Crush, ".config/crush/skills/tmuxy"),
    ] {
        let dir = places.home.join(folder);
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            SKILL
        );
        assert_eq!(places.skill_dir(agent, Scope::Home), Some(dir));
        assert_eq!(places.hooks_file(agent, Scope::Home), None);
        assert!(
            out.contains(&format!("{:<8} hooks  unsupported", agent.name())),
            "{out}"
        );
    }
    // Nothing was written outside the three skill folders.
    assert!(!places.home.join(".claude").exists());
    assert!(!places.home.join(".codex").exists());

    uninstall(&mut String::new(), &places, &which(&agents)).unwrap();
    for agent in agents {
        assert_eq!(
            items(&places, agent),
            ("unsupported".into(), "missing".into())
        );
    }
}

/// Pi and Crush document no project skill folder, so a project install
/// leaves them out rather than guess one.
#[test]
fn a_project_install_is_unsupported_where_the_agent_reads_no_project_skills() {
    let places = scratch("skill-only-project");
    let project = Which {
        project: true,
        ..which(&[Agent::Opencode, Agent::Pi, Agent::Crush])
    };
    let mut out = String::new();
    install(&mut out, &places, &project, false, "tmuxy").unwrap();
    assert!(places.cwd.join(".opencode/skills/tmuxy/SKILL.md").is_file());
    assert!(out.contains("pi       skill  unsupported"), "{out}");
    assert!(out.contains("crush    skill  unsupported"), "{out}");
    let read = status(&mut String::new(), &places, &[Agent::Crush], Scope::Project);
    assert_eq!(
        read[0].json(),
        json!({
            "agent": "crush",
            "found": false,
            "hooks": { "path": null, "state": "unsupported", "why": null },
            "skill": { "path": null, "state": "unsupported", "why": null },
        })
    );
}

/// `CRUSH_SKILLS_DIR` moves Crush's skills, as Crush itself reads it.
#[test]
fn crushs_skills_follow_its_own_variable() {
    let mut places = scratch("crush-dir");
    places.crush_skills = places.home.join("elsewhere");
    install(
        &mut String::new(),
        &places,
        &which(&[Agent::Crush]),
        false,
        "tmuxy",
    )
    .unwrap();
    assert!(places.home.join("elsewhere/tmuxy/SKILL.md").is_file());
}
