//! The question put to another pane's user is `tmuxy_core::ask`, the protocol
//! the MCP endpoint speaks too. The answer keeps the CLI's contract
//! (`packages/tmuxy-cli/README.md`): exit 0 sent · 1 declined, unanswered or
//! failed · 2 bad command line · 3 the pane is gone, and under `--json` one
//! object on stdout.

use std::time::Duration;

use tmuxy_core::ask::{self, Argv, Deadline, Question, Refused, SendRules};
use tmuxy_core::{CommandError, PaneId};

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_TARGET, EXIT_USAGE};

#[derive(clap::Args, Debug)]
pub struct SendArgs {
    /// The pane to type into (a pane id).
    #[arg(long)]
    target: String,
    /// The caller's own pane, when it really runs in one: a send into it asks
    /// nothing, and its program names the caller.
    #[arg(long)]
    caller_pane: Option<String>,
    /// The caller's process name, for a caller in no pane.
    #[arg(long)]
    caller_process: Option<String>,
    /// Give up on an unanswered question after this many seconds.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    timeout: Option<u64>,
    /// Paste the keys, joined by spaces, as one text instead of typing them.
    #[arg(long)]
    paste: bool,
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
    /// The keys: literal text or key names (Enter, C-c, ...).
    #[arg(last = true)]
    keys: Vec<String>,
}

/// The CLI's own `Tmux`: reads as tmux subprocesses, which tmux runs safely
/// beside an attached control-mode client, and every change inside
/// `run-shell` (docs/TMUX.md).
pub(crate) struct CliTmux;

impl ask::Tmux for CliTmux {
    async fn read(&self, argv: Argv) -> Result<String, CommandError> {
        tmuxy_core::session::tmux_output(&argv).map_err(|e| CommandError::tmux(e.to_string()))
    }

    async fn mutate(&self, commands: Vec<Argv>) -> Result<(), CommandError> {
        let argv = commands.join(&";".to_string());
        tmuxy_core::run_shell::tmux(&tmuxy_core::paths::Layout::current(), &argv)
            .map(drop)
            .map_err(|e| CommandError::tmux(e.to_string()))
    }
}

pub async fn run(args: SendArgs) {
    let answer = Answer::new(args.json);
    let code = match send(&CliTmux, args, &answer).await {
        Ok(()) => 0,
        Err((code, message)) => answer.fail(code, &message),
    };
    std::process::exit(code);
}

async fn send<T: ask::Tmux>(
    tmux: &T,
    args: SendArgs,
    answer: &Answer,
) -> Result<(), (i32, String)> {
    let pane = PaneId::parse(&args.target)
        .map_err(|_| (EXIT_USAGE, format!("not a pane id: {}", args.target)))?;
    let mut keys = args.keys;
    if keys.is_empty() {
        return Err((EXIT_USAGE, "keys required".into()));
    }
    if args.paste {
        let text = without_controls(&keys.join(" "));
        if text.is_empty() {
            answer.done(
                &[("sent", "false".into())],
                "nothing to paste: the text held only control characters",
            );
            return Ok(());
        }
        keys = vec![text];
    }
    let delivery = Delivery {
        pane: &pane,
        keys: &keys,
        paste: args.paste,
    };
    let caller_pane = args
        .caller_pane
        .as_deref()
        .and_then(|p| PaneId::parse(p).ok());
    if caller_pane.as_ref() == Some(&pane) {
        return delivery.deliver(tmux, answer).await;
    }

    let caller = caller_name(tmux, caller_pane.as_ref(), args.caller_process.as_deref()).await;
    let rules = SendRules::read(tmux, &pane).await.map_err(failed)?;
    if rules.skip_question(&[&caller], &pane) {
        delivery.deliver(tmux, answer).await?;
        return rules.mark_unread(tmux, &pane).await.map_err(failed);
    }

    let deadline = args
        .timeout
        .map(|s| Deadline::after(Duration::from_secs(s)));
    let question = Question::new(
        &pane,
        &std::process::id().to_string(),
        &caller,
        &keys,
        &rules,
    );
    let asked = async {
        ask::wait_turn(tmux, &pane, deadline).await?;
        question.put_up(tmux).await?;
        // Pane output is what makes the backend re-list the panes promptly:
        // a question asked from a silent pane would otherwise wait for the
        // idle heartbeat to appear.
        eprintln!(
            "tmuxy: waiting for {pane} to allow sending: {}",
            keys.join(" ")
        );
        question.answer(tmux, deadline).await
    };
    let outcome = tokio::select! {
        outcome = asked => outcome,
        () = interrupted() => {
            question.take_down(tmux).await;
            std::process::exit(130);
        }
    };
    // Down before the keys land, so they are never typed under the overlay.
    question.take_down(tmux).await;
    outcome.map_err(|refused| {
        let code = match refused {
            Refused::Gone(_) => EXIT_TARGET,
            _ => EXIT_FAILED,
        };
        (code, refused.to_string())
    })?;
    delivery.deliver(tmux, answer).await
}

