//! `tmuxy pane send`'s flow once the CLI has resolved the target and the
//! caller, against a pane that answers like tmux: who is asked, what is
//! typed, and the exit code each refusal keeps. The question itself is
//! `tmuxy_core::ask`'s, tested there.

use super::*;
use std::sync::Mutex;

/// The target pane `%3`: its send options, its program, the answer the
/// "user" gives once a question is up, and every command run.
#[derive(Default)]
struct Fake {
    rules: String,
    /// What `#{pane_current_command}` reads in the caller's pane.
    caller_program: String,
    reply: Option<&'static str>,
    /// The caller does not run in the pane it names: that pane's process is
    /// no ancestor of this one.
    elsewhere: bool,
    /// The pane is gone: every read of its answer fails.
    gone: bool,
    asked: Mutex<String>,
    log: Mutex<Vec<String>>,
}

impl ask::Tmux for Fake {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        self.log.lock().unwrap().push(argv.join(" "));
        let format = argv.last().cloned().unwrap_or_default();
        Ok(match format.as_str() {
            "#{pane_current_command}" => self.caller_program.clone(),
            "#{pane_pid}" if self.elsewhere => "0".into(),
            "#{pane_pid}" => std::process::id().to_string(),
            "#{@tmuxy-ask}" => String::new(),
            "#{@tmuxy-pane-state}" => String::new(),
            "#{@tmuxy-ask-answer}" if self.gone => {
                return Err(CommandError::tmux("can't find pane: %3"))
            }
            "#{@tmuxy-ask-answer}" => {
                let asked = self.asked.lock().unwrap().clone();
                match self.reply {
                    Some(reply) if !asked.is_empty() => format!("{asked}:{reply}"),
                    _ => String::new(),
                }
            }
            _ => self.rules.clone(),
        })
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        for argv in commands {
            if argv[..2] == ["set-option", "-p"] && argv[4] == "@tmuxy-ask" {
                use base64::Engine as _;
                let question: serde_json::Value = serde_json::from_slice(
                    &base64::engine::general_purpose::STANDARD
                        .decode(&argv[5])
                        .unwrap(),
                )
                .unwrap();
                *self.asked.lock().unwrap() = question["token"].as_str().unwrap().to_string();
            }
            self.log.lock().unwrap().push(argv.join(" "));
        }
        Ok(())
    }
}

impl Fake {
    fn typed(&self) -> Vec<String> {
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|c| c.starts_with("send-keys"))
            .cloned()
            .collect()
    }

    fn asked(&self) -> bool {
        !self.asked.lock().unwrap().is_empty()
    }
}

fn args(caller_pane: Option<&str>) -> SendArgs {
    SendArgs {
        target: "%3".into(),
        caller_pane: caller_pane.map(String::from),
        caller_process: Some("bash".into()),
        timeout: Some(1),
        paste: false,
        json: false,
        keys: vec!["make".into(), "Enter".into()],
    }
}

async fn run(tmux: &Fake, args: SendArgs) -> Result<(), (i32, String)> {
    send(
        tmux,
        args,
        &Answer::new(false),
        &permissions::Loaded::Missing,
    )
    .await
}

/// [`run`], with the user's permissions file holding `rules`.
async fn run_with(tmux: &Fake, args: SendArgs, rules: &str) -> Result<(), (i32, String)> {
    let file = match permissions::Permissions::parse(rules) {
        Ok(rules) => permissions::Loaded::Rules(rules),
        Err(why) => permissions::Loaded::Malformed(why),
    };
    send(tmux, args, &Answer::new(false), &file).await
}

#[tokio::test]
async fn into_the_callers_own_pane_the_keys_go_at_once() {
    let tmux = Fake::default();
    run(&tmux, args(Some("%3"))).await.unwrap();
    assert_eq!(tmux.typed(), ["send-keys -t %3 -- make Enter"]);
    assert!(!tmux.asked());
}

#[tokio::test]
async fn into_another_pane_the_keys_wait_for_a_yes() {
    let tmux = Fake {
        reply: Some("yes"),
        ..Fake::default()
    };
    run(&tmux, args(Some("%1"))).await.unwrap();
    assert!(tmux.asked());
    assert_eq!(tmux.typed(), ["send-keys -t %3 -- make Enter"]);
}

/// The contract: 1 for a no or a timeout, 3 for a pane that went away, and
/// nothing typed in any of them.
#[tokio::test]
async fn a_refused_send_types_nothing_and_says_why_in_its_exit_code() {
    let declined = Fake {
        reply: Some("no"),
        ..Fake::default()
    };
    let (code, message) = run(&declined, args(None)).await.unwrap_err();
    assert_eq!(
        (code, message.as_str()),
        (1, "declined in %3; nothing sent")
    );

    let unanswered = Fake::default();
    let (code, message) = run(&unanswered, args(None)).await.unwrap_err();
    assert_eq!(code, 1, "{message}");
    assert!(message.contains("no answer from %3 after 1s"), "{message}");

    let gone = Fake {
        gone: true,
        ..Fake::default()
    };
    let (code, _) = run(&gone, args(None)).await.unwrap_err();
    assert_eq!(code, 3);

    for tmux in [declined, unanswered, gone] {
        assert!(tmux.typed().is_empty());
    }
}

/// The caller is named by the program in front in its pane, Claude Code's
/// version-named process as `claude`, which is what the allow list says.
#[tokio::test]
async fn a_caller_on_the_allow_list_is_not_asked_and_the_target_is_unread() {
    let tmux = Fake {
        rules: "on\tclaude\t\tzsh\tidle".into(),
        caller_program: "2.1.314".into(),
        ..Fake::default()
    };
    run(&tmux, args(Some("%1"))).await.unwrap();
    assert!(!tmux.asked());
    assert_eq!(tmux.typed(), ["send-keys -t %3 -- make Enter"]);
    assert!(tmux
        .log
        .lock()
        .unwrap()
        .contains(&"set-option -p -t %3 @tmuxy-pane-state unread".to_string()));
}

#[tokio::test]
async fn a_caller_in_no_pane_is_named_by_its_process() {
    let tmux = Fake {
        rules: "on\tbash\t\tzsh\t".into(),
        ..Fake::default()
    };
    run(&tmux, args(None)).await.unwrap();
    assert!(!tmux.asked());
}

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

/// Any spelling of the end marker would end a bracketed paste early and run
/// what follows it, so the text loses every control but tab, LF and CR.
#[test]
fn a_paste_keeps_tab_lf_and_cr_and_loses_every_other_control() {
    for (text, pasted) in [
        ("a\x1b[20\x1b[201~1~\nid", "a[20[201~1~\nid"),
        ("echo safe\x1b[0201~; id", "echo safe[0201~; id"),
        ("echo safe\u{9b}201~; id", "echo safe201~; id"),
        ("a\x01\x07\t\x7f\r\u{85}\nb", "a\t\r\nb"),
        // © and NBSP are C2 A9 and C2 A0 in UTF-8: the C1 lead byte, kept.
        ("中文 é © Â 😀 \u{a0} ok", "中文 é © Â 😀 \u{a0} ok"),
        ("\x1b\x07\u{9b}\x7f", ""),
    ] {
        assert_eq!(without_controls(text), pasted, "{text:?}");
    }
}
