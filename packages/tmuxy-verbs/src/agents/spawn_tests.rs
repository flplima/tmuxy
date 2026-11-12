use super::*;

fn argv(
    agent: SpawnAgent,
    prompt: Option<&str>,
    mode: Option<&str>,
    command: &[&str],
) -> Result<Vec<String>, String> {
    let command: Vec<String> = command.iter().map(|w| w.to_string()).collect();
    agent_argv(agent, prompt, mode, &command)
}

#[test]
fn each_agent_takes_its_task_its_own_way() {
    assert_eq!(
        argv(SpawnAgent::Claude, Some("-fix the tests"), None, &[]).unwrap(),
        ["claude", "--", "-fix the tests"]
    );
    assert_eq!(
        argv(SpawnAgent::Codex, Some("review"), None, &[]).unwrap(),
        ["codex", "--", "review"]
    );
    assert_eq!(
        argv(SpawnAgent::Gemini, Some("explain"), None, &[]).unwrap(),
        ["gemini", "--prompt-interactive", "explain"]
    );
    assert_eq!(
        argv(SpawnAgent::Claude, None, None, &[]).unwrap(),
        ["claude"]
    );
}

/// Spawn never adds a permission flag: only one the caller names, as
/// written, under the agent's own option.
#[test]
fn a_permission_mode_is_passed_only_when_named() {
    for agent in [SpawnAgent::Claude, SpawnAgent::Codex, SpawnAgent::Gemini] {
        let plain = argv(agent, Some("task"), None, &[]).unwrap();
        assert!(
            !plain.iter().any(|w| w.contains("permission")
                || w.contains("approval")
                || w.contains("dangerously")
                || w.contains("yolo")),
            "{plain:?}"
        );
    }
    assert_eq!(
        argv(SpawnAgent::Claude, Some("t"), Some("plan"), &[]).unwrap(),
        ["claude", "--permission-mode", "plan", "--", "t"]
    );
    assert_eq!(
        argv(SpawnAgent::Codex, None, Some("on-request"), &[]).unwrap(),
        ["codex", "--ask-for-approval", "on-request"]
    );
    assert_eq!(
        argv(SpawnAgent::Gemini, None, Some("auto_edit"), &[]).unwrap(),
        ["gemini", "--approval-mode", "auto_edit"]
    );
    assert!(argv(SpawnAgent::Claude, None, Some("plan --yolo"), &[]).is_err());
    assert!(argv(SpawnAgent::Claude, None, Some(""), &[]).is_err());
}

#[test]
fn cmd_runs_the_command_as_it_is_and_nothing_else() {
    assert_eq!(
        argv(SpawnAgent::Cmd, None, None, &["aider", "--model", "x"]).unwrap(),
        ["aider", "--model", "x"]
    );
    assert!(argv(SpawnAgent::Cmd, None, None, &[]).is_err());
    assert!(argv(SpawnAgent::Cmd, Some("task"), None, &["aider"]).is_err());
    assert!(argv(SpawnAgent::Cmd, None, Some("plan"), &["aider"]).is_err());
    assert!(argv(SpawnAgent::Claude, None, None, &["claude"]).is_err());
}

#[test]
fn a_long_task_is_refused() {
    let long = "x".repeat(MAX_PROMPT_BYTES + 1);
    assert!(argv(SpawnAgent::Claude, Some(&long), None, &[]).is_err());
}

#[test]
fn the_wrapper_cleans_up_and_becomes_the_agent_with_every_word_quoted() {
    let script = wrapper(
        Path::new("/tmp/tmuxy-spawn.1"),
        &["claude".into(), "--".into(), "it's $(rm -rf ~) #{x}".into()],
    );
    assert_eq!(
        script,
        "rm -rf -- /tmp/tmuxy-spawn.1\nexec claude -- 'it'\\''s $(rm -rf ~) #{x}'\n"
    );
}

#[test]
fn the_pane_goes_in_the_callers_tab_and_the_focus_stays() {
    let script = Path::new("/tmp/d/spawn.sh");
    assert_eq!(
        place_argv(Place::Stack, "%3", None, false, script),
        [
            "set-option",
            "-w",
            "-t",
            "%3",
            "@tmuxy-collapsible",
            "1",
            ";",
            "split-window",
            "-v",
            "-f",
            "-d",
            "-t",
            "%3",
            "-c",
            "#{pane_current_path}",
            "-P",
            "-F",
            "#{pane_id}",
            "sh /tmp/d/spawn.sh",
        ]
    );
    let split = place_argv(Place::Split, "%3", Some(Path::new("/w")), true, script);
    assert_eq!(&split[..2], ["split-window", "-v"]);
    assert!(
        !split.contains(&"-d".to_string()),
        "--focus moves the focus"
    );
    assert!(!split.contains(&"-f".to_string()));
    assert!(split.windows(2).any(|w| w == ["-c", "/w"]));
}

#[test]
fn the_new_pane_is_tagged_with_its_spawner_agent_and_label() {
    assert_eq!(
        tag_argv("%9", "%3", "claude", Some("fix-a")).join(" "),
        "set-option -p -t %9 @tmuxy-spawned-by %3 ; set-option -p -t %9 @tmuxy-agent claude ; \
         set-option -p -t %9 @tmuxy-label fix-a ; select-pane -t %9 -T fix-a"
    );
    assert!(!tag_argv("%9", "%3", "codex", None).contains(&"@tmuxy-label".to_string()));
}
