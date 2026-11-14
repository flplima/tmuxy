use super::*;

#[test]
fn a_file_names_its_agent_and_gives_states_for_text() {
    let agent = parse(
        "gemini",
        "[[rule]]\nmatch = 'Waiting for your reply'\nstate = \"needs-input\"\n\
         [[rule]]\nmatch = '(?i)error:'\nstate = \"error\"\n",
    )
    .unwrap();
    assert_eq!(agent.command, "gemini");
    assert_eq!(agent.rules.len(), 2);
    let rules = UserRules {
        agents: vec![agent],
        ..UserRules::default()
    };
    assert!(rules.knows("gemini"));
    let hit = rules
        .matching("gemini", "work\nWaiting for your reply\n")
        .unwrap();
    assert_eq!(hit.state, PaneStateName::NeedsInput);
    assert_eq!(
        rules.matching("gemini", "ERROR: no network").unwrap().state,
        PaneStateName::Error
    );
    assert!(rules.matching("gemini", "all good").is_none());
    assert!(
        rules.matching("aider", "Waiting for your reply").is_none(),
        "another agent's rules"
    );
}

#[test]
fn command_names_an_agent_the_file_is_not_named_after() {
    let agent = parse("mine", "command = \"my-agent\"\n").unwrap();
    assert_eq!(agent.command, "my-agent");
    assert!(agent.rules.is_empty());
}

#[test]
fn a_bad_file_is_refused_with_why() {
    let refused = |text: &str| parse("x", text).unwrap_err();
    assert!(refused("[[rule]]\nmatch = 'a'\nstate = \"done\"\n").contains("is not one of"));
    assert!(refused("[[rule]]\nmatch = '('\nstate = \"idle\"\n").starts_with("rule 1:"));
    assert!(refused("colour = 1\n").contains("unknown field"));
    assert!(parse("x", "command = \"node\"\n")
        .unwrap_err()
        .contains("is an interpreter"));
    assert!(parse("python3", "")
        .unwrap_err()
        .contains("is an interpreter"));
    assert_eq!(
        parse("claude", "").unwrap_err(),
        "claude has hooks, which own its state"
    );
}

/// The pattern is the user's and the text is any pane's output: a pattern
/// that would explode a backtracking engine, and one that would cost a lot
/// to build, against a screen of hostile lines.
#[test]
fn a_hostile_pattern_or_screen_costs_little() {
    let blowup = parse(
        "x",
        "[[rule]]\nmatch = '(a*)*(a*)*(a*)*b'\nstate = \"idle\"\n",
    )
    .unwrap();
    let rules = UserRules {
        agents: vec![blowup],
        ..UserRules::default()
    };
    let screen = format!("{}\n", "a".repeat(1_000_000)).repeat(40);
    // A backtracking engine takes years on this; a linear one takes
    // milliseconds. The bound is far from both, so a slow runner passes and
    // a blowup still fails.
    let started = std::time::Instant::now();
    assert!(rules.matching("x", &screen).is_none());
    assert!(
        started.elapsed() < std::time::Duration::from_secs(30),
        "took {:?}",
        started.elapsed()
    );

    let huge = parse(
        "x",
        "[[rule]]\nmatch = '(a{1000}){1000}'\nstate = \"idle\"\n",
    );
    assert!(
        huge.unwrap_err().starts_with("rule 1:"),
        "refused when built, not when run"
    );
    let long = format!(
        "[[rule]]\nmatch = '{}'\nstate = \"idle\"\n",
        "a".repeat(300)
    );
    assert!(parse("x", &long).unwrap_err().contains("longer than"));
}

#[test]
fn a_rule_reads_only_the_bottom_of_the_screen_and_each_line_cut() {
    let screen = (1..=40)
        .map(|n| format!("line {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let text = bottom(&screen);
    assert!(text.starts_with("line 26\n"), "{text}");
    assert!(text.ends_with("line 40"));
    let long = bottom(&"x".repeat(5000));
    assert_eq!(long.chars().count(), MAX_LINE_CHARS);
}

#[test]
fn a_directory_of_files_is_read_with_what_was_wrong() {
    let dir = std::env::temp_dir().join(format!("tmuxy-user-rules-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("aider.toml"),
        "[[rule]]\nmatch = '^> $'\nstate = \"idle\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("broken.toml"), "[[rule]]\nmatch = 1\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "not a rules file").unwrap();
    let rules = UserRules::read(&dir);
    assert_eq!(rules.agents.len(), 1);
    assert!(rules.knows("aider"));
    assert_eq!(rules.problems.len(), 1);
    assert!(
        rules.problems[0].starts_with("broken.toml: "),
        "{:?}",
        rules.problems
    );
    let _ = std::fs::remove_dir_all(&dir);
}
