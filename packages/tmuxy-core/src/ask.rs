//! Typing into a pane that is not the sender's own: only once the user allows
//! it there. The protocol is written once, here, for both senders — the CLI's
//! `tmuxy pane send -t` (a process of its own, `tmuxy-server send`) and the
//! MCP endpoint's `pane_send_keys` (on a session's control-mode connection) —
//! each over the [`Tmux`] it has. The UI is the answering end
//! (`packages/tmuxy-ui/src/domain/paneAsk.ts`).
//!
//! The target pane's `@tmuxy-ask` carries base64 of `{token, caller, keys}`
//! (base64 because `list-panes` is comma-separated and the keys are free
//! text). The UI blurs the pane, asks "`<caller>` wants to send `<keys>`.
//! Allow?", and writes `<token>:yes` or `<token>:no` to `@tmuxy-ask-answer`;
//! the token pins the answer to the question that was on screen. While the
//! question is up the target pane says it needs the user (`needs-input`),
//! and what it said before comes back when the question comes down.
//!
//! `@tmuxy-send-ask off` skips the question, and so does an `@tmuxy-send-allow`
//! entry naming the caller (or a word the sender answers to, as `mcp` for
//! every MCP client) or the target pane, and an `@tmuxy-send-allow-into` entry
//! naming the program in front in the target pane (`claude,agy`: an agent's
//! prompt, which an agent may type into). A send that skips it still marks
//! the pane unread, so nothing is typed into a pane unseen.
//!
//! The user's `permissions.json` ([`crate::permissions`]) is heard first by
//! both senders: a rule of it can refuse a send outright, or have it asked
//! where one of these options would have skipped the question.
//!
//! The same option carries two other kinds of question, each with a `kind`
//! a send question's payload does not have: a restore's `offer`, and the
//! `question` a script or an agent asks the person with `tmuxy pane ask`
//! ([`prompt`]), which this module puts up and waits on as it does a send's.

use std::future::Future;
use std::time::Duration;

use tokio::time::Instant;

use crate::constants::tmux_options::{
    PANE_STATE, SEND_ALLOW, SEND_ALLOW_INTO, SEND_ASK, SEND_HELD,
};
use crate::{CommandError, PaneId};

pub use prompt::{Answers, Prompt};
pub use question::{encode_question, wait_turn, Question};

pub type Argv = Vec<String>;

/// Where a sender's commands go: reads that print, and lists of mutations run
/// as one. A value in a command is always one word of its argv, so each
/// transport quotes it for the reader it goes to.
pub trait Tmux: Sync {
    fn read(&self, argv: Argv) -> impl Future<Output = Result<String, CommandError>> + Send;
    /// Run a list of commands that change something, in one go.
    fn mutate(&self, commands: Vec<Argv>) -> impl Future<Output = Result<(), CommandError>> + Send;
    /// Called on every poll of a wait: the MCP endpoint keeps its monitor held.
    fn keep_alive(&self) -> impl Future<Output = ()> + Send {
        async {}
    }
}

/// How often the answer is read. tmux announces no change to a user option,
/// so there is nothing to block on, and this only runs while a question is on
/// screen.
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// How long a send waits its turn behind another sender's question before
/// taking it for abandoned (a killed sender's) and asking over it.
const PENDING_LIMIT: Duration = Duration::from_secs(60);

const NEEDS_INPUT: &str = crate::PaneStateName::NeedsInput.as_str();

/// How long a send may take, from the moment it starts waiting its turn.
#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    at: Instant,
    timeout: Duration,
}

impl Deadline {
    pub fn after(timeout: Duration) -> Self {
        Self {
            at: Instant::now() + timeout,
            timeout,
        }
    }

    fn passed(deadline: Option<Self>) -> bool {
        deadline.is_some_and(|d| Instant::now() >= d.at)
    }
}

/// Why a send typed nothing.
#[derive(Debug, Clone, PartialEq)]
pub enum Refused {
    /// The user answered no.
    Declined(PaneId),
    /// The question went unanswered for the whole timeout.
    NoAnswer(PaneId, Duration),
    /// Another sender's question was still up at the deadline.
    Busy(PaneId),
    /// The pane went away while the question was up.
    Gone(PaneId),
    /// The pane is waiting at a prompt for the user (it says `needs-input`,
    /// or its screen shows an approval dialog). Nothing is typed into it,
    /// asked or not: a key there could answer the prompt.
    AtPrompt(PaneId),
    /// The condition the sender added to the guard ([`deliver_when`]) did
    /// not hold as the keys would have gone in.
    Held(PaneId),
    /// tmux failed a read or a write.
    Tmux(CommandError),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Declined(pane) => write!(f, "declined in {pane}; nothing sent"),
            Refused::NoAnswer(pane, waited) => write!(
                f,
                "no answer from {pane} after {}s; nothing sent",
                waited.as_secs()
            ),
            Refused::Busy(pane) => write!(
                f,
                "{pane} is still asking another sender's question; nothing sent"
            ),
            Refused::Gone(pane) => write!(f, "{pane} is gone; nothing sent"),
            Refused::AtPrompt(pane) => write!(
                f,
                "{pane} is waiting at a prompt for the user (needs input); nothing sent"
            ),
            Refused::Held(pane) => write!(
                f,
                "{pane} no longer met the sender's condition as the keys went in; nothing sent"
            ),
            Refused::Tmux(e) => write!(f, "{}", e.error),
        }
    }
}

