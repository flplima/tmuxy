//! What comes back for a command somebody is waiting on: a caller's reply,
//! a relayed `run-shell`'s output and exit status, or the output and
//! `%error` of a fire-and-forget command, shown to the person.

use super::*;

impl<C: ControlLink> TmuxMonitor<C> {
    /// A reply-wrapped command has finished (`SideEffect::CommandReply`):
    /// hand its output to whoever asked, or show it.
    pub(super) fn on_command_reply<E: StateEmitter>(
        &mut self,
        emitter: &E,
        id: u64,
        output: String,
        error: Option<String>,
    ) {
        match self.pending_replies.remove(&id) {
            Some((ReplyWaiter::Caller(reply), _)) => {
                // A caller that stopped waiting is not an error.
                let _ = reply.send(CommandReply { output, error });
            }
            Some((ReplyWaiter::CallerRunShell(reply, key), _)) => {
                let _ = reply.send(super::run_shell::caller_reply(&output, &key, error));
            }
            Some((ReplyWaiter::ReportFailure, _)) => {
                show_messages(emitter, output.lines());
                // What the command printed besides messages — a
                // `show-messages` or `list-keys` typed at the
                // prompt — is answered to a control client here,
                // never shown in a pane: one notice, clipped.
                let printed: Vec<&str> = output
                    .lines()
                    .filter(|line| super::parser::message_line(line).is_none())
                    .collect();
                if printed.iter().any(|line| !line.trim().is_empty()) {
                    emitter.show_message(super::run_shell::clip_listing(&printed.join("\n")));
                }
                if let Some(error) = error {
                    emitter.emit_error(error);
                }
            }
            Some((ReplyWaiter::RunShell(key), _)) => {
                let relayed = super::run_shell::read_relayed(&output, &key);
                show_messages(emitter, relayed.before.into_iter());
                if let Some(error) = error {
                    emitter.emit_error(error);
                }
                match relayed.answer {
                    Some((0, text)) if text.is_empty() => {}
                    Some((0, text)) => emitter.show_message(super::run_shell::clip_output(&text)),
                    Some((rc, text)) if text.is_empty() => {
                        emitter.emit_error(format!("run-shell exited with status {rc}"))
                    }
                    Some((rc, text)) => emitter.emit_error(format!(
                        "run-shell exited with status {rc}: {}",
                        super::run_shell::clip_output(&text)
                    )),
                    None => {}
                }
            }
            None => debug!(id, "reply for an expired or unknown request"),
        }
    }
}

/// Show the `display-message` lines of a fire-and-forget command's output. A
/// `display-message` this client ran is answered inside its own block, so it
/// is here as output, not as a notification. Nothing else reads this output;
/// a caller's reply is left as tmux sent it.
fn show_messages<'a, E: StateEmitter>(emitter: &E, lines: impl Iterator<Item = &'a str>) {
    for text in lines.filter_map(super::parser::message_line) {
        if !text.is_empty() {
            emitter.show_message(text);
        }
    }
}
