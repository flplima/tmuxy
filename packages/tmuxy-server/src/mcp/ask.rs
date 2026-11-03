//! Typing into a pane for an MCP client: only once the user allows it there.
//!
//! The same question `tmuxy pane send -t` asks (`packages/tmuxy-cli/bin/tmuxy/send`
//! holds the protocol's other copy, the UI the answering end): the target
//! pane's `@tmuxy-ask` carries base64 of `{token, caller, keys}`, the UI blurs
//! the pane and asks "`<caller>` wants to send `<keys>`. Allow?", and writes
//! `<token>:yes` or `<token>:no` to `@tmuxy-ask-answer`. The keys go on yes,
//! nothing goes on no, and the question comes down however the wait ends —
//! the HTTP request dropped included.
//!
//! `@tmuxy-send-ask off` skips the question, and so does an
//! `@tmuxy-send-allow` entry naming the client (as it introduced itself), the
//! target pane, or `mcp` for every MCP client, and an `@tmuxy-send-allow-into`
//! entry naming the program in front in the target pane (`claude,agy`: an
//! agent's prompt, which an agent may type into). A send that skips it still
//! marks the pane unread, so nothing is typed into a pane unseen.

use base64::Engine as _;
use serde_json::{json, Value};
use std::time::Duration;
use tmuxy_core::control_mode::MonitorCommandSender;
use tmuxy_core::{tmux_quote, transport, CommandError, ErrorKind, PaneId};
use tokio::time::Instant;

use super::tmux::Tmux;

/// How often the answer is read. tmux announces no change to a user option,
/// and this only runs while a question is on screen.
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// How long a send waits its turn behind another sender's question before
/// taking it for abandoned, as the CLI does.
const PENDING_LIMIT: Duration = Duration::from_secs(60);

/// The allow-list word for every MCP client.
const ANY_MCP_CLIENT: &str = "mcp";

/// The options a send reads off its target pane, in one `display-message`.
const SEND_RULES_FORMAT: &str =
    "#{@tmuxy-send-ask}\t#{@tmuxy-send-allow}\t#{@tmuxy-send-allow-into}\t#{pane_current_command}\t#{@tmuxy-pane-state}";

/// What decides whether a send into a pane asks first.
#[derive(Debug, Default, PartialEq)]
pub(super) struct SendRules {
    /// `@tmuxy-send-ask`: `off` never asks.
    pub send_ask: String,
    /// `@tmuxy-send-allow`: callers and panes that never ask.
    pub allow: String,
    /// `@tmuxy-send-allow-into`: programs a pane may be running for a send
    /// into it not to ask.
    pub allow_into: String,
    /// The program in front in the target pane, by its name.
    pub program: String,
    /// `@tmuxy-pane-state`, which a send that does not ask marks unread.
    pub pane_state: String,
}

impl SendRules {
    pub(super) fn parse(line: &str) -> Self {
        let mut fields = line.trim_end_matches('\n').split('\t').map(str::to_string);
        let mut next = || fields.next().unwrap_or_default();
        Self {
            send_ask: next(),
            allow: next(),
            allow_into: next(),
            program: program_name(&next()),
            pane_state: next(),
        }
    }

    /// Whether the question is skipped: asking is off, the allow list names
    /// the caller, the pane or every MCP client, or the program in the pane
    /// is one sends may go into.
    pub(super) fn skip_question(&self, caller: &str, pane: &PaneId) -> bool {
        self.send_ask == "off"
            || entries(&self.allow)
                .any(|entry| entry == caller || entry == ANY_MCP_CLIENT || entry == pane.as_str())
            || (!self.program.is_empty() && entries(&self.allow_into).any(|e| e == self.program))
    }
}

/// A comma list's entries, spaces dropped, empty ones skipped.
fn entries(list: &str) -> impl Iterator<Item = String> + '_ {
    list.split(',')
        .map(|entry| entry.replace(' ', ""))
        .filter(|entry| !entry.is_empty())
}

/// A program as an allow list names it. Claude Code runs as
/// `…/claude/versions/<version>`, so tmux reports a bare version (`2.1.314`)
/// for it; the CLI's `send` reads it the same way.
pub(super) fn program_name(command: &str) -> String {
    let is_version = command.contains('.')
        && command
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    if is_version {
        "claude".to_string()
    } else {
        command.to_string()
    }
}

/// `@tmuxy-ask`'s value: base64 of the question, so the free-text keys survive
/// a comma-separated `list-panes`.
pub(super) fn encode_question(token: &str, caller: &str, keys: &[String]) -> String {
    let payload = json!({ "token": token, "caller": caller, "keys": keys });
    base64::engine::general_purpose::STANDARD.encode(payload.to_string())
}

/// The keys as one `send-keys`: an explicit target, and `--` so a key that
/// looks like a flag is typed.
pub(super) fn send_keys_command(pane: &PaneId, keys: &[String]) -> String {
    let keys: Vec<String> = keys.iter().map(|k| tmux_quote(k)).collect();
    format!("send-keys -t {pane} -- {}", keys.join(" "))
}

