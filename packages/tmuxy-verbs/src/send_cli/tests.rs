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
    /// The pane says it needs the user (`@tmuxy-pane-state needs-input`).
    needs_input: Mutex<bool>,
    /// What `capture-pane` shows.
    screen: String,
    /// tmux held a guarded send back: the name of its mark
    /// (`@tmuxy-send-held-<token>`).
    held: Mutex<String>,
    /// Another program is in front once the keys are in.
    /// The pane turns to `needs-input` just as tmux runs the guarded send.
    opens_prompt_at_typing: bool,
    /// The states the pane says once the keys are in, one a read, the last
    /// one kept: an agent taking them up.
    after_typing: Mutex<std::collections::VecDeque<&'static str>>,
    /// Another program is in front once the keys are in.
    replaced_after_typing: bool,
    /// The agent is working before anything is sent.
    working_before: bool,
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
                "#{@tmuxy-pane-state}" if !self.typed().is_empty() => {
                    let mut script = self.after_typing.lock().unwrap();
                    let state = if script.len() > 1 {
                        script.pop_front()
                    } else {
                        script.front().copied()
                    };
                    state.unwrap_or("").into()
                }
                "#{pane_pid}\t#{pane_current_command}"
                    if self.replaced_after_typing && !self.typed().is_empty() =>
                {
                    "4243\tnode".into()
                }
                "#{pane_pid}\t#{pane_current_command}" => "4242\tclaude".into(),
                "#{@tmuxy-pane-state}" if *self.needs_input.lock().unwrap() => "needs-input".into(),
                "#{@tmuxy-pane-state}" if self.working_before => "working".into(),
                "#{@tmuxy-pane-state}" => String::new(),
                // This send's own mark only: another's is another option.
                f if f.starts_with("#{@tmuxy-send-held-") => {
                    let held = self.held.lock().unwrap().clone();
                    if f == format!("#{{{held}}}") {
                        "1".into()
                    } else {
                        String::new()
                    }
                }
                _ if argv[0] == "capture-pane" => self.screen.clone(),
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
            // A guarded send, as tmux runs it: the keys, or the held mark.
            if argv[0] == "if-shell" {
                if *self.needs_input.lock().unwrap() || self.opens_prompt_at_typing {
                    // The else branch: set-option -p -t %3 @tmuxy-send-held-<token> 1.
                    let held = unquote(&argv[6]).get(4).cloned().unwrap_or_default();
                    *self.held.lock().unwrap() = held;
                } else {
                    self.log.lock().unwrap().push(unquote(&argv[5]).join(" "));
                }
                continue;
            }
            if argv[..2] == ["set-option", "-pu"] && argv[4] == *self.held.lock().unwrap() {
                self.held.lock().unwrap().clear();
            }
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

/// The words of a line `tmux_quote` wrote: each in single quotes, a quote
/// inside as `'\''`.
fn unquote(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => quoted = !quoted,
            '\\' if !quoted => word.extend(chars.next()),
            ' ' if !quoted => words.push(std::mem::take(&mut word)),
            c => word.push(c),
        }
    }
    words.push(word);
    words
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
        wait: false,
        stall_after: 1,
        wait_for: "30s".into(),
        queue: false,
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

/// A Claude Code approval dialog, as the bottom of its pane shows it.
const DIALOG: &str = "Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n";

/// Nothing is typed into a pane waiting at a prompt, whoever sends: not the
/// caller's own pane, not a caller the options let skip the question, and
/// not one that would be asked, which is refused before any question goes
/// up. The pane says so (`needs-input`), or its screen shows a dialog.
#[tokio::test]
async fn a_pane_at_a_prompt_is_typed_nothing_and_asked_nothing() {
    let marked = || Fake {
        needs_input: Mutex::new(true),
        reply: Some("yes"),
        ..Fake::default()
    };
    let showing = || Fake {
        screen: DIALOG.into(),
        reply: Some("yes"),
        ..Fake::default()
    };
    let allowed = |fake: Fake| Fake {
        rules: "off\t\t\tzsh\tidle".into(),
        ..fake
    };
    for (tmux, caller_pane) in [
        (marked(), Some("%3")),
        (marked(), Some("%1")),
        (allowed(marked()), Some("%1")),
        (showing(), Some("%3")),
        (showing(), Some("%1")),
        (allowed(showing()), None),
    ] {
        let (code, message) = run(&tmux, args(caller_pane)).await.unwrap_err();
        assert_eq!(code, 1, "{message}");
        assert!(message.contains("waiting at a prompt"), "{message}");
        assert!(tmux.typed().is_empty(), "{message}");
        assert!(!tmux.asked(), "a question was put up over a prompt");
    }
}

