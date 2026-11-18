//! `tmuxy pane ask`'s flow once the CLI has resolved the target and the
//! caller, against a pane that answers like tmux: the exit code and message
//! each end keeps, and that a command line it refuses asks nothing. The
//! payload and the answer format are `tmuxy_core::ask`'s, tested there.

use super::*;
use base64::Engine as _;
use std::sync::Mutex;
use tmuxy_core::ask::Argv;
use tmuxy_core::CommandError;

/// Pane `%3`, which the person answers with `reply` as soon as a question is
/// up, and every command run on it.
struct Fake {
    reply: &'static str,
    ask: Mutex<String>,
    answer: Mutex<String>,
    state: Mutex<String>,
    log: Mutex<Vec<String>>,
}

impl Fake {
    fn new(reply: &'static str) -> Self {
        Self {
            reply,
            ask: Mutex::default(),
            answer: Mutex::default(),
            state: Mutex::new("working".into()),
            log: Mutex::default(),
        }
    }
}

impl ask::Tmux for Fake {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        self.log.lock().unwrap().push(argv.join(" "));
        let format = argv.last().cloned().unwrap_or_default();
        let said = match format.trim_start_matches("#{pane_id}\t") {
            "#{@tmuxy-ask}" => self.ask.lock().unwrap().clone(),
            "#{@tmuxy-ask-answer}" => self.answer.lock().unwrap().clone(),
            "#{@tmuxy-pane-state}" => self.state.lock().unwrap().clone(),
            "#{pane_current_command}" => "claude".into(),
            "#{pane_pid}" => std::process::id().to_string(),
            _ => String::new(),
        };
        Ok(format!("%3\t{said}"))
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        for argv in commands {
            self.log.lock().unwrap().push(argv.join(" "));
            let words: Vec<&str> = argv.iter().map(String::as_str).collect();
            match words.as_slice() {
                ["set-option", "-p", "-t", _, "@tmuxy-ask", value] => {
                    *self.ask.lock().unwrap() = value.to_string();
                    let payload: serde_json::Value = serde_json::from_slice(
                        &base64::engine::general_purpose::STANDARD
                            .decode(value)
                            .unwrap(),
                    )
                    .unwrap();
                    *self.answer.lock().unwrap() =
                        format!("{}:{}", payload["token"].as_str().unwrap(), self.reply);
                }
                ["set-option", "-pu", "-t", _, "@tmuxy-ask"] => self.ask.lock().unwrap().clear(),
                ["set-option", "-p", "-t", _, "@tmuxy-pane-state", value] => {
                    *self.state.lock().unwrap() = value.to_string()
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn args(question: &str, choices: &[&str], text: bool) -> AskArgs {
    AskArgs {
        target: "%3".into(),
        caller_pane: Some("%3".into()),
        caller_process: None,
        choices: choices.iter().map(|c| c.to_string()).collect(),
        text,
        wait_for: None,
        json: false,
        question: vec![question.into()],
    }
}

#[tokio::test]
async fn the_answer_is_the_chosen_text_and_the_pane_gets_its_state_back() {
    let tmux = Fake::new("choice:0");
    let said = ask(&tmux, args("Deploy?", &["yes", "no"], false)).await;
    assert_eq!(said, Ok("yes".to_string()));
    assert!(
        tmux.ask.lock().unwrap().is_empty(),
        "the question is left up"
    );
    assert_eq!(*tmux.state.lock().unwrap(), "working");
    let payload = tmux
        .log
        .lock()
        .unwrap()
        .iter()
        .find_map(|c| {
            c.strip_prefix("set-option -p -t %3 @tmuxy-ask ")
                .map(String::from)
        })
        .unwrap();
    let payload = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(payload["caller"], "claude");

    let dismissed = ask(&Fake::new("no"), args("Deploy?", &[], false)).await;
    assert_eq!(dismissed, Err((EXIT_FAILED, "dismissed in %3".to_string())));
}

#[tokio::test]
async fn a_command_line_it_refuses_asks_nothing() {
    for bad in [
        args("Deploy?", &["yes"], true),
        args("Deploy\nnow?", &[], false),
        args("Pick", &["1", "2", "3", "4", "5", "6", "7"], false),
        AskArgs {
            wait_for: Some("soon".into()),
            ..args("Deploy?", &[], false)
        },
    ] {
        let tmux = Fake::new("choice:0");
        let (code, _) = ask(&tmux, bad).await.unwrap_err();
        assert_eq!(code, EXIT_USAGE);
        assert!(tmux.log.lock().unwrap().is_empty());
    }
}