/// Type `keys` into `pane`, asking the user first unless the options say not
/// to. Fails when the user declines, the pane goes, or `timeout` passes
/// unanswered — and then nothing was typed.
pub(super) async fn send_keys(
    tmux: &Tmux,
    pane: &PaneId,
    keys: &[String],
    caller: &str,
    timeout: Duration,
) -> Result<Value, CommandError> {
    let rules = SendRules::parse(
        &tmux
            .read(&format!(
                "display-message -p -t {pane} {}",
                tmux_quote(SEND_RULES_FORMAT)
            ))
            .await?,
    );

    if rules.skip_question(caller, pane) {
        tmux.mutate(&send_keys_command(pane, keys)).await?;
        if rules.pane_state.is_empty() || rules.pane_state == "idle" {
            tmux.mutate(&format!("set-option -p -t {pane} @tmuxy-pane-state unread"))
                .await?;
        }
        return Ok(json!({ "paneId": pane, "sent": true, "asked": false }));
    }

    let deadline = Instant::now() + timeout;
    wait_for_other_question(tmux, pane, deadline).await?;

    let token = format!(
        "{}-mcp-{:016x}{:016x}",
        pane.number(),
        super::random_u64(),
        super::random_u64()
    );
    let question = encode_question(&token, caller, keys);
    // Armed before the question goes up: a request dropped from here on
    // still takes it down.
    let guard = QuestionGuard {
        tx: Some(tmux.channel().clone()),
        session: tmux.session().to_string(),
        pane: pane.clone(),
        question: question.clone(),
    };
    // Answer first, question second: a stale answer left by an earlier
    // question would otherwise be read as this one's.
    tmux.mutate(&format!(
        "set-option -pu -t {pane} @tmuxy-ask-answer ; set-option -p -t {pane} @tmuxy-ask {}",
        tmux_quote(&question)
    ))
    .await?;

    let answer = wait_for_answer(tmux, pane, &token, deadline, timeout).await;
    // Down before the keys land, so they are never typed under the overlay.
    guard.take_down().await;
    match answer? {
        Answer::Yes => {
            tmux.mutate(&send_keys_command(pane, keys)).await?;
            Ok(json!({ "paneId": pane, "sent": true, "asked": true }))
        }
        Answer::No => Err(CommandError::invalid(format!(
            "declined in {pane}; nothing sent"
        ))),
    }
}

enum Answer {
    Yes,
    No,
}

/// One question at a time per pane: wait for another sender's to be
/// answered, until the deadline, or until `PENDING_LIMIT` says it was
/// abandoned.
async fn wait_for_other_question(
    tmux: &Tmux,
    pane: &PaneId,
    deadline: Instant,
) -> Result<(), CommandError> {
    let abandoned = Instant::now() + PENDING_LIMIT;
    loop {
        let asking = tmux
            .read(&format!("display-message -p -t {pane} '#{{@tmuxy-ask}}'"))
            .await?;
        if asking.trim().is_empty() || Instant::now() >= abandoned {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(CommandError::unavailable(format!(
                "{pane} is still asking another sender's question; nothing sent"
            )));
        }
        tmux.keep_alive().await;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn wait_for_answer(
    tmux: &Tmux,
    pane: &PaneId,
    token: &str,
    deadline: Instant,
    timeout: Duration,
) -> Result<Answer, CommandError> {
    let yes = format!("{token}:yes");
    let no = format!("{token}:no");
    loop {
        // A pane that is gone cannot be answered in: tmux fails the read.
        let answer = tmux
            .read(&format!(
                "display-message -p -t {pane} '#{{@tmuxy-ask-answer}}'"
            ))
            .await
            .map_err(|e| match e.kind {
                ErrorKind::Tmux => CommandError::invalid(format!("{pane} is gone; nothing sent")),
                _ => e,
            })?;
        let answer = answer.trim();
        if answer == yes {
            return Ok(Answer::Yes);
        }
        if answer == no {
            return Ok(Answer::No);
        }
        if Instant::now() >= deadline {
            return Err(CommandError::unavailable(format!(
                "no answer from {pane} after {}s; nothing sent",
                timeout.as_secs()
            )));
        }
        tmux.keep_alive().await;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Takes the question off the pane, when told to or when dropped — a client
/// that hangs up mid-question must not leave one on screen that nothing is
/// listening to. Only this sender's own question: one asked over it after
/// `PENDING_LIMIT` belongs to that sender.
struct QuestionGuard {
    tx: Option<MonitorCommandSender>,
    session: String,
    pane: PaneId,
    question: String,
}

impl QuestionGuard {
    async fn take_down(mut self) {
        if let Some(tx) = self.tx.take() {
            take_down(
                tx,
                self.session.clone(),
                self.pane.clone(),
                self.question.clone(),
            )
            .await;
        }
    }
}

impl Drop for QuestionGuard {
    fn drop(&mut self) {
        let Some(tx) = self.tx.take() else { return };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(take_down(
            tx,
            std::mem::take(&mut self.session),
            self.pane.clone(),
            std::mem::take(&mut self.question),
        ));
    }
}

async fn take_down(tx: MonitorCommandSender, session: String, pane: PaneId, question: String) {
    let up = transport::query(
        &tx,
        &format!("display-message -p -t {pane} '#{{@tmuxy-ask}}'"),
    )
    .await
    .unwrap_or_default();
    if up.trim() != question {
        return;
    }
    let _ = transport::run_with_output(
        &tx,
        &format!(
            "set-option -pu -t {pane} @tmuxy-ask ; set-option -pu -t {pane} @tmuxy-ask-answer"
        ),
        &session,
        None,
    )
    .await;
}
