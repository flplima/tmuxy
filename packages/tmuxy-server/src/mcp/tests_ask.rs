//! The endpoint's own part of the ask protocol; `tmuxy_core::ask` and its
//! tests hold the rest.

use super::ask;
use super::tmux::Tmux;
use crate::state::AppState;
use base64::Engine as _;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tmuxy_core::control_mode::{CommandReply, MonitorCommand};
use tmuxy_core::session::SessionName;
use tmuxy_core::PaneId;

#[derive(Default)]
struct FakePane {
    ask: String,
    answer: String,
    state: String,
    log: Vec<String>,
    /// What the pane's send options read as (`SendRules`); unset, all empty.
    rules: String,
}

/// A monitor that answers like tmux for one pane's ask options and its state,
/// and has the "user" answer `reply` as soon as a question goes up. A command
/// list is taken a command at a time, as tmux does.
fn fake_monitor(reply: Option<&'static str>) -> (Tmux, Arc<Mutex<FakePane>>) {
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let pane = Arc::new(Mutex::new(FakePane::default()));
    let seen = Arc::clone(&pane);
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            let MonitorCommand::RunCommandWithReply { command, reply: tx } = cmd else {
                continue;
            };
            let output = {
                let mut p = seen.lock().unwrap();
                p.log.push(command.clone());
                let mut output = String::new();
                for part in command.split(" ; ").map(str::trim) {
                    // `pane_read` asks for the pane's id first.
                    let id = if part.contains("#{pane_id}") {
                        "%3\t"
                    } else {
                        ""
                    };
                    if part.contains("#{@tmuxy-send-ask}") {
                        output += &format!("{id}{}\n", p.rules);
                    } else if part == "set-option -pu -t %3 @tmuxy-ask" {
                        p.ask.clear();
                    } else if part == "set-option -pu -t %3 @tmuxy-ask-answer" {
                        p.answer.clear();
                    } else if part == "set-option -pu -t %3 @tmuxy-pane-state" {
                        p.state.clear();
                    } else if let Some(value) =
                        part.strip_prefix("set-option -p -t %3 @tmuxy-pane-state ")
                    {
                        p.state = value.trim_matches('\'').to_string();
                    } else if let Some(value) = part.strip_prefix("set-option -p -t %3 @tmuxy-ask ")
                    {
                        p.ask = value.to_string();
                        let question: Value = serde_json::from_slice(
                            &base64::engine::general_purpose::STANDARD
                                .decode(&p.ask)
                                .unwrap(),
                        )
                        .unwrap();
                        if let Some(reply) = reply {
                            p.answer = format!("{}:{reply}", question["token"].as_str().unwrap());
                        }
                    } else if part.contains("#{@tmuxy-ask-answer}") {
                        output += &format!("{id}{}\n", p.answer);
                    } else if part.contains("#{@tmuxy-ask}") {
                        output += &format!("{id}{}\n", p.ask);
                    } else if part.contains("#{@tmuxy-pane-state}") {
                        output += &format!("{id}{}\n", p.state);
                    }
                }
                output
            };
            let _ = tx.send(CommandReply {
                output,
                error: None,
            });
        }
    });
    let state = Arc::new(AppState::default());
    let session = SessionName::parse("s").unwrap();
    (Tmux::with_channel(&state, &session, tx), pane)
}

fn keys() -> Vec<String> {
    vec!["npm test".into(), "Enter".into()]
}