impl From<CommandError> for Refused {
    fn from(e: CommandError) -> Self {
        Refused::Tmux(e)
    }
}

impl From<Refused> for CommandError {
    fn from(refused: Refused) -> Self {
        match refused {
            Refused::Tmux(e) => e,
            Refused::NoAnswer(..) | Refused::Busy(_) => {
                CommandError::unavailable(refused.to_string())
            }
            Refused::Declined(_) | Refused::Gone(_) | Refused::AtPrompt(_) | Refused::Held(_) => {
                CommandError::invalid(refused.to_string())
            }
        }
    }
}

/// What decides whether a send into a pane asks first.
#[derive(Debug, Default, PartialEq)]
pub struct SendRules {
    /// `@tmuxy-send-ask`: `off` never asks.
    pub send_ask: String,
    /// `@tmuxy-send-allow`: callers and panes that never ask.
    pub allow: String,
    /// `@tmuxy-send-allow-into`: programs a pane may be running for a send
    /// into it not to ask.
    pub allow_into: String,
    /// The program in front in the target pane, by its name
    /// ([`crate::program::program_name`]).
    pub program: String,
    /// `@tmuxy-pane-state`, which a send that does not ask marks unread.
    pub pane_state: String,
}

impl SendRules {
    /// The options a send reads off its target pane, in one `display-message`.
    fn format() -> String {
        format!(
            "#{{{SEND_ASK}}}\t#{{{SEND_ALLOW}}}\t#{{{SEND_ALLOW_INTO}}}\t#{{pane_current_command}}\t#{{{PANE_STATE}}}"
        )
    }

    pub fn parse(line: &str) -> Self {
        let mut fields = line.trim_end_matches('\n').split('\t');
        let mut next = || fields.next().unwrap_or_default().to_string();
        Self {
            send_ask: next(),
            allow: next(),
            allow_into: next(),
            program: crate::program::program_name(&next()).to_string(),
            pane_state: next(),
        }
    }

    pub async fn read<T: Tmux>(tmux: &T, pane: &PaneId) -> Result<Self, CommandError> {
        Ok(Self::parse(&pane_read(tmux, pane, &Self::format()).await?))
    }

    pub fn skip_question(&self, callers: &[&str], pane: &PaneId) -> bool {
        self.send_ask == "off"
            || entries(&self.allow).any(|entry| entry == pane.as_str() || callers.contains(&entry))
            || (!self.program.is_empty() && entries(&self.allow_into).any(|e| e == self.program))
    }

    /// After a send that skipped the question: the pane is unread, unless it
    /// says something louder about itself. tmux decides that as it marks it,
    /// not from the state read before the keys went in: an agent that took
    /// them up and already says it is working stays working. The client
    /// clears the mark once the user looks at the pane.
    pub async fn mark_unread<T: Tmux>(&self, tmux: &T, pane: &PaneId) -> Result<(), CommandError> {
        if !(self.pane_state.is_empty() || self.pane_state == "idle") {
            return Ok(());
        }
        let quiet = format!("#{{||:#{{==:#{{{PANE_STATE}}},}},#{{==:#{{{PANE_STATE}}},idle}}}}");
        let mark = set_pane(pane, PANE_STATE, "unread")
            .iter()
            .map(|word| crate::tmux_quote(word))
            .collect::<Vec<_>>()
            .join(" ");
        tmux.mutate(vec![words(&[
            "if-shell",
            "-F",
            "-t",
            pane.as_str(),
            &quiet,
            &mark,
        ])])
        .await
    }
}

fn entries(list: &str) -> impl Iterator<Item = &str> + '_ {
    list.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
}

/// Whether `pane` is waiting at a prompt for the user: it says so
/// (`needs-input`), or the bottom of its screen shows an approval dialog
/// (`crate::agent_dialog`), whatever program draws it. Read fresh, never
/// from rules read earlier: a dialog can open while a sender waits its turn.
pub async fn at_prompt<T: Tmux>(tmux: &T, pane: &PaneId) -> Result<bool, CommandError> {
    let state = pane_read(tmux, pane, &format!("#{{{PANE_STATE}}}")).await?;
    if state.trim() == NEEDS_INPUT {
        return Ok(true);
    }
    let screen = tmux
        .read(words(&["capture-pane", "-p", "-t", pane.as_str()]))
        .await?;
    Ok(crate::agent_dialog::shows_dialog(&screen))
}

