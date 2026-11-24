//! A question on a pane, from the moment it goes up to the moment it comes
//! down: put up over the pane's `@tmuxy-ask` with the pane marked
//! `needs-input`, waited on in `@tmuxy-ask-answer`, taken down with the
//! pane's own state given back. A send's question ([`Question::new`]) and a
//! `tmuxy pane ask` question ([`Question::asking`], `prompt.rs`) share all of
//! it; one question at a time per pane ([`wait_turn`]).
//!
//! The question outlives no asker: its payload names the process that put it
//! up and the pane's state before it, so whoever finds it with its asker gone
//! (the host's pane poll, the next asker) takes it down ([`sweep`]) as the
//! asker would have.

use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use serde_json::Value;
use tokio::time::Instant;

use super::{
    pane_read, queue, set_pane, unset_pane, Deadline, Prompt, Refused, SendRules, Tmux,
    NEEDS_INPUT, PENDING_LIMIT, POLL_INTERVAL,
};
use crate::constants::tmux_options::{ASK, ASK_ANSWER, PANE_STATE};
use crate::{CommandError, PaneId};

/// How often a sender waiting its turn checks that the question in its way
/// still has an asker: on macOS each check runs `ps`.
const ASKER_CHECK: Duration = Duration::from_secs(1);

/// The process that put a question up, as the question records it: its pid
/// and when it started, so a pid another process took over after the asker
/// died is not taken for the asker.
#[derive(Debug, Clone)]
pub(super) struct Asker {
    pub(super) pid: u32,
    pub(super) started: String,
}

impl Asker {
    /// This process (the CLI's, or the server's for an MCP client), when it
    /// can tell when it started.
    fn current() -> Option<Self> {
        static CURRENT: OnceLock<Option<Asker>> = OnceLock::new();
        CURRENT
            .get_or_init(|| {
                let pid = std::process::id();
                queue::started(pid).map(|started| Asker { pid, started })
            })
            .clone()
    }

    fn of(payload: &Value) -> Option<Self> {
        let asker = &payload["asker"];
        Some(Self {
            pid: u32::try_from(asker["pid"].as_u64()?).ok()?,
            started: asker["started"]
                .as_str()
                .filter(|started| !started.is_empty())?
                .to_string(),
        })
    }

    fn json(&self) -> Value {
        serde_json::json!({ "pid": self.pid, "started": self.started })
    }
}

/// A question this sender puts up, and what to put back when it comes down.
#[derive(Debug, Clone)]
pub struct Question {
    pub pane: PaneId,
    pub(super) token: String,
    /// `@tmuxy-ask`'s value.
    encoded: String,
    /// The target's `@tmuxy-pane-state` before it was marked `needs-input`.
    prior_state: String,
}

impl Question {
    /// The question `caller` asks to type `keys` into `pane`. `sender` makes
    /// the token unique among the questions that could be up on the pane at
    /// once (the CLI's pid, `mcp`), and a random tail keeps anything else on
    /// the socket from writing an answer it could work out in advance. A mark
    /// an abandoned question left behind is not the pane's own state.
    pub fn new(
        pane: &PaneId,
        sender: &str,
        caller: &str,
        keys: &[String],
        rules: &SendRules,
    ) -> Self {
        let token = Self::token(pane, sender);
        let payload = question_payload(&token, caller, keys);
        Self::with(pane, token, payload, &rules.pane_state, Asker::current())
    }

    /// The question `caller` asks the person in `pane` (`tmuxy pane ask`),
    /// whose `@tmuxy-pane-state` is `pane_state` before it goes up.
    pub fn asking(
        pane: &PaneId,
        sender: &str,
        caller: &str,
        prompt: &Prompt,
        pane_state: &str,
    ) -> Self {
        let token = Self::token(pane, sender);
        let payload = prompt.payload(&token, caller);
        Self::with(pane, token, payload, pane_state, Asker::current())
    }

    fn token(pane: &PaneId, sender: &str) -> String {
        format!("{}-{sender}-{}", pane.number(), crate::random::token())
    }

