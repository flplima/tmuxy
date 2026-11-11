use super::*;

fn keys(words: &[&str]) -> Vec<String> {
    words.iter().map(|w| w.to_string()).collect()
}

fn rules(json: &str) -> Permissions {
    Permissions::parse(json).unwrap_or_else(|e| panic!("the test's file did not parse: {e}"))
}

/// What `file` says of `caller` typing `typed` into a pane running zsh.
fn says(file: &Permissions, caller: &str, typed: &[&str]) -> Decision {
    file.check_send(Send {
        callers: &[caller],
        program: "zsh",
        keys: &keys(typed),
        paste: false,
    })
}

const FILE: &str = r#"{
  "callers": {
    "claude": {
      "allow": ["Send(gh *)", "Send(npm test)"],
      "ask":   ["Send(gh pr merge *)"],
      "deny":  ["Send(rm *)", "Send(sudo *)", "Send(gh repo delete *)"]
    },
    "*": { "deny": ["Send(shutdown *)"] }
  }
}"#;

#[test]
fn a_rule_of_each_list_decides_the_send_it_matches() {
    let file = rules(FILE);
    assert_eq!(
        says(&file, "claude", &["gh pr list", "Enter"]),
        Decision::Allow("allowed by `Send(gh *)` (callers.claude)".into())
    );
    assert_eq!(
        says(&file, "claude", &["npm test", "Enter"]),
        Decision::Allow("allowed by `Send(npm test)` (callers.claude)".into())
    );
    assert_eq!(
        says(&file, "claude", &["rm -rf build", "Enter"]),
        Decision::Deny("denied by `Send(rm *)` (callers.claude)".into())
    );
    assert_eq!(
        says(&file, "claude", &["gh pr merge 12", "Enter"]),
        Decision::Ask("asked by `Send(gh pr merge *)` (callers.claude)".into())
    );
}

/// deny over ask over allow, whatever order the lists are in and whichever
/// section each rule sits in.
#[test]
fn deny_beats_ask_beats_allow() {
    let file = rules(FILE);
    // `gh *` allows it, `gh pr merge *` asks: ask wins.
    assert_eq!(
        says(&file, "claude", &["gh pr merge 7", "Enter"]).word(),
        "ask"
    );
    // `gh *` allows it, `gh repo delete *` denies: deny wins.
    assert_eq!(
        says(&file, "claude", &["gh repo delete x", "Enter"]).word(),
        "deny"
    );
    // All three match: deny wins.
    let all = rules(
        r#"{"callers": {"a": {"allow": ["Send(x *)"], "ask": ["Send(x *)"], "deny": ["Send(x *)"]}}}"#,
    );
    assert_eq!(says(&all, "a", &["x y", "Enter"]).word(), "deny");
    // A deny under `*` beats an allow under the caller's own name.
    let across = rules(
        r#"{"callers": {"a": {"allow": ["Send(make *)"]}, "*": {"deny": ["Send(make install)"]}}}"#,
    );
    assert_eq!(
        says(&across, "a", &["make install", "Enter"]).word(),
        "deny"
    );
    assert_eq!(says(&across, "a", &["make test", "Enter"]).word(), "allow");
    // And an ask under the caller's own name beats an allow under `*`.
    let other_way = rules(
        r#"{"callers": {"a": {"ask": ["Send(make install)"]}, "*": {"allow": ["Send(make *)"]}}}"#,
    );
    assert_eq!(
        says(&other_way, "a", &["make install", "Enter"]).word(),
        "ask"
    );
}

#[test]
fn a_command_no_rule_matches_is_asked() {
    let file = rules(FILE);
    assert_eq!(
        says(&file, "claude", &["cargo build", "Enter"]),
        Decision::Ask("no rule matches".into())
    );
    // A pattern without `*` is the whole command, not its beginning.
    assert_eq!(
        says(&file, "claude", &["npm test --watch", "Enter"]).word(),
        "ask"
    );
    assert_eq!(says(&file, "claude", &["npm testx", "Enter"]).word(), "ask");
    // `gh *` is `gh` and an argument: not a program that starts with gh.
    assert_eq!(says(&file, "claude", &["ghost", "Enter"]).word(), "ask");
    assert_eq!(says(&file, "claude", &["gh", "Enter"]).word(), "ask");
}

