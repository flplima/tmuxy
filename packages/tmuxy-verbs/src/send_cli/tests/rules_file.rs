//! `tmuxy pane send` under the user's permissions file (what a deny, an ask
//! and an allow change against the pane's own options), and the caller-pane
//! claim it checks before trusting.

use super::*;

/// `%3` runs zsh, and its options skip the question for everyone
/// (`@tmuxy-send-ask off`): what the permissions file changes is then plain
/// to see, since without it nothing would be asked.
fn never_asks() -> Fake {
    Fake {
        rules: "off\t\t\tzsh\tidle".into(),
        caller_program: "claude".into(),
        reply: Some("yes"),
        ..Fake::default()
    }
}

fn typing(keys: &[&str]) -> SendArgs {
    SendArgs {
        keys: keys.iter().map(|k| k.to_string()).collect(),
        ..args(Some("%1"))
    }
}

const RULES: &str = r#"{"callers": {"claude": {
    "allow": ["Send(gh *)"],
    "ask": ["Send(gh pr merge *)"],
    "deny": ["Send(rm *)"]
}}}"#;

/// A denied send exits 1 with the rule, types nothing, and puts no question
/// up: there is nothing for the user to be talked into.
#[tokio::test]
async fn a_send_the_file_denies_types_nothing_and_asks_nobody() {
    let tmux = never_asks();
    let (code, message) = run_with(&tmux, typing(&["rm -rf build", "Enter"]), RULES)
        .await
        .unwrap_err();
    assert_eq!(code, 1);
    assert_eq!(
        message,
        "denied by `Send(rm *)` (callers.claude); nothing sent"
    );
    assert!(tmux.typed().is_empty());
    assert!(!tmux.asked());
    // The same send asks where the options would ask, too: deny is not "ask".
    let asking = Fake {
        rules: "on\t\t\tzsh\tidle".into(),
        ..never_asks()
    };
    assert!(run_with(&asking, typing(&["rm -rf build", "Enter"]), RULES)
        .await
        .is_err());
    assert!(!asking.asked());
}

/// With rules for the caller, a send into a shell is asked whatever the
/// options say: an `ask` rule, no rule, a line the rules cannot judge. And an
/// `allow` rule too, in this version: the file skips no question.
#[tokio::test]
async fn the_file_has_a_send_asked_where_the_options_would_skip_the_question() {
    for keys in [
        &["gh pr merge 7", "Enter"][..],
        &["cargo build", "Enter"],
        &["gh pr list; ls", "Enter"],
        &["gh pr list"],
        &["C-c"],
        &["gh pr list", "Enter"],
    ] {
        let tmux = never_asks();
        run_with(&tmux, typing(keys), RULES).await.unwrap();
        assert!(tmux.asked(), "{keys:?} was not asked");
        assert_eq!(tmux.typed().len(), 1, "{keys:?}");
    }
    // Asked, and a no is a no.
    let declined = Fake {
        reply: Some("no"),
        ..never_asks()
    };
    let (code, _) = run_with(&declined, typing(&["gh pr list", "Enter"]), RULES)
        .await
        .unwrap_err();
    assert_eq!(code, 1);
    assert!(declined.typed().is_empty());
}

/// Where the file has nothing to say, a send goes as it does without it: no
/// section for this caller, the caller's own pane.
#[tokio::test]
async fn a_send_the_file_does_not_bind_goes_as_it_did() {
    // Another caller's rules are not this one's.
    let other = Fake {
        caller_program: "codex".into(),
        ..never_asks()
    };
    run_with(&other, typing(&["rm -rf x", "Enter"]), RULES)
        .await
        .unwrap();
    assert!(!other.asked());
    assert_eq!(other.typed(), ["send-keys -t %3 -- rm -rf x Enter"]);

    // The caller's own pane is the caller's to type into.
    let own = never_asks();
    run_with(
        &own,
        SendArgs {
            keys: vec!["rm -rf x".into(), "Enter".into()],
            ..args(Some("%3"))
        },
        RULES,
    )
    .await
    .unwrap();
    assert!(!own.asked());
    assert_eq!(own.typed().len(), 1);

    // And with no rules at all, the options decide as before.
    let free = never_asks();
    run_with(&free, typing(&["rm -rf x", "Enter"]), "{}")
        .await
        .unwrap();
    assert!(!free.asked());
}