/// Who is asking: the program in front in the caller's pane (an agent's own
/// name, not the shell it runs commands through), else the caller's process.
async fn caller_name<T: ask::Tmux>(
    tmux: &T,
    pane: Option<&PaneId>,
    process: Option<&str>,
) -> String {
    let from_pane = match pane {
        Some(pane) => ask::Tmux::read(
            tmux,
            vec![
                "display-message".into(),
                "-p".into(),
                "-t".into(),
                pane.to_string(),
                "#{pane_current_command}".into(),
            ],
        )
        .await
        .unwrap_or_default(),
        None => String::new(),
    };
    let name = [from_pane.trim(), process.unwrap_or_default().trim()]
        .into_iter()
        .find(|name| !name.is_empty())
        .map(|name| tmuxy_core::program::program_name(name).to_string());
    name.unwrap_or_else(|| "a script".to_string())
}

async fn interrupted() {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut int), Ok(mut term)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = int.recv() => {}
        _ = term.recv() => {}
    }
}

fn failed(e: CommandError) -> (i32, String) {
    (EXIT_FAILED, e.error)
}

struct Delivery<'a> {
    pane: &'a PaneId,
    keys: &'a [String],
    paste: bool,
}

impl Delivery<'_> {
    async fn deliver<T: ask::Tmux>(&self, tmux: &T, answer: &Answer) -> Result<(), (i32, String)> {
        let command = if self.paste {
            let buffer = format!(
                "{}{}",
                tmuxy_core::constants::CLI_PASTE_BUFFER_PREFIX,
                std::process::id()
            );
            load_buffer(&buffer, &self.keys.concat()).map_err(|e| (EXIT_FAILED, e))?;
            // -p: bracketed when the program in the pane asked for it
            // (?2004h), so a multi-line paste is inserted rather than run a
            // line at a time.
            [
                "paste-buffer",
                "-p",
                "-d",
                "-b",
                &buffer,
                "-t",
                self.pane.as_str(),
            ]
            .map(String::from)
            .to_vec()
        } else {
            ask::send_keys_argv(self.pane, self.keys)
        };
        ask::Tmux::mutate(tmux, vec![command])
            .await
            .map_err(failed)?;
        answer.done(
            &[
                ("paneId", cli_json::string(self.pane.as_str())),
                ("sent", "true".into()),
            ],
            &format!("sent to {}: {}", self.pane, self.keys.join(" ")),
        );
        Ok(())
    }
}

/// `text` into a named tmux buffer, from stdin: `load-buffer` changes no
/// window, pane or client, so it runs as a plain client.
fn load_buffer(buffer: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = tmuxy_core::session::tmux_command()
        .args(["load-buffer", "-b", buffer, "-"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("running tmux: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("writing the paste: {e}"))?;
    }
    match child.wait() {
        Ok(status) if status.success() => Ok(()),
        _ => Err("tmux could not load the paste".into()),
    }
}

/// A paste arrives between the bracketed-paste markers, and a program that
/// parses its input as ECMA-48 ends the paste on any spelling of the end
/// marker: `ESC [ 0201 ~` and the 8-bit CSI `U+009B 201 ~` as well as the
/// literal one. Without ESC and C1 nothing in the text can start an escape
/// sequence, so every control goes but tab, LF and CR: the rest of C0, DEL,
/// and C1 — the same rule as the client's paste (`withoutControls`,
/// `packages/tmuxy-ui/src/domain/commandHelpers.ts`).
fn without_controls(text: &str) -> String {
    text.chars()
        .filter(|&c| !c.is_control() || matches!(c, '\t' | '\n' | '\r'))
        .collect()
}

#[cfg(test)]
mod tests;
