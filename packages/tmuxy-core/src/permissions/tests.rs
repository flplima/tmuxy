use super::*;

pub(super) fn keys(words: &[&str]) -> Vec<String> {
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
    // A section with no rules still binds its caller: nothing matches, so
    // the send is asked. Naming a caller is saying the file is about it.
    let empty = rules(r#"{"callers": {"claude": {}}}"#);
    assert_eq!(
        says(&empty, "claude", &["rm -rf x", "Enter"]),
        Decision::Ask("no rule matches".into())
    );
    assert_eq!(
        says(&empty, "codex", &["rm -rf x", "Enter"]),
        Decision::NoOpinion
    );
    let empty_star = rules(r#"{"callers": {"*": {"deny": []}}}"#);
    assert_eq!(says(&empty_star, "codex", &["ls", "Enter"]).word(), "ask");
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

/// A deny rule refuses its text whatever the target pane runs: a shell
/// behind `ssh` or `sudo -s`, a shell the list does not name and an editor
/// all read the same keys. What is not denied there is asked, since only in
/// a listed shell do the rules know what the keys will do. It is never
/// "nothing to say": the options would then decide for a caller the file
/// binds.
#[test]
fn a_target_that_is_not_a_listed_shell_is_denied_or_asked_never_waved_through() {
    let file = rules(FILE);
    let into = |file: &Permissions, program: &str, line: &str| {
        file.check_send(Send {
            callers: &["claude"],
            program,
            keys: &keys(&[line, "Enter"]),
            paste: false,
        })
    };
    for shell in DEFAULT_SHELLS {
        assert_eq!(into(&file, shell, "rm -rf x").word(), "deny", "{shell}");
        assert_eq!(into(&file, shell, "gh pr list").word(), "allow", "{shell}");
    }
    for program in ["ssh", "sudo", "python3", "ksh", "tcsh", "pwsh", "vim", ""] {
        assert_eq!(into(&file, program, "rm -rf x").word(), "deny", "{program}");
        let allowed_in_a_shell = into(&file, program, "gh pr list");
        assert_eq!(allowed_in_a_shell.word(), "ask", "{program}");
        assert!(
            allowed_in_a_shell.reason().contains("not a listed shell"),
            "{program}"
        );
    }
    // The file's own list replaces the default one.
    let own = rules(r#"{"callers": {"claude": {"allow": ["Send(ls)"]}}, "shells": ["xonsh"]}"#);
    assert_eq!(into(&own, "xonsh", "ls").word(), "allow");
    assert_eq!(into(&own, "zsh", "ls").word(), "ask");
}

/// What is not text and then exactly one Enter is not a command an `ask` or
/// `allow` rule can match, and is asked. A `deny` rule is tried all the same,
/// against whatever text the keys hold: typing the line without its Enter,
/// or spelling the Enter another way, does not walk around it.
#[test]
fn keys_that_are_not_one_command_are_asked_unless_a_deny_rule_matches_their_text() {
    let file = rules(FILE);
    let not_a_command: &[(&[&str], &str)] = &[
        (&["gh pr list"], "ask"),
        (&["Enter"], "ask"),
        (&["gh pr list", "C-m"], "ask"),
        (&["gh pr list", "KPEnter"], "ask"),
        (&["gh pr list", "Enter", "Enter"], "ask"),
        (&["gh pr list", "Enter", "y", "Enter"], "ask"),
        (&["gh pr list\n"], "ask"),
        (&["C-c"], "ask"),
        (&["q"], "ask"),
        (&["gh ", "Up", "Enter"], "ask"),
        (&["gh ", "C-v", "Enter"], "ask"),
        (&["gh ", "^C", "Enter"], "ask"),
        (&["gh ", "0x41", "Enter"], "ask"),
        (&["gh ", "Space", "pr list", "Enter"], "ask"),
        (&["gh ", "MouseDown1Pane", "Enter"], "ask"),
        (&["   ", "Enter"], "ask"),
        (&["rm -rf x"], "deny"),
        (&["rm -rf x", "C-m"], "deny"),
        (&["rm -rf x", "KPEnter"], "deny"),
        (&["rm -rf x", "Enter", "y", "Enter"], "deny"),
        (&["rm -rf x\n"], "deny"),
        (&["ls", "Enter", "rm -rf x", "Enter"], "deny"),
        (&["rm ", "Up", "Enter"], "deny"),
        (&["rm", "Space", "-rf x", "Enter"], "deny"),
        (&["rm ", "s-file", "Enter"], "deny"),
    ];
    for (typed, word) in not_a_command {
        let decision = says(&file, "claude", typed);
        assert_eq!(decision.word(), *word, "{typed:?}");
        if *word == "ask" {
            assert_eq!(
                decision.reason(),
                "not one command ending in Enter, so the rules cannot judge it",
                "{typed:?}"
            );
        }
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

/// A paste is never one command, so no rule allows it. A deny rule reads
/// each of its lines.
#[test]
fn a_paste_is_asked_unless_a_deny_rule_matches_a_line_of_it() {
    let file = rules(FILE);
    let pasted = |text: &str| {
        file.check_send(Send {
            callers: &["claude"],
            program: "zsh",
            keys: &keys(&[text]),
            paste: true,
        })
        .word()
    };
    assert_eq!(pasted("gh pr list"), "ask");
    assert_eq!(pasted("Enter"), "ask");
    assert_eq!(pasted("ls\nrm -rf x\n"), "deny");
}

/// A line that may hold a second command is asked whatever the rules allow
/// of its first word: `gh pr list; ls` matches `Send(gh *)`.
#[test]
fn a_line_with_a_shell_operator_is_asked_even_when_a_rule_allows_it() {
    let file = rules(FILE);
    for line in [
        "gh pr list; ls",
        "gh pr list && ls",
        "gh pr list || ls",
        "gh pr list | sh",
        "gh pr list &",
        "gh pr list > ~/.zshrc",
        "gh api < secret",
        "gh pr view $(cat x)",
        "gh pr view `cat x`",
        "gh pr list <(x)",
        "gh !!",
        "gh !-1",
        "gh pr list {a,b}",
        "gh pr list \"a;b\"",
        "^list^merge",
    ] {
        let decision = says(&file, "claude", &[line, "Enter"]);
        assert_eq!(decision.word(), "ask", "{line}");
        assert!(decision.reason().contains("may be more than"), "{line}");
    }
}

/// An operator does not turn a refusal into a question: each command the
/// line may hold is matched against the deny rules on its own.
#[test]
fn a_deny_rule_matches_each_command_of_a_line() {
    let file = rules(FILE);
    for line in [
        "rm -rf x;",
        "rm x; ls",
        "gh pr list; rm -rf x",
        "gh pr list && sudo ls",
        "ls | sudo tee x",
        "echo $(rm -rf x)",
        "echo `rm -rf x`",
        "(rm -rf x)",
        "{ rm -rf x; }",
        "ls &rm -rf x",
    ] {
        assert_eq!(
            says(&file, "claude", &[line, "Enter"]).word(),
            "deny",
            "{line}"
        );
    }
    // What a pattern does not match in text, it does not match: these are
    // asked, by the operator or because no rule matches.
    for line in ["\\rm -rf x", "/bin/rm -rf x", "command rm x", "X=1 rm x"] {
        assert_eq!(
            says(&file, "claude", &[line, "Enter"]).word(),
            "ask",
            "{line}"
        );
    }
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
