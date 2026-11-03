//! Typing into a pane for an MCP client: the question, when it is skipped,
//! and how it ends — against a monitor that answers like tmux.

use super::ask::{self, encode_question, program_name, send_keys_command, SendRules};
use super::tmux::Tmux;
use crate::state::AppState;
use base64::Engine as _;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tmuxy_core::control_mode::{CommandReply, MonitorCommand};
use tmuxy_core::session::SessionName;
use tmuxy_core::PaneId;

#[test]
fn the_question_is_skipped_only_when_the_user_said_so() {
    let pane = PaneId::parse("%3").unwrap();
    let rules = |send_ask: &str, allow: &str, allow_into: &str, program: &str| SendRules {
        send_ask: send_ask.into(),
        allow: allow.into(),
        allow_into: allow_into.into(),
        program: program.into(),
        pane_state: String::new(),
    };
    let skips = |r: SendRules, caller: &str| r.skip_question(caller, &pane);
    assert!(!skips(rules("", "", "", "zsh"), "claude-code"));
    assert!(!skips(
        rules("on", "codex,%4", "claude,agy", "zsh"),
        "claude-code"
    ));
    assert!(skips(rules("off", "", "", "zsh"), "claude-code"));
    assert!(skips(
        rules("", "codex, claude-code", "", "zsh"),
        "claude-code"
    ));
    assert!(skips(rules("", "%3", "", "zsh"), "claude-code"));
    assert!(skips(rules("", "mcp", "", "zsh"), "cursor"));
    // Into an agent's prompt: the program in the pane, not who sends.
    assert!(skips(rules("", "", "claude, agy", "agy"), "cursor"));
    assert!(skips(rules("", "", "claude,agy", "claude"), "cursor"));
    assert!(!skips(rules("", "", "claude,agy", ""), "cursor"));
}

/// tmux names a pane's program by the file it runs, and Claude Code's is
/// its version; the allow list says `claude`.
#[test]
fn a_pane_running_claude_code_is_named_claude() {
    assert_eq!(program_name("2.1.314"), "claude");
    assert_eq!(program_name("agy"), "agy");
    assert_eq!(program_name("zsh"), "zsh");
    assert_eq!(program_name("python3.12"), "python3.12");
    assert_eq!(program_name(""), "");
    let parsed = SendRules::parse("on\t\tclaude,agy\t2.1.314\tidle\n");
    assert_eq!(parsed.program, "claude");
    assert_eq!(parsed.allow_into, "claude,agy");
    assert_eq!(parsed.pane_state, "idle");
}

/// What a fake monitor saw, in order, and what it holds of the pane's
/// options.
#[derive(Default)]
struct FakePane {
    ask: String,
    answer: String,
    /// `@tmuxy-pane-state`, as the commands sent left it.
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
                    if part.contains("#{@tmuxy-send-ask}") {
                        output += &format!("{}\n", p.rules);
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
                    } else if let Some(value) =
                        part.strip_prefix("set-option -p -t %3 @tmuxy-ask '")
                    {
                        p.ask = value.trim_end_matches('\'').to_string();
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
                        output += &format!("{}\n", p.answer);
                    } else if part.contains("#{@tmuxy-ask}") {
                        output += &format!("{}\n", p.ask);
                    } else if part.contains("#{@tmuxy-pane-state}") {
                        output += &format!("{}\n", p.state);
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
    let state = Arc::new(AppState::new());
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
    let asked = position("@tmuxy-ask '").expect("the question went up");
    let taken_down = position("set-option -pu -t %3 @tmuxy-ask ;").expect("and came down");
    let typed = position("send-keys").expect("the keys were sent");
    assert!(asked < taken_down && taken_down < typed, "{:?}", p.log);
    assert_eq!(p.log[typed], send_keys_command(&id, &keys()));
    assert_eq!(p.log[typed], "send-keys -t %3 -- 'npm test' 'Enter'");
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
    let marked = p
        .log
        .iter()
        .position(|c| c.contains("@tmuxy-ask '") && c.contains("@tmuxy-pane-state needs-input"));
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
        !p.log.iter().any(|c| c.contains("@tmuxy-ask '")),
        "{:?}",
        p.log
    );
    assert!(p.log.iter().any(|c| c.starts_with("send-keys -t %3")));
    assert!(p.log.iter().any(|c| c.contains("@tmuxy-pane-state unread")));
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

#[test]
fn the_question_carries_who_asks_and_what_they_would_type() {
    let encoded = encode_question("3-mcp-ab", "claude-code", &keys());
    let decoded: Value = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        decoded,
        json!({ "token": "3-mcp-ab", "caller": "claude-code", "keys": ["npm test", "Enter"] })
    );
}