#[test]
fn the_star_section_binds_every_caller_and_a_named_one_only_its_own() {
    let file = rules(FILE);
    // A caller the file does not name is bound by `*` alone.
    assert_eq!(
        says(&file, "codex", &["shutdown now", "Enter"]),
        Decision::Deny("denied by `Send(shutdown *)` (callers.*)".into())
    );
    assert_eq!(says(&file, "codex", &["rm -rf x", "Enter"]).word(), "ask");
    assert_eq!(
        says(&file, "claude", &["shutdown now", "Enter"]).word(),
        "deny"
    );
    // With no `*` and no section of its own, the file has nothing to say.
    let named_only = rules(r#"{"callers": {"claude": {"deny": ["Send(rm *)"]}}}"#);
    assert_eq!(
        says(&named_only, "codex", &["rm -rf x", "Enter"]),
        Decision::NoOpinion
    );
    // A section with no rules binds nobody.
    let empty = rules(r#"{"callers": {"claude": {}, "*": {"deny": []}}}"#);
    assert_eq!(
        says(&empty, "claude", &["rm -rf x", "Enter"]),
        Decision::NoOpinion
    );
    assert_eq!(
        says(&rules("{}"), "claude", &["rm x", "Enter"]),
        Decision::NoOpinion
    );
}

/// An MCP client answers to its own name and to `mcp`.
#[test]
fn a_caller_is_bound_by_every_name_it_answers_to() {
    let file = rules(r#"{"callers": {"mcp": {"deny": ["Send(rm *)"]}}}"#);
    let send = |callers: &[&str]| {
        file.check_send(Send {
            callers,
            program: "bash",
            keys: &keys(&["rm x", "Enter"]),
            paste: false,
        })
        .word()
    };
    assert_eq!(send(&["some-client", "mcp"]), "deny");
    assert_eq!(send(&["some-client"]), "none");
}

/// The rules are about commands, and a command is one where a shell reads
/// it. Text typed into an editor or an agent's prompt is not theirs to judge.
#[test]
fn only_a_shell_in_the_target_pane_makes_keys_a_command() {
    let file = rules(FILE);
    let into = |file: &Permissions, program: &str| {
        file.check_send(Send {
            callers: &["claude"],
            program,
            keys: &keys(&["rm -rf x", "Enter"]),
            paste: false,
        })
        .word()
    };
    for shell in DEFAULT_SHELLS {
        assert_eq!(into(&file, shell), "deny", "{shell}");
    }
    assert_eq!(into(&file, "vim"), "none");
    assert_eq!(into(&file, "claude"), "none");
    assert_eq!(into(&file, ""), "none");
    // The file's own list replaces the default one.
    let own = rules(r#"{"callers": {"claude": {"deny": ["Send(rm *)"]}}, "shells": ["xonsh"]}"#);
    assert_eq!(into(&own, "xonsh"), "deny");
    assert_eq!(into(&own, "zsh"), "none");
}

/// What is not text and then exactly one Enter is not a command the rules
/// can match, and is asked: a deny rule must not be walked around by typing
/// the line in two sends, or by spelling Enter another way.
#[test]
fn keys_that_are_not_one_command_are_asked() {
    let file = rules(FILE);
    let not_a_command: &[&[&str]] = &[
        &["rm -rf x"],
        &["Enter"],
        &["rm -rf x", "C-m"],
        &["rm -rf x", "KPEnter"],
        &["rm -rf x", "Enter", "Enter"],
        &["rm -rf x", "Enter", "y", "Enter"],
        &["rm -rf x\n"],
        &["C-c"],
        &["q"],
        &["rm ", "Up", "Enter"],
        &["rm ", "up", "Enter"],
        &["rm ", "C-v", "Enter"],
        &["rm ", "^C", "Enter"],
        &["rm ", "0x41", "Enter"],
        &["rm ", "Space", "-rf x", "Enter"],
        &["rm ", "MouseDown1Pane", "Enter"],
        &["   ", "Enter"],
    ];
    for typed in not_a_command {
        assert_eq!(
            says(&file, "claude", typed),
            Decision::Ask("not one command ending in Enter, so the rules cannot judge it".into()),
            "{typed:?}"
        );
        assert_eq!(command_of(&keys(typed)), None, "{typed:?}");
    }
    // Several pieces of text are one line, as send-keys types them: nothing
    // goes between them.
    assert_eq!(
        command_of(&keys(&["rm", " -rf", " x", "Enter"])).as_deref(),
        Some("rm -rf x")
    );
    assert_eq!(
        says(&file, "claude", &["rm", " -rf x", "Enter"]).word(),
        "deny"
    );
    assert_eq!(says(&file, "claude", &["r", "m x", "Enter"]).word(), "deny");
}

#[test]
fn a_paste_is_never_a_command() {
    let file = rules(FILE);
    let pasted = file.check_send(Send {
        callers: &["claude"],
        program: "zsh",
        keys: &keys(&["gh pr list", "Enter"]),
        paste: true,
    });
    assert_eq!(pasted.word(), "ask");
}

/// A line that may hold a second command is asked whatever the rules say of
/// its first word: `gh pr list; rm -rf ~` matches `Send(gh *)`.
#[test]
fn a_line_with_a_shell_operator_is_asked_even_when_a_rule_allows_it() {
    let file = rules(FILE);
    for line in [
        "gh pr list; rm -rf x",
        "gh pr list && rm -rf x",
        "gh pr list || rm -rf x",
        "gh pr list | sh",
        "gh pr list &",
        "gh pr list > ~/.zshrc",
        "gh api < secret",
        "gh pr view $(cat x)",
        "gh pr view `cat x`",
        "gh pr list <(x)",
        "gh !!",
        "gh pr list \"a;b\"",
    ] {
        let decision = says(&file, "claude", &[line, "Enter"]);
        assert_eq!(decision.word(), "ask", "{line}");
        assert!(decision.reason().contains("may be more than"), "{line}");
    }
    // It is asked, not denied, even where the first command is denied: the
    // user sees the whole line and answers.
    assert_eq!(says(&file, "claude", &["rm x; ls", "Enter"]).word(), "ask");
}

#[test]
fn spacing_is_not_a_way_around_a_rule() {
    let file = rules(FILE);
    for line in ["rm    -rf   x", "  rm -rf x  ", "rm\t-rf x", "sudo\t\tls"] {
        assert_eq!(
            says(&file, "claude", &[line, "Enter"]).word(),
            "deny",
            "{line:?}"
        );
    }
    // And a rule's own spacing is read the same way.
    let spaced = rules(r#"{"callers": {"*": {"deny": ["  Send(  rm   * )  "]}}}"#);
    assert_eq!(says(&spaced, "x", &["rm y", "Enter"]).word(), "deny");
}

#[test]
fn a_star_is_any_run_of_characters_anywhere_in_the_pattern() {
    for (pattern, text, matches) in [
        ("*", "", true),
        ("*", "anything at all", true),
        ("gh *", "gh pr list", true),
        ("gh *", "gh ", true),
        ("gh *", "gh", false),
        ("* --force", "git push --force", true),
        ("* --force", "git push --force-with-lease", false),
        ("git * main", "git push origin main", true),
        ("git * main", "git main", false),
        ("git*main", "gitmain", true),
        ("a*b*c", "aXbYc", true),
        ("a*b*c", "aXbY", false),
        ("a**b", "ab", true),
        ("npm test", "npm test", true),
        ("npm test", "npm tes", false),
        ("", "", true),
        ("", "x", false),
        ("é*", "été", true),
    ] {
        assert_eq!(glob(pattern, text), matches, "{pattern:?} against {text:?}");
    }
}

/// A file that cannot be read as rules is an error with its reason: it is
/// never read as fewer rules than the user wrote.
#[test]
fn a_file_that_is_not_rules_is_refused_with_the_reason() {
    for (text, reason) in [
        ("", "not JSON"),
        ("{", "not JSON"),
        ("[]", "the file must hold one JSON object"),
        ("null", "the file must hold one JSON object"),
        (r#"{"caller": {}}"#, "unknown key `caller`"),
        (r#"{"callers": []}"#, "`callers` must be an object"),
        (r#"{"callers": {"a": []}}"#, "callers.a must be an object"),
        (
            r#"{"callers": {"a": {"alow": []}}}"#,
            "callers.a: unknown key `alow`",
        ),
        (
            r#"{"callers": {"a": {"deny": "Send(rm *)"}}}"#,
            "callers.a.deny must be a list of strings",
        ),
        (
            r#"{"callers": {"a": {"deny": [1]}}}"#,
            "callers.a.deny must be a list of strings",
        ),
        (
            r#"{"callers": {"": {"deny": []}}}"#,
            "a caller's name is empty",
        ),
        (
            r#"{"callers": {"a": {"deny": ["rm *"]}}}"#,
            "is not of the form Send(<pattern>)",
        ),
        (
            r#"{"callers": {"a": {"deny": ["Send(rm *"]}}}"#,
            "is not of the form Send(<pattern>)",
        ),
        (
            r#"{"callers": {"a": {"deny": ["Send()"]}}}"#,
            "has an empty pattern",
        ),
        (
            r#"{"callers": {"a": {"deny": ["send(rm *)"]}}}"#,
            "only Send(...) rules are understood",
        ),
        (
            r#"{"callers": {"a": {"deny": ["destroy(any)"]}}}"#,
            "only Send(...) rules are understood",
        ),
        (
            r#"{"callers": {"a": {"allow": ["read(tab)"]}}}"#,
            "only Send(...) rules are understood",
        ),
        (r#"{"shells": "zsh"}"#, "`shells` must be a list of strings"),
        (
            r#"{"shells": ["zsh", " "]}"#,
            "`shells` holds an empty name",
        ),
    ] {
        let error = Permissions::parse(text).expect_err(text);
        assert!(error.contains(reason), "{text}: {error}");
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tmuxy-permissions-test-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// No file is the one case that leaves tmuxy as it is without the feature.
/// Every other way of not reading rules denies, and says why.
#[test]
fn a_missing_file_says_nothing_and_an_unreadable_one_denies() {
    let dir = scratch("load");
    let path = dir.join("permissions.json");
    let send = Send {
        callers: &["anyone"],
        // Not a shell, and no rule could bind this caller: a readable file
        // would have nothing to say. An unreadable one still denies.
        program: "vim",
        keys: &keys(&["i"]),
        paste: false,
    };

    assert_eq!(Loaded::read(&path), Loaded::Missing);
    assert_eq!(Loaded::read(&path).check_send(send), Decision::NoOpinion);

    std::fs::write(&path, r#"{"callers": {"a": {"deny": ["Send(rm *)"]}}}"#).unwrap();
    assert!(matches!(Loaded::read(&path), Loaded::Rules(_)));
    assert_eq!(Loaded::read(&path).check_send(send), Decision::NoOpinion);

    std::fs::write(&path, r#"{"callers": {"a": {"deny": ["rm *"]}}}"#).unwrap();
    let decision = Loaded::read(&path).check_send(send);
    assert_eq!(decision.word(), "deny");
    assert!(
        decision.reason().contains("cannot be read as rules"),
        "{decision:?}"
    );
    assert!(
        decision
            .reason()
            .contains("is not of the form Send(<pattern>)"),
        "{decision:?}"
    );

    // Bytes that are not text, a directory in the file's place, a link to
    // nothing and a file too large to be rules: each denies.
    std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
    assert_eq!(Loaded::read(&path).check_send(send).word(), "deny");
    std::fs::write(&path, vec![b' '; (MAX_FILE_BYTES + 1) as usize]).unwrap();
    assert!(matches!(Loaded::read(&path), Loaded::Malformed(why) if why.contains("larger than")));
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(
        matches!(Loaded::read(&path), Loaded::Malformed(why) if why.contains("not a regular file"))
    );
    std::fs::remove_dir(&path).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.join("nowhere.json"), &path).unwrap();
        assert!(matches!(Loaded::read(&path), Loaded::Malformed(why) if why.contains("link")));
        // A link to a real file is how a dotfiles repo keeps it: read through.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(dir.join("real.json"), "{}").unwrap();
        std::os::unix::fs::symlink(dir.join("real.json"), &path).unwrap();
        assert!(matches!(Loaded::read(&path), Loaded::Rules(_)));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The file is read when it is asked, every time: an edit holds from the
/// next send on, with nothing to reload.
#[test]
fn an_edit_holds_from_the_next_read() {
    let dir = scratch("edit");
    let path = dir.join("permissions.json");
    let typed = keys(&["rm x", "Enter"]);
    let send = Send {
        callers: &["a"],
        program: "sh",
        keys: &typed,
        paste: false,
    };
    std::fs::write(&path, r#"{"callers": {"a": {"allow": ["Send(rm *)"]}}}"#).unwrap();
    assert_eq!(Loaded::read(&path).check_send(send).word(), "allow");
    std::fs::write(&path, r#"{"callers": {"a": {"deny": ["Send(rm *)"]}}}"#).unwrap();
    assert_eq!(Loaded::read(&path).check_send(send).word(), "deny");
    let _ = std::fs::remove_dir_all(&dir);
}