/// `command` (what types into `pane`: a `send-keys`, a `paste-buffer`) as
/// one `if-shell` that tmux runs only while `pane` does not say it needs the
/// user, decided in the same step that would type it, so a prompt that opens
/// between a check and the keys cannot be answered by them. Otherwise tmux
/// marks the pane with `@tmuxy-send-held-<token>` ([`SEND_HELD`]), an
/// option of this send's own, so a send beside it can neither read the mark
/// as its own nor clear it. `also`, a tmux format, must hold too (a program
/// still in front, a queued send not retracted).
pub fn guarded(pane: &PaneId, command: &[String], token: &str, also: Option<&str>) -> Argv {
    let line = |argv: &[String]| {
        argv.iter()
            .map(|word| crate::tmux_quote(word))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let free = format!("#{{!=:#{{{PANE_STATE}}},{NEEDS_INPUT}}}");
    let condition = match also {
        Some(also) => format!("#{{&&:{free},{also}}}"),
        None => free,
    };
    words(&[
        "if-shell",
        "-F",
        "-t",
        pane.as_str(),
        &condition,
        &line(command),
        &line(&set_pane(pane, &format!("{SEND_HELD}-{token}"), "1")),
    ])
}

/// Type into `pane` with `command`, unless it is waiting at a prompt: its
/// screen is read first ([`at_prompt`]), and tmux checks its state again as
/// it types ([`guarded`]). The one way a sender types into a pane.
pub async fn deliver<T: Tmux>(tmux: &T, pane: &PaneId, command: Argv) -> Result<(), Refused> {
    deliver_when(tmux, pane, command, None).await
}

/// [`deliver`], with `also` (a tmux format) checked by tmux in the same step
/// as the pane's state: `#{==:#{pane_current_command},claude}` sends only
/// while that program is still in front. Refused with [`Refused::Held`]
/// when `also` failed and the pane is not at a prompt.
pub async fn deliver_when<T: Tmux>(
    tmux: &T,
    pane: &PaneId,
    command: Argv,
    also: Option<&str>,
) -> Result<(), Refused> {
    if at_prompt(tmux, pane).await.map_err(Refused::Tmux)? {
        return Err(Refused::AtPrompt(pane.clone()));
    }
    let token = crate::random::token();
    tmux.mutate(vec![guarded(pane, &command, &token, also)])
        .await
        .map_err(Refused::Tmux)?;
    let held = pane_read(tmux, pane, &format!("#{{{SEND_HELD}-{token}}}"))
        .await
        .map_err(Refused::Tmux)?;
    if held.trim().is_empty() {
        return Ok(());
    }
    let _ = tmux
        .mutate(vec![unset_pane(pane, &format!("{SEND_HELD}-{token}"))])
        .await;
    if also.is_some() && !at_prompt(tmux, pane).await.unwrap_or(true) {
        return Err(Refused::Held(pane.clone()));
    }
    Err(Refused::AtPrompt(pane.clone()))
}

/// The keys as one `send-keys`: an explicit target, and `--` so a key that
/// looks like a flag is typed.
pub fn send_keys_argv(pane: &PaneId, keys: &[String]) -> Argv {
    let mut argv = words(&["send-keys", "-t", pane.as_str(), "--"]);
    argv.extend(keys.iter().cloned());
    argv
}

/// `format` as `pane` itself answers it. tmux's `display-message` does not
/// fail when the target is gone: it answers for no pane, or for its default
/// one when a client is attached. So the answer carries the pane's own id,
/// and any other answer counts as the pane being gone: an error of kind
/// `Tmux`, as when tmux refuses a read.
pub async fn pane_read<T: Tmux>(
    tmux: &T,
    pane: &PaneId,
    format: &str,
) -> Result<String, CommandError> {
    let said = tmux
        .read(display(pane, &format!("#{{pane_id}}\t{format}")))
        .await?;
    match said.split_once('\t') {
        Some((id, rest)) if id == pane.as_str() => Ok(rest.to_string()),
        _ => Err(CommandError::tmux(format!("{pane} is gone"))),
    }
}

fn display(pane: &PaneId, format: &str) -> Argv {
    words(&["display-message", "-p", "-t", pane.as_str(), format])
}

fn set_pane(pane: &PaneId, option: &str, value: &str) -> Argv {
    words(&["set-option", "-p", "-t", pane.as_str(), option, value])
}

fn unset_pane(pane: &PaneId, option: &str) -> Argv {
    words(&["set-option", "-pu", "-t", pane.as_str(), option])
}

fn words(words: &[&str]) -> Argv {
    words.iter().map(|w| w.to_string()).collect()
}

#[cfg(unix)]
pub mod inbox;
pub mod prompt;
mod question;
pub mod queue;

#[cfg(test)]
mod tests;
