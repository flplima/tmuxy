//! `tmuxy pane ask`: a script or an agent asks the person a question over a
//! pane, and prints the first answer any client gives. The question is
//! `tmuxy_core::ask`'s `question` kind (`ask/prompt.rs`), put up and waited
//! on as a send question is, over the same [`ask::Subprocess`]. Exit 0 answered ·
//! 1 dismissed, unanswered by `--for` or still behind another question then
//! · 2 bad command line · 3 the pane is gone · 130 interrupted, with the
//! question taken down.

use std::cell::RefCell;

use tmuxy_core::ask::{self, Deadline, Prompt, Question, Refused};
use tmuxy_core::constants::tmux_options::PANE_STATE;
use tmuxy_core::PaneId;

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_TARGET, EXIT_USAGE};
use crate::send_cli;

#[derive(clap::Args, Debug)]
pub struct AskArgs {
    /// The pane to put the question over (a pane id).
    #[arg(long)]
    target: String,
    /// The caller's own pane, when it really runs in one: its program names
    /// the caller.
    #[arg(long)]
    caller_pane: Option<String>,
    /// The caller's process name, for a caller in no pane.
    #[arg(long)]
    caller_process: Option<String>,
    /// One button; repeat for more. Neither this nor --text: Yes and No.
    #[arg(long = "choice", allow_hyphen_values = true)]
    choices: Vec<String>,
    /// A line of text to type, and Submit.
    #[arg(long)]
    text: bool,
    /// Take the question down unanswered after this long (`30s`, `10m`, `2h`).
    #[arg(long = "for")]
    wait_for: Option<String>,
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
    /// The question.
    #[arg(last = true)]
    question: Vec<String>,
}

pub async fn run(args: AskArgs) {
    let answer = Answer::new(args.json);
    let code = match ask(&ask::Subprocess, args).await {
        Ok(said) => {
            answer.done(&[("answer", cli_json::string(&said))], &said);
            0
        }
        Err((code, message)) => answer.fail(code, &message),
    };
    std::process::exit(code);
}

async fn ask<T: ask::Tmux>(tmux: &T, args: AskArgs) -> Result<String, (i32, String)> {
    let pane = PaneId::parse(&args.target)
        .map_err(|_| (EXIT_USAGE, format!("not a pane id: {}", args.target)))?;
    let prompt = Prompt::new(&args.question.join(" "), args.choices, args.text)
        .map_err(|e| (EXIT_USAGE, e))?;
    let deadline = match args.wait_for.as_deref() {
        Some(text) => Some(Deadline::after(send_cli::duration(text)?)),
        None => None,
    };
    let caller_pane = send_cli::verified_pane(tmux, args.caller_pane.as_deref()).await;
    let caller =
        send_cli::caller_name(tmux, caller_pane.as_ref(), args.caller_process.as_deref()).await;
    // The question once it may be up, for an interrupt to take down.
    let up: RefCell<Option<Question>> = RefCell::new(None);
    let asked = async {
        ask::wait_turn(tmux, &pane, deadline).await?;
        // Read after the turn: the state another question left is that
        // question's to give back.
        let state = ask::pane_read(tmux, &pane, &format!("#{{{PANE_STATE}}}"))
            .await
            .map_err(|_| Refused::Gone(pane.clone()))?;
        let pid = std::process::id().to_string();
        let question = Question::asking(&pane, &pid, &caller, &prompt, &state);
        up.replace(Some(question.clone()));
        question.put_up(tmux).await?;
        // Pane output makes the backend re-list the panes promptly, so the
        // question shows within a round trip (as the send verb's notice).
        eprintln!("tmuxy: asking in {pane}: {}", prompt.question());
        question.reply(tmux, &prompt, deadline).await
    };
    let outcome = tokio::select! {
        outcome = asked => outcome,
        () = send_cli::interrupted() => {
            let question = up.borrow_mut().take();
            if let Some(question) = question {
                question.take_down(tmux).await;
            }
            std::process::exit(130);
        }
    };
    let question = up.borrow_mut().take();
    if let Some(question) = question {
        question.take_down(tmux).await;
    }
    outcome.map_err(|refused| refusal(&refused))
}

/// Why no answer came, as the exit code and the message.
fn refusal(refused: &Refused) -> (i32, String) {
    match refused {
        Refused::Declined(pane) => (EXIT_FAILED, format!("dismissed in {pane}")),
        Refused::NoAnswer(pane, waited) => (
            EXIT_FAILED,
            format!("no answer in {pane} after {}s", waited.as_secs()),
        ),
        Refused::Busy(pane) => (
            EXIT_FAILED,
            format!("{pane} was still asking another question when the time ran out"),
        ),
        Refused::Gone(pane) => (EXIT_TARGET, format!("{pane} is gone")),
        other => (EXIT_FAILED, other.to_string()),
    }
}

#[cfg(test)]
mod tests;
