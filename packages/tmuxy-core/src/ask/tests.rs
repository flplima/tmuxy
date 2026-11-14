use super::*;
use std::sync::Mutex;

fn pane() -> PaneId {
    PaneId::parse("%3").unwrap()
}

fn keys() -> Vec<String> {
    vec!["npm test".into(), "Enter".into()]
}

/// One pane's ask options and state, every command run on it, and the
/// answer the "user" gives as soon as a question goes up.
#[derive(Default)]
struct FakePane {
    ask: String,
    answer: String,
    state: String,
    /// What the pane's send options read as ([`SendRules::parse`]).
    rules: String,
    reply: Option<&'static str>,
    log: Vec<Argv>,
}

struct Fake(Mutex<FakePane>);

impl Fake {
    fn new(reply: Option<&'static str>) -> Self {
        Self(Mutex::new(FakePane {
            reply,
            ..FakePane::default()
        }))
    }

    fn log(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .log
            .iter()
            .map(|a| a.join(" "))
            .collect()
    }
}

impl Tmux for Fake {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        let mut p = self.0.lock().unwrap();
        p.log.push(argv.clone());
        let format = argv.last().cloned().unwrap_or_default();
        // `pane_read` asks for the pane's id first, as real tmux answers it.
        let (id, format) = match format.strip_prefix("#{pane_id}\t") {
            Some(rest) => (format!("{}\t", argv[3]), rest.to_string()),
            None => (String::new(), format),
        };
        let said = match format.as_str() {
            "#{@tmuxy-ask}" => p.ask.clone(),
            "#{@tmuxy-ask-answer}" => p.answer.clone(),
            "#{@tmuxy-pane-state}" => p.state.clone(),
            _ => p.rules.clone(),
        };
        Ok(id + &said)
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        let mut p = self.0.lock().unwrap();
        for argv in commands {
            p.log.push(argv.clone());
            let words: Vec<&str> = argv.iter().map(String::as_str).collect();
            match words.as_slice() {
                ["set-option", "-pu", "-t", _, "@tmuxy-ask"] => p.ask.clear(),
                ["set-option", "-pu", "-t", _, "@tmuxy-ask-answer"] => p.answer.clear(),
                ["set-option", "-pu", "-t", _, "@tmuxy-pane-state"] => p.state.clear(),
                ["set-option", "-p", "-t", _, "@tmuxy-pane-state", value] => {
                    p.state = value.to_string()
                }
                // The unread mark, as tmux decides it: only on a quiet pane.
                ["if-shell", "-F", "-t", _, _, mark]
                    if mark.ends_with("'@tmuxy-pane-state' 'unread'") =>
                {
                    if p.state.is_empty() || p.state == "idle" {
                        p.state = "unread".into();
                    }
                }
                ["set-option", "-p", "-t", _, "@tmuxy-ask", value] => {
                    p.ask = value.to_string();
                    let question: serde_json::Value = serde_json::from_slice(
                        &base64::engine::general_purpose::STANDARD
                            .decode(value)
                            .unwrap(),
                    )
                    .unwrap();
                    if let Some(reply) = p.reply {
                        p.answer = format!("{}:{reply}", question["token"].as_str().unwrap());
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[test]
fn the_question_is_skipped_only_when_the_user_said_so() {
    let rules = |send_ask: &str, allow: &str, allow_into: &str, program: &str| SendRules {
        send_ask: send_ask.into(),
        allow: allow.into(),
        allow_into: allow_into.into(),
        program: program.into(),
        pane_state: String::new(),
    };
    let skips = |r: SendRules, callers: &[&str]| r.skip_question(callers, &pane());
    assert!(!skips(rules("", "", "", "zsh"), &["claude-code"]));
    assert!(!skips(
        rules("on", "codex,%4", "claude,agy", "zsh"),
        &["claude-code"]
    ));
    assert!(skips(rules("off", "", "", "zsh"), &["claude-code"]));
    assert!(skips(
        rules("", "codex, claude-code", "", "zsh"),
        &["claude-code"]
    ));
    assert!(skips(rules("", "%3", "", "zsh"), &["claude-code"]));
    assert!(skips(rules("", "mcp", "", "zsh"), &["cursor", "mcp"]));
    assert!(!skips(rules("", "mcp", "", "zsh"), &["cursor"]));
    // Into an agent's prompt: the program in the pane, not who sends.
    assert!(skips(rules("", "", "claude, agy", "agy"), &["cursor"]));
    assert!(skips(rules("", "", "claude,agy", "claude"), &["cursor"]));
    assert!(!skips(rules("", "", "claude,agy", ""), &["cursor"]));
}

/// tmux names a pane's program by the file it runs, and Claude Code's is
/// its version; the allow list says `claude`.
#[test]
fn a_pane_running_claude_code_is_named_claude() {
    let parsed = SendRules::parse("on\t\tclaude,agy\t2.1.314\tidle\n");
    assert_eq!(parsed.program, "claude");
    assert_eq!(parsed.allow_into, "claude,agy");
    assert_eq!(parsed.pane_state, "idle");
}

#[test]
fn the_question_carries_who_asks_and_what_they_would_type() {
    let encoded = encode_question("3-mcp-ab", "claude-code", &keys());
    let decoded: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        decoded,
        serde_json::json!({ "token": "3-mcp-ab", "caller": "claude-code", "keys": ["npm test", "Enter"] })
    );
}

/// The UI admits a token of word characters, `.`, `%` and `-` alone
/// (`paneAsk.ts`), and a sender's own part keeps two questions apart.
#[test]
fn a_token_names_the_pane_and_the_sender_and_differs_every_time() {
    let rules = SendRules::default();
    let a = Question::new(&pane(), "4242", "zsh", &keys(), &rules);
    let b = Question::new(&pane(), "4242", "zsh", &keys(), &rules);
    assert!(a.token.starts_with("3-4242-"), "{}", a.token);
    assert!(a
        .token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_.%-".contains(c)));
    assert_ne!(a.token, b.token);
}

#[tokio::test]
async fn an_allowed_question_is_down_before_the_keys_land() {
    let tmux = Fake::new(Some("yes"));
    let question = Question::new(&pane(), "1", "claude-code", &keys(), &SendRules::default());
    question.put_up(&tmux).await.unwrap();
    question.answer(&tmux, None).await.unwrap();
    question.take_down(&tmux).await;
    tmux.mutate(vec![send_keys_argv(&pane(), &keys())])
        .await
        .unwrap();

    let log = tmux.log();
    let position = |needle: &str| log.iter().position(|c| c.starts_with(needle));
    let cleared = position("set-option -pu -t %3 @tmuxy-ask-answer").unwrap();
    let asked = position("set-option -p -t %3 @tmuxy-ask ").unwrap();
    let taken_down = position("set-option -pu -t %3 @tmuxy-ask").unwrap();
    let typed = position("send-keys").unwrap();
    assert!(cleared < asked, "{log:?}");
    assert!(log[taken_down..]
        .iter()
        .any(|c| c == "set-option -pu -t %3 @tmuxy-ask"));
    assert!(asked < typed, "{log:?}");
    assert_eq!(log[typed], "send-keys -t %3 -- npm test Enter");
    assert!(tmux.0.lock().unwrap().ask.is_empty());
}

#[tokio::test]
async fn the_target_pane_needs_the_user_while_asked_and_gets_its_state_back() {
    let tmux = Fake::new(Some("no"));
    tmux.0.lock().unwrap().state = "working".into();
    let rules = SendRules {
        pane_state: "working".into(),
        ..SendRules::default()
    };
    let question = Question::new(&pane(), "1", "cursor", &keys(), &rules);
    question.put_up(&tmux).await.unwrap();
    let answer = question.answer(&tmux, None).await;
    assert_eq!(answer, Err(Refused::Declined(pane())));
    assert!(tmux
        .log()
        .contains(&"set-option -p -t %3 @tmuxy-pane-state needs-input".to_string()));
    question.take_down(&tmux).await;
    let p = tmux.0.lock().unwrap();
    assert_eq!(p.state, "working");
    assert!(p.ask.is_empty(), "the question is left up");
}

/// A state the pane set itself while asked (an agent's hook) is newer news
/// than the one it had before, and a question asked over this one is that
/// sender's: neither comes down.
#[tokio::test]
async fn taking_down_leaves_what_is_not_this_senders_own() {
    let tmux = Fake::new(None);
    let question = Question::new(&pane(), "1", "cursor", &keys(), &SendRules::default());
    {
        let mut p = tmux.0.lock().unwrap();
        p.ask = "someone-elses".into();
        p.state = "idle".into();
    }
    question.take_down(&tmux).await;
    let p = tmux.0.lock().unwrap();
    assert_eq!(p.ask, "someone-elses");
    assert_eq!(p.state, "idle");
}

#[tokio::test]
async fn an_unanswered_question_gives_up_at_the_deadline() {
    let tmux = Fake::new(None);
    let question = Question::new(&pane(), "1", "cursor", &keys(), &SendRules::default());
    let timeout = Duration::from_millis(300);
    question.put_up(&tmux).await.unwrap();
    let answer = question.answer(&tmux, Some(Deadline::after(timeout))).await;
    assert_eq!(answer, Err(Refused::NoAnswer(pane(), timeout)));
}

#[tokio::test]
async fn a_send_waits_behind_another_question_until_its_deadline() {
    let tmux = Fake::new(None);
    tmux.0.lock().unwrap().ask = "someone-elses".into();
    let waited = wait_turn(
        &tmux,
        &pane(),
        Some(Deadline::after(Duration::from_millis(300))),
    )
    .await;
    assert_eq!(waited, Err(Refused::Busy(pane())));
    tmux.0.lock().unwrap().ask.clear();
    assert_eq!(wait_turn(&tmux, &pane(), None).await, Ok(()));
}

#[tokio::test]
async fn a_skipped_send_marks_a_quiet_pane_unread_and_leaves_a_loud_one() {
    let tmux = Fake::new(None);
    let quiet = SendRules {
        pane_state: "idle".into(),
        ..SendRules::default()
    };
    quiet.mark_unread(&tmux, &pane()).await.unwrap();
    assert_eq!(tmux.0.lock().unwrap().state, "unread");

    let tmux = Fake::new(None);
    let loud = SendRules {
        pane_state: "needs-input".into(),
        ..SendRules::default()
    };
    loud.mark_unread(&tmux, &pane()).await.unwrap();
    assert!(tmux.log().is_empty());
}
