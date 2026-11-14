//! `tmuxy pane send --inbox`, the agent inbox bridge spike
//! (docs/AGENT-INBOX.md): the text posted to the inbox socket the agent's
//! session recorded on its pane, instead of typed into it. Every refusal is
//! exit 1 with nothing sent, and nothing falls back to typing.
//!
//! The same rule as typing holds: nothing is delivered to a pane at a prompt.
//! A post is not a tmux command, so the check cannot run in the same step as
//! it; the agent's own guarantee (a message never approves anything) covers
//! the moment between.

use tmuxy_core::ask::inbox::{self, Recorded};
use tmuxy_core::ask::{self, Refused};
use tmuxy_core::constants::tmux_options::{AGENT_INBOX, SEND_INBOX};
use tmuxy_core::PaneId;

use crate::cli_json::{EXIT_FAILED, EXIT_TARGET};

pub(super) async fn post<T: ask::Tmux>(
    tmux: &T,
    pane: &PaneId,
    keys: &[String],
    also: Option<&str>,
) -> Result<(), (i32, String)> {
    let nothing = |why: String| (EXIT_FAILED, format!("{why}; nothing sent"));
    let format = format!("#{{{SEND_INBOX}}}\t#{{{AGENT_INBOX}}}\t#{{pane_current_command}}");
    let said = ask::pane_read(tmux, pane, &format)
        .await
        .map_err(|_| (EXIT_TARGET, format!("{pane} is gone")))?;
    let mut fields = said.trim_end_matches('\n').splitn(3, '\t');
    let (on, recorded, program) = (
        fields.next().unwrap_or_default(),
        fields.next().unwrap_or_default(),
        fields.next().unwrap_or_default(),
    );
    if on != "on" {
        return Err(nothing(format!(
            "the agent inbox bridge is off (set -g {SEND_INBOX} on)"
        )));
    }
    let Some(recorded) = Recorded::parse(recorded) else {
        return Err(nothing(format!("no agent inbox is recorded for {pane}")));
    };
    if tmuxy_core::program::program_name(program) != "claude" {
        return Err(nothing(format!("{pane} runs {program}, not Claude Code")));
    }
    // A session that ended without its SessionEnd hook left its path behind:
    // only the process that recorded it may still be posted to.
    if !recorded.still_running() {
        return Err(nothing(format!(
            "the Claude Code session that recorded {pane}'s inbox has ended"
        )));
    }
    let text = inbox::text_of(keys).map_err(nothing)?;
    let at_prompt = ask::at_prompt(tmux, pane)
        .await
        .map_err(|e| (EXIT_FAILED, e.error))?;
    if at_prompt {
        return Err((EXIT_FAILED, Refused::AtPrompt(pane.clone()).to_string()));
    }
    // A queued send taken back meanwhile is not posted.
    if let Some(also) = also {
        let holds = ask::pane_read(tmux, pane, also).await.unwrap_or_default();
        if holds.trim().is_empty() || holds.trim() == "0" {
            return Err((EXIT_FAILED, Refused::Held(pane.clone()).to_string()));
        }
    }
    let socket = inbox::checked(&recorded.path).map_err(nothing)?;
    inbox::post(&socket, &text).map_err(|e| nothing(format!("{}: {e}", socket.display())))
}
