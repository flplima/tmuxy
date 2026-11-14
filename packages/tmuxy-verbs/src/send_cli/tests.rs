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
    /// The pane is gone: every read of its answer fails.
    gone: bool,
    asked: Mutex<String>,
    log: Mutex<Vec<String>>,
}

impl ask::Tmux for Fake {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        self.log.lock().unwrap().push(argv.join(" "));
        let format = argv.last().cloned().unwrap_or_default();
        // `pane_read` asks for the pane's id first, as real tmux answers it.
        let (id, format) = match format.strip_prefix("#{pane_id}\t") {
            Some(rest) => (format!("{}\t", argv[3]), rest.to_string()),
            None => (String::new(), format),
        };
        Ok(id
            + &match format.as_str() {
                "#{pane_current_command}" => self.caller_program.clone(),
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
    send(tmux, args, &Answer::new(false)).await
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