    /// The question `payload` asks, stamped with its `asker` and the pane's
    /// state to give back (`prior`), which outlive this process in tmux.
    fn with(
        pane: &PaneId,
        token: String,
        mut payload: Value,
        pane_state: &str,
        asker: Option<Asker>,
    ) -> Self {
        let prior_state = Some(pane_state.trim().to_string())
            .filter(|state| state != NEEDS_INPUT)
            .unwrap_or_default();
        if let Some(asker) = asker {
            payload["asker"] = asker.json();
        }
        payload["prior"] = Value::from(prior_state.as_str());
        Self {
            pane: pane.clone(),
            token,
            encoded: base64::engine::general_purpose::STANDARD.encode(payload.to_string()),
            prior_state,
        }
    }

    /// This question as put up by `asker` instead of this process.
    #[cfg(test)]
    pub(super) fn asked_by(&self, asker: Asker) -> Self {
        let mut payload = decode(&self.encoded).expect("a question this module encoded");
        payload["asker"] = asker.json();
        Self {
            encoded: base64::engine::general_purpose::STANDARD.encode(payload.to_string()),
            ..self.clone()
        }
    }

    /// The question `encoded` (`pane`'s `@tmuxy-ask`) when the process that
    /// put it up is gone, rebuilt from what it recorded so it comes down as
    /// its asker would have taken it down. A question that names no asker (a
    /// restore's offer) is never abandoned.
    pub(super) fn abandoned(pane: &PaneId, encoded: &str) -> Option<Self> {
        let encoded = encoded.trim();
        let payload = decode(encoded)?;
        let asker = Asker::of(&payload)?;
        if queue::runs(asker.pid, &asker.started) {
            return None;
        }
        Some(Self {
            pane: pane.clone(),
            token: payload["token"].as_str()?.to_string(),
            encoded: encoded.to_string(),
            prior_state: payload["prior"].as_str().unwrap_or_default().to_string(),
        })
    }

    /// Put the question up. The caller takes it down
    /// ([`Question::take_down`]) however the wait for its [`answer`] ends,
    /// and before the keys land, so they are never typed under the overlay.
    ///
    /// [`answer`]: Question::answer
    pub async fn put_up<T: Tmux>(&self, tmux: &T) -> Result<(), CommandError> {
        let pane = &self.pane;
        // Answer first, question second: a stale answer left by an earlier
        // question would otherwise be read as this one's. The pane the
        // question is over is the one waiting on the user, so it says so.
        tmux.mutate(vec![
            unset_pane(pane, ASK_ANSWER),
            set_pane(pane, ASK, &self.encoded),
            set_pane(pane, PANE_STATE, NEEDS_INPUT),
        ])
        .await
    }

    /// Wait for the user's answer to the question that is up, until
    /// `deadline` when there is one: `Ok` is a yes.
    pub async fn answer<T: Tmux>(
        &self,
        tmux: &T,
        deadline: Option<Deadline>,
    ) -> Result<(), Refused> {
        self.answered(tmux, deadline, |said| match said {
            "yes" => Some(Ok(())),
            "no" => Some(Err(())),
            _ => None,
        })
        .await
    }

    /// Wait for the person's answer to `prompt`, put up as this question
    /// ([`Question::asking`]): the chosen choice's text, or the text typed.
    /// A dismissal is [`Refused::Declined`].
    pub async fn reply<T: Tmux>(
        &self,
        tmux: &T,
        prompt: &Prompt,
        deadline: Option<Deadline>,
    ) -> Result<String, Refused> {
        self.answered(tmux, deadline, |said| prompt.read(said))
            .await
    }

