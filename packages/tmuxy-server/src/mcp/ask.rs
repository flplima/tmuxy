//! Typing into a pane for an MCP client: only once the user allows it there,
//! by the protocol `tmuxy_core::ask` holds for every sender. What is the
//! endpoint's own: the client is named as it introduced itself, `mcp` in an
//! `@tmuxy-send-allow` list allows every MCP client, and the question comes
//! down however the wait ends — the HTTP request dropped included.

use serde_json::{json, Value};
use std::time::Duration;
use tmuxy_core::argv::control_line;
use tmuxy_core::ask::{self, Argv, Deadline, Question, SendRules};
use tmuxy_core::permissions::{self, Decision};
use tmuxy_core::{CommandError, PaneId};

use super::tmux::Tmux;

const ANY_MCP_CLIENT: &str = "mcp";

impl ask::Tmux for Tmux {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        Tmux::read(self, &control_line(&argv)).await
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        let line = commands
            .iter()
            .map(|argv| control_line(argv))
            .collect::<Vec<_>>()
            .join(" ; ");
        Tmux::mutate(self, &line).await.map(drop)
    }

    async fn keep_alive(&self) {
        Tmux::keep_alive(self).await;
    }
}

/// Type `keys` into `pane`, asking the user first unless the options say not
/// to. Fails when the user's permissions file denies it, the user declines,
/// the pane goes, or `timeout` passes unanswered — and then nothing was typed.
pub(super) async fn send_keys(
    tmux: &Tmux,
    pane: &PaneId,
    keys: &[String],
    caller: &str,
    timeout: Duration,
    file: &permissions::Loaded,
) -> Result<Value, CommandError> {
    let rules = SendRules::read(tmux, pane).await?;
    // The user's permissions file (`tmuxy_core::permissions`) can refuse the
    // send, or have it asked where an option would skip the question. It
    // skips none.
    let verdict = file.check_send(permissions::Send {
        callers: &[caller, ANY_MCP_CLIENT],
        program: &rules.program,
        keys,
        paste: false,
    });
    if let Decision::Deny(why) = &verdict {
        return Err(CommandError::forbidden(format!("{why}; nothing sent")));
    }
    if verdict == Decision::NoOpinion && rules.skip_question(&[caller, ANY_MCP_CLIENT], pane) {
        ask::Tmux::mutate(tmux, vec![ask::send_keys_argv(pane, keys)]).await?;
        rules.mark_unread(tmux, pane).await?;
        return Ok(json!({ "paneId": pane, "sent": true, "asked": false }));
    }

    let deadline = Some(Deadline::after(timeout));
    ask::wait_turn(tmux, pane, deadline).await?;
    let question = Question::new(pane, ANY_MCP_CLIENT, caller, keys, &rules);
    let guard = QuestionGuard(Some((tmux.clone(), question.clone())));
    question.put_up(tmux).await?;
    let answer = question.answer(tmux, deadline).await;
    guard.take_down().await;
    answer?;
    ask::Tmux::mutate(tmux, vec![ask::send_keys_argv(pane, keys)]).await?;
    Ok(json!({ "paneId": pane, "sent": true, "asked": true }))
}

/// Takes the question off the pane when told to or when dropped — a client
/// that hangs up mid-question must not leave one on screen that nothing is
/// listening to.
struct QuestionGuard(Option<(Tmux, Question)>);

impl QuestionGuard {
    async fn take_down(mut self) {
        if let Some((tmux, question)) = self.0.take() {
            question.take_down(&tmux).await;
        }
    }
}

impl Drop for QuestionGuard {
    fn drop(&mut self) {
        let Some((tmux, question)) = self.0.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { question.take_down(&tmux).await });
        }
    }
}
