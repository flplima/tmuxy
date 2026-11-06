//! A client's command on its way to tmux, and what comes back for it: a
//! caller's reply, a relayed `run-shell`'s output and exit status, or the
//! output and `%error` of a fire-and-forget command, shown to the person.

use super::*;
use crate::tmux_command::{self, CommandList, SEND_KEYS};

/// Who is waiting on a reply-wrapped command.
pub(super) enum Waiter<W> {
    /// A caller: gets the whole reply, success or not.
    Caller(W),
    /// A fire-and-forget command: nobody wants the output, but a `%error`
    /// is reported so the person learns why nothing happened.
    ReportFailure,
    /// A fire-and-forget `run-shell`, relayed through the server option it
    /// names (`run_shell`): what it printed is shown, and a failure reported.
    RunShell(String),
    /// A caller's `run-shell`, relayed the same way: the caller gets what the
    /// shell command printed, and a non-zero exit as the reply's error.
    CallerRunShell(W, String),
    /// The batch of reads out on a paced link (`reads`): answered, the next
    /// one may go.
    Reads,
}

/// Whether a fire-and-forget command is marker-wrapped so its `%error`
/// reaches the person: everything but keystrokes (`send-keys`, pinned or
/// not). Keystrokes are the hot path — one command per key — and the only
/// way they fail is a vanished pane, which the layout already shows.
pub(super) fn reports_failure(list: &CommandList) -> bool {
    !list.top_level().any(|command| command.runs(&SEND_KEYS))
}

impl<W> MonitorCore<W> {
    /// A command a client sent — routed already (`command_router`) — as the
    /// lines that run it, with `waiter` (the caller, when one wants the
    /// output) registered for its reply.
    ///
    /// One path for a caller and for fire-and-forget, so what has to happen
    /// around a client's command cannot drift between the two: settling for
    /// a multi-step script (`tmux_compat::settles`), the `run-shell` relay
    /// that keeps tmux 3.4's view mode out of a pane tmuxy draws, failure
    /// reporting, and the re-lists after what tmux leaves unannounced
    /// (`tmux_compat::relists_after`).
    pub fn command(&mut self, command: &str, waiter: Option<W>, now: Instant) -> Outgoing {
        let list = tmux_command::parse(command);
        let settles = crate::tmux_compat::settles(&list);
        if settles {
            self.aggregator.arm_settling(now);
            debug!("settling armed for a multi-step script");
        }
        let relists = self
            .aggregator
            .markers()
            .relist_commands(crate::tmux_compat::relists_after(&list));
        let relists = self.relists_behind(relists, now);

        // Taken whether or not the command is wrapped: ids only have to grow.
        let id = self.fresh_reply_id();
        let key = run_shell::relay_key(id);
        let relayed = run_shell::relay_run_shell(command, &key, &self.shell_line);
        let (outgoing, waiter) = match (waiter, relayed) {
            (Some(w), Some(relayed)) => (relayed, Some(Waiter::CallerRunShell(w, key))),
            (Some(w), None) => (command.to_string(), Some(Waiter::Caller(w))),
            (None, Some(relayed)) => (relayed, Some(Waiter::RunShell(key))),
            (None, None) if reports_failure(&list) => {
                (command.to_string(), Some(Waiter::ReportFailure))
            }
            (None, None) => (command.to_string(), None),
        };
        let Some(waiter) = waiter else {
            // Typed text is one `send-keys` per line (a blank one would
            // detach this client), and the connection writes a line each.
            return Outgoing {
                lines: super::super::control_mode_lines(&outgoing)
                    .map(str::to_string)
                    .collect(),
                relists,
                reply_id: None,
                settles,
            };
        };
        self.replies.insert(id, (waiter, now));
        Outgoing {
            lines: self.aggregator.markers().reply_wrapped_lines(id, &outgoing),
            relists,
            reply_id: Some(id),
            settles,
        }
    }

    /// `outgoing` could not be written: its caller is told now rather than
    /// at the timeout, and a settling it armed is lifted.
    pub fn not_sent(&mut self, outgoing: &Outgoing, error: &str) -> Vec<Action<W>> {
        if outgoing.settles {
            self.aggregator.clear_settling();
        }
        let waiter = outgoing.reply_id.and_then(|id| self.replies.remove(&id));
        let mut actions = Vec::new();
        if let Some((Waiter::Caller(w) | Waiter::CallerRunShell(w, _), _)) = waiter {
            actions.push(Action::Answer(w, CommandReply::failed(error)));
        }
        actions.push(Action::Notify(Notice::Error(format!(
            "Failed to run command: {error}"
        ))));
        actions
    }