#[tokio::test]
async fn keys_land_only_after_the_user_allows_them_and_the_question_is_down() {
    let (tmux, pane) = fake_monitor(Some("yes"));
    let id = PaneId::parse("%3").unwrap();
    let sent = ask::send_keys(&tmux, &id, &keys(), "claude-code", Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(sent["asked"], true);

    let p = pane.lock().unwrap();
    let position = |needle: &str| p.log.iter().position(|c| c.contains(needle));
    let asked = position("set-option -p -t %3 @tmuxy-ask ").expect("the question went up");
    let taken_down = position("set-option -pu -t %3 @tmuxy-ask ;").expect("and came down");
    let typed = position("send-keys").expect("the keys were sent");
    assert!(asked < taken_down && taken_down < typed, "{:?}", p.log);
    assert_eq!(p.log[typed], "send-keys -t %3 -- \"npm test\" Enter");
    assert!(p.ask.is_empty());
}

/// The pane waiting on the answer is the one the question is over: it is
/// marked `needs-input` while the question is up, and what it said before
/// comes back when it comes down — unless the pane said something new since.
#[tokio::test]
async fn the_target_pane_needs_the_user_while_asked_and_gets_its_state_back() {
    let (tmux, pane) = fake_monitor(Some("no"));
    pane.lock().unwrap().rules = "\t\t\tclaude\tworking".into();
    let id = PaneId::parse("%3").unwrap();
    let _ = ask::send_keys(&tmux, &id, &keys(), "cursor", Duration::from_secs(5)).await;
    let p = pane.lock().unwrap();
    let marked = p.log.iter().position(|c| {
        c.contains("set-option -p -t %3 @tmuxy-ask ") && c.contains("@tmuxy-pane-state needs-input")
    });
    assert!(
        marked.is_some(),
        "the target is marked with the question: {:?}",
        p.log
    );
    assert_eq!(p.state, "working", "{:?}", p.log);
}

/// `@tmuxy-send-allow-into agy`: a send into a pane whose program is `agy`
/// types at once, with no question, and leaves the pane marked unread.
#[tokio::test]
async fn a_send_into_an_allowed_program_asks_nothing() {
    let (tmux, pane) = fake_monitor(None);
    pane.lock().unwrap().rules = "on\t\tclaude,agy\tagy\tidle".into();
    let id = PaneId::parse("%3").unwrap();
    let sent = ask::send_keys(&tmux, &id, &keys(), "cursor", Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(sent["asked"], false);
    let p = pane.lock().unwrap();
    assert!(
        !p.log
            .iter()
            .any(|c| c.contains("set-option -p -t %3 @tmuxy-ask ")),
        "{:?}",
        p.log
    );
    assert!(p.log.iter().any(|c| c.starts_with("send-keys -t %3")));
    assert!(p.log.iter().any(|c| c.contains("@tmuxy-pane-state unread")));
}

/// `@tmuxy-send-allow mcp` allows every MCP client, whatever it calls itself.
#[tokio::test]
async fn mcp_on_the_allow_list_lets_every_client_type() {
    let (tmux, pane) = fake_monitor(None);
    pane.lock().unwrap().rules = "on\tmcp\t\tzsh\t".into();
    let id = PaneId::parse("%3").unwrap();
    let sent = ask::send_keys(&tmux, &id, &keys(), "cursor", Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(sent["asked"], false);
}

#[tokio::test]
async fn a_declined_send_types_nothing() {
    let (tmux, pane) = fake_monitor(Some("no"));
    let id = PaneId::parse("%3").unwrap();
    let error = ask::send_keys(&tmux, &id, &keys(), "claude-code", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert!(error.error.contains("declined"), "{error:?}");
    let p = pane.lock().unwrap();
    assert!(
        !p.log.iter().any(|c| c.contains("send-keys")),
        "{:?}",
        p.log
    );
    assert!(p.ask.is_empty(), "the question is left up");
}

/// The client hangs up mid-question (its HTTP request dropped): nobody is
/// listening for the answer any more, so the question comes down.
#[tokio::test]
async fn a_client_that_hangs_up_takes_its_question_down() {
    let (tmux, pane) = fake_monitor(None);
    let id = PaneId::parse("%3").unwrap();
    let keys = keys();
    let send = ask::send_keys(&tmux, &id, &keys, "claude-code", Duration::from_secs(60));
    let dropped = tokio::time::timeout(Duration::from_millis(500), send).await;
    assert!(
        dropped.is_err(),
        "nothing answered, so the send was still waiting"
    );
    for _ in 0..100 {
        if pane.lock().unwrap().ask.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let p = pane.lock().unwrap();
    assert!(
        p.ask.is_empty(),
        "the question outlived its sender: {:?}",
        p.log
    );
    assert!(
        p.state.is_empty(),
        "the needs-input mark outlived its sender: {:?}",
        p.log
    );
    assert!(!p.log.iter().any(|c| c.contains("send-keys")));
}