/// A target that is not a listed shell (an editor, a shell behind `ssh`)
/// is not a way out of the file: a denied text is refused there too, and
/// anything else is asked, whatever the options say.
#[tokio::test]
async fn a_bound_caller_typing_into_a_program_that_is_no_listed_shell_is_denied_or_asked() {
    for program in ["vim", "ssh", "ksh"] {
        let target = || Fake {
            rules: format!("off\t\t\t{program}\tidle"),
            ..never_asks()
        };
        let denied = target();
        let (code, message) = run_with(&denied, typing(&["rm -rf x", "Enter"]), RULES)
            .await
            .unwrap_err();
        assert_eq!(code, 1, "{program}");
        assert!(message.starts_with("denied by `Send(rm *)`"), "{message}");
        assert!(denied.typed().is_empty(), "{program}");
        assert!(!denied.asked(), "{program}");

        let asked = target();
        run_with(&asked, typing(&["gh pr list", "Enter"]), RULES)
            .await
            .unwrap();
        assert!(asked.asked(), "{program}");
    }
}

/// `--caller-pane` is the caller's word. One that does not run in the pane
/// it names is a caller in no pane: a claim to the target pane delivers
/// nothing unasked and steps around no rule, and a claim to an allowed
/// program's pane does not lend its name.
#[tokio::test]
async fn a_caller_that_does_not_run_in_the_pane_it_names_is_not_believed() {
    // "The target is my own pane", from somewhere else: asked.
    let claimed = Fake {
        elsewhere: true,
        reply: Some("yes"),
        ..Fake::default()
    };
    run(&claimed, args(Some("%3"))).await.unwrap();
    assert!(claimed.asked());

    // The same claim against a file with a rule for everyone: refused.
    let denied = Fake {
        elsewhere: true,
        ..never_asks()
    };
    let everyone = r#"{"callers": {"*": {"deny": ["Send(rm *)"]}}}"#;
    let send = SendArgs {
        keys: vec!["rm -rf x".into(), "Enter".into()],
        ..args(Some("%3"))
    };
    let (code, _) = run_with(&denied, send, everyone).await.unwrap_err();
    assert_eq!(code, 1);
    assert!(denied.typed().is_empty());
    assert!(!denied.asked());

    // A pane running an allow-listed program, claimed from elsewhere: the
    // caller is named by its own process, which the list does not hold.
    let borrowed = Fake {
        rules: "on\tclaude\t\tzsh\tidle".into(),
        caller_program: "claude".into(),
        elsewhere: true,
        reply: Some("yes"),
        ..Fake::default()
    };
    run(&borrowed, args(Some("%1"))).await.unwrap();
    assert!(borrowed.asked());
}

/// A file that is there and is not rules refuses every send into another
/// pane, whoever sends and whatever the pane runs: it is never read as "no
/// rules". The caller's own pane stays its own.
#[tokio::test]
async fn a_file_that_is_not_rules_refuses_every_send_into_another_pane() {
    let broken = r#"{"callers": {"claude": {"deny": ["rm *"]}}}"#;
    for tmux in [
        never_asks(),
        Fake {
            rules: "off\t\t\tvim\tidle".into(),
            caller_program: "codex".into(),
            ..never_asks()
        },
    ] {
        let (code, message) = run_with(&tmux, typing(&["ls", "Enter"]), broken)
            .await
            .unwrap_err();
        assert_eq!(code, 1);
        assert!(
            message.contains("permissions.json cannot be read as rules"),
            "{message}"
        );
        assert!(message.ends_with("nothing sent"), "{message}");
        assert!(tmux.typed().is_empty());
        assert!(!tmux.asked());
    }
    let own = never_asks();
    run_with(&own, args(Some("%3")), broken).await.unwrap();
    assert_eq!(own.typed().len(), 1);
}

/// A paste is text, not a command: with rules for the caller it is asked.
#[tokio::test]
async fn a_paste_into_a_shell_is_asked_when_the_caller_has_rules() {
    // Declined: a paste that goes ahead loads its text into a buffer of the
    // real tmux on the socket in the environment, which is not this fake.
    let tmux = Fake {
        reply: Some("no"),
        ..never_asks()
    };
    let pasted = SendArgs {
        paste: true,
        keys: vec!["gh pr list".into()],
        ..args(Some("%1"))
    };
    let (code, _) = run_with(&tmux, pasted, RULES).await.unwrap_err();
    assert_eq!(code, 1);
    assert!(tmux.asked());
    assert!(tmux.typed().is_empty());
}