    /// A reply-wrapped command has finished: its output goes to whoever
    /// asked, or is shown.
    pub(super) fn on_reply(
        &mut self,
        id: u64,
        output: String,
        error: Option<String>,
    ) -> Vec<Action<W>> {
        let mut actions = Vec::new();
        match self.replies.remove(&id) {
            // A caller that stopped waiting is the host's to ignore.
            Some((Waiter::Caller(w), _)) => {
                actions.push(Action::Answer(w, CommandReply { output, error }))
            }
            Some((Waiter::CallerRunShell(w, key), _)) => {
                actions.push(Action::Answer(
                    w,
                    run_shell::caller_reply(&output, &key, error),
                ));
            }
            Some((Waiter::Reads, _)) => self.reads.answered(),
            Some((Waiter::ReportFailure, _)) => {
                messages(&mut actions, output.lines());
                // What the command printed besides messages — a
                // `show-messages` or `list-keys` typed at the prompt — is
                // answered to a control client here, never shown in a pane:
                // one notice, clipped.
                let printed: Vec<&str> = output
                    .lines()
                    .filter(|line| super::super::parser::message_line(line).is_none())
                    .collect();
                if printed.iter().any(|line| !line.trim().is_empty()) {
                    actions.push(Action::Notify(Notice::Message(run_shell::clip_listing(
                        &printed.join("\n"),
                    ))));
                }
                if let Some(error) = error {
                    actions.push(Action::Notify(Notice::Error(error)));
                }
            }
            Some((Waiter::RunShell(key), _)) => {
                let relayed = run_shell::read_relayed(&output, &key);
                messages(&mut actions, relayed.before.into_iter());
                if let Some(error) = error {
                    actions.push(Action::Notify(Notice::Error(error)));
                }
                let notice = match relayed.answer {
                    Some((0, text)) if text.is_empty() => None,
                    Some((0, text)) => Some(Notice::Message(run_shell::clip_output(&text))),
                    Some((rc, text)) if text.is_empty() => {
                        Some(Notice::Error(format!("run-shell exited with status {rc}")))
                    }
                    Some((rc, text)) => Some(Notice::Error(format!(
                        "run-shell exited with status {rc}: {}",
                        run_shell::clip_output(&text)
                    ))),
                    None => None,
                };
                actions.extend(notice.map(Action::Notify));
            }
            None => debug!(id, "reply for an expired or unknown request"),
        }
        actions
    }

    /// Fail every reply that has outlived `REPLY_TIMEOUT` (M7).
    pub(super) fn expire_replies(&mut self, now: Instant) -> Vec<Action<W>> {
        let expired: Vec<u64> = self
            .replies
            .iter()
            .filter(|(_, (_, sent_at))| now.saturating_duration_since(*sent_at) >= REPLY_TIMEOUT)
            .map(|(id, _)| *id)
            .collect();
        let mut actions = Vec::new();
        for id in expired {
            match self.replies.remove(&id) {
                Some((Waiter::Caller(w) | Waiter::CallerRunShell(w, _), _)) => {
                    tracing::warn!(id, "command reply timed out");
                    actions.push(Action::Answer(
                        w,
                        CommandReply::failed("tmux did not answer in time"),
                    ));
                }
                // A batch of reads tmux has not answered in time is given up
                // on, so the reads asked for since still go out.
                Some((Waiter::Reads, _)) => {
                    tracing::warn!(id, "reads not answered in time");
                    self.reads.answered();
                }
                // A long `run-shell` is a legitimate reason for a late END
                // marker; with nobody waiting there is nothing to report.
                Some((Waiter::ReportFailure | Waiter::RunShell(_), _)) | None => {}
            }
        }
        actions
    }
}

/// The `display-message` lines of a fire-and-forget command's output, as
/// notices. A `display-message` this client ran is answered inside its own
/// block, so it is here as output, not as a notification. Nothing else reads
/// this output; a caller's reply is left as tmux sent it.
fn messages<'a, W>(actions: &mut Vec<Action<W>>, lines: impl Iterator<Item = &'a str>) {
    for text in lines.filter_map(super::super::parser::message_line) {
        if !text.is_empty() {
            actions.push(Action::Notify(Notice::Message(text)));
        }
    }
}