    /// Poll `@tmuxy-ask-answer` until it holds this question's token and an
    /// answer `read` makes out (`Err(())` is a no), or until `deadline`.
    async fn answered<T: Tmux, R>(
        &self,
        tmux: &T,
        deadline: Option<Deadline>,
        read: impl Fn(&str) -> Option<Result<R, ()>>,
    ) -> Result<R, Refused> {
        let pane = &self.pane;
        loop {
            // A pane that is gone cannot be answered in.
            let answer = pane_read(tmux, pane, &format!("#{{{ASK_ANSWER}}}"))
                .await
                .map_err(|e| match e.kind {
                    crate::ErrorKind::Tmux => Refused::Gone(pane.clone()),
                    _ => Refused::Tmux(e),
                })?;
            let said = answer
                .trim()
                .strip_prefix(self.token.as_str())
                .and_then(|rest| rest.strip_prefix(':'));
            match said.and_then(&read) {
                Some(Ok(said)) => return Ok(said),
                Some(Err(())) => return Err(Refused::Declined(pane.clone())),
                None => {}
            }
            if let Some(d) = deadline.filter(|_| Deadline::passed(deadline)) {
                return Err(Refused::NoAnswer(pane.clone(), d.timeout));
            }
            tmux.keep_alive().await;
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// Take the question down, and its `needs-input` mark. Only this sender's
    /// own question comes down: one asked over it after [`PENDING_LIMIT`]
    /// belongs to that sender. The mark comes down only while it is still
    /// this sender's: a state the pane set itself since (an agent's hook) is
    /// newer news and stays. Best effort: a pane that is gone has nothing to
    /// take down.
    pub async fn take_down<T: Tmux>(&self, tmux: &T) {
        let pane = &self.pane;
        let read = |option: &str| {
            let format = format!("#{{{option}}}");
            async move { pane_read(tmux, pane, &format).await.unwrap_or_default() }
        };
        let mut commands = Vec::new();
        if read(ASK).await.trim() == self.encoded {
            commands.push(unset_pane(pane, ASK));
            commands.push(unset_pane(pane, ASK_ANSWER));
        }
        if read(PANE_STATE).await.trim() == NEEDS_INPUT {
            commands.push(if self.prior_state.is_empty() {
                unset_pane(pane, PANE_STATE)
            } else {
                set_pane(pane, PANE_STATE, &self.prior_state)
            });
        }
        if !commands.is_empty() {
            let _ = tmux.mutate(commands).await;
        }
    }
}

/// Take down `pane`'s question when the process that put it up is gone
/// (killed, or its terminal closed), with the pane's state given back as
/// it was before the question: `true` when one came down.
pub async fn sweep<T: Tmux>(tmux: &T, pane: &PaneId) -> Result<bool, CommandError> {
    let asking = pane_read(tmux, pane, &format!("#{{{ASK}}}")).await?;
    let Some(question) = Question::abandoned(pane, &asking) else {
        return Ok(false);
    };
    question.take_down(tmux).await;
    Ok(true)
}

/// One question at a time per pane: asking over another sender's would take
/// its place, so its poll never sees an answer. Wait for it to come down,
/// until `deadline` when there is one. One whose asker is gone is taken down
/// at once; one that names no asker is taken for abandoned after
/// [`PENDING_LIMIT`].
pub async fn wait_turn<T: Tmux>(
    tmux: &T,
    pane: &PaneId,
    deadline: Option<Deadline>,
) -> Result<(), Refused> {
    let give_up = Instant::now() + PENDING_LIMIT;
    let mut next_check = Instant::now();
    loop {
        let asking = pane_read(tmux, pane, &format!("#{{{ASK}}}")).await?;
        if asking.trim().is_empty() || Instant::now() >= give_up {
            return Ok(());
        }
        if Instant::now() >= next_check {
            next_check = Instant::now() + ASKER_CHECK;
            if let Some(question) = Question::abandoned(pane, &asking) {
                question.take_down(tmux).await;
                return Ok(());
            }
        }
        if Deadline::passed(deadline) {
            return Err(Refused::Busy(pane.clone()));
        }
        tmux.keep_alive().await;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub fn encode_question(token: &str, caller: &str, keys: &[String]) -> String {
    base64::engine::general_purpose::STANDARD
        .encode(question_payload(token, caller, keys).to_string())
}

fn question_payload(token: &str, caller: &str, keys: &[String]) -> Value {
    serde_json::json!({ "token": token, "caller": caller, "keys": keys })
}

fn decode(encoded: &str) -> Option<Value> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}
