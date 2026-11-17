//! A question on a pane, from the moment it goes up to the moment it comes
//! down: put up over the pane's `@tmuxy-ask` with the pane marked
//! `needs-input`, waited on in `@tmuxy-ask-answer`, taken down with the
//! pane's own state given back. A send's question ([`Question::new`]) and a
//! `tmuxy pane ask` question ([`Question::asking`], `prompt.rs`) share all of
//! it; one question at a time per pane ([`wait_turn`]).

use base64::Engine as _;
use tokio::time::Instant;

use super::{
    pane_read, set_pane, unset_pane, Deadline, Prompt, Refused, SendRules, Tmux, NEEDS_INPUT,
    PENDING_LIMIT, POLL_INTERVAL,
};
use crate::constants::tmux_options::{ASK, ASK_ANSWER, PANE_STATE};
use crate::{CommandError, PaneId};

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
        let encoded = encode_question(&token, caller, keys);
        Self::with(pane, token, encoded, &rules.pane_state)
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
        let encoded = prompt.encode(&token, caller);
        Self::with(pane, token, encoded, pane_state)
    }

    fn token(pane: &PaneId, sender: &str) -> String {
        format!("{}-{sender}-{}", pane.number(), crate::random::token())
    }

    fn with(pane: &PaneId, token: String, encoded: String, pane_state: &str) -> Self {
        Self {
            pane: pane.clone(),
            token,
            encoded,
            prior_state: Some(pane_state.trim().to_string())
                .filter(|state| state != NEEDS_INPUT)
                .unwrap_or_default(),
        }
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

/// One question at a time per pane: asking over another sender's would take
/// its place, so its poll never sees an answer. Wait for it to come down,
/// until `deadline` when there is one, or until [`PENDING_LIMIT`] says it was
/// abandoned.
pub async fn wait_turn<T: Tmux>(
    tmux: &T,
    pane: &PaneId,
    deadline: Option<Deadline>,
) -> Result<(), Refused> {
    let abandoned = Instant::now() + PENDING_LIMIT;
    loop {
        let asking = pane_read(tmux, pane, &format!("#{{{ASK}}}")).await?;
        if asking.trim().is_empty() || Instant::now() >= abandoned {
            return Ok(());
        }
        if Deadline::passed(deadline) {
            return Err(Refused::Busy(pane.clone()));
        }
        tmux.keep_alive().await;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub fn encode_question(token: &str, caller: &str, keys: &[String]) -> String {
    let payload = serde_json::json!({ "token": token, "caller": caller, "keys": keys });
    base64::engine::general_purpose::STANDARD.encode(payload.to_string())
}