/// A prompt that opens between the check and the keys: tmux, which decides
/// in the same step that would type them, holds them back, and the sender
/// says so and clears the mark.
#[tokio::test]
async fn a_prompt_that_opens_as_the_keys_go_in_still_gets_none() {
    let tmux = Fake {
        opens_prompt_at_typing: true,
        ..Fake::default()
    };
    let (code, message) = run(&tmux, args(Some("%3"))).await.unwrap_err();
    assert_eq!(code, 1);
    assert!(message.contains("waiting at a prompt"), "{message}");
    assert!(tmux.typed().is_empty());
    assert!(
        tmux.held.lock().unwrap().is_empty(),
        "the held mark was left on the pane"
    );
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

fn waiting(states: &[&'static str]) -> (Fake, SendArgs) {
    let tmux = Fake {
        after_typing: Mutex::new(states.iter().copied().collect()),
        ..Fake::default()
    };
    let args = SendArgs {
        wait: true,
        ..args(Some("%3"))
    };
    (tmux, args)
}

/// `--wait`: the agent takes the keys up (`working`) and finishes.
#[tokio::test]
async fn a_wait_ends_when_the_agent_has_worked_and_settled() {
    let (tmux, args) = waiting(&["unread", "working", "working", "idle"]);
    run(&tmux, args).await.unwrap();
    assert_eq!(tmux.typed().len(), 1);
}

/// An agent that never starts working has stalled, and one that stops at a
/// prompt is reported, not answered: nothing more is typed.
#[tokio::test]
async fn a_wait_reports_a_stall_and_a_prompt_and_answers_neither() {
    for (states, said) in [
        (&["idle"][..], "stalled: %3 did not start working within 1s"),
        (
            &["working", "needs-input"],
            "stopped at a prompt for the user",
        ),
        (&["working", "error"], "reports an error"),
    ] {
        let (tmux, args) = waiting(states);
        let (code, message) = run(&tmux, args).await.unwrap_err();
        assert_eq!(code, EXIT_SENT, "{message}");
        assert!(message.contains(said), "{message}");
        assert_eq!(tmux.typed().len(), 1, "only the keys sent: {message}");
    }
}

/// The wait is pinned to the program that was in front: another one
/// started in its place does not end it as finished.
#[tokio::test]
async fn a_wait_is_not_satisfied_by_another_program_in_the_pane() {
    let (mut tmux, args) = waiting(&["working", "idle"]);
    tmux.replaced_after_typing = true;
    let (code, message) = run(&tmux, args).await.unwrap_err();
    assert_eq!(code, EXIT_SENT);
    assert!(message.contains("changed while waiting"), "{message}");
}

#[test]
fn a_wait_takes_seconds_minutes_or_hours() {
    for (text, seconds) in [("30s", 30), ("10m", 600), ("2h", 7200), ("45", 45)] {
        assert_eq!(wait::duration(text).unwrap().as_secs(), seconds, "{text}");
    }
    for bad in ["", "m", "0s", "-5", "1.5h", "5 m", "10d"] {
        assert_eq!(wait::duration(bad).unwrap_err().0, EXIT_USAGE, "{bad}");
    }
}

/// Another send's held mark on the pane is not this one's: it neither
/// refuses this send nor is cleared by it.
#[tokio::test]
async fn another_sends_held_mark_is_left_alone() {
    let tmux = Fake {
        held: Mutex::new("@tmuxy-send-held-someone-elses".into()),
        ..Fake::default()
    };
    run(&tmux, args(Some("%3"))).await.unwrap();
    assert_eq!(tmux.typed().len(), 1);
    assert_eq!(*tmux.held.lock().unwrap(), "@tmuxy-send-held-someone-elses");
}

/// --wait into an agent already working: refused before anything is typed,
/// since the end of its current turn would read as the end of this one.
/// Every failure after the keys went in is exit 5, never 1.
#[tokio::test]
async fn a_wait_is_refused_into_a_working_agent_and_a_failed_wait_is_exit_5() {
    let busy = Fake {
        working_before: true,
        ..Fake::default()
    };
    let into_busy = SendArgs {
        wait: true,
        ..args(Some("%3"))
    };
    let (code, message) = run(&busy, into_busy).await.unwrap_err();
    assert_eq!(code, EXIT_FAILED);
    assert!(message.contains("is working"), "{message}");
    assert!(busy.typed().is_empty());

    let (stalls, args) = waiting(&["idle"]);
    let (code, _) = run(&stalls, args).await.unwrap_err();
    assert_eq!(code, EXIT_SENT);
}
