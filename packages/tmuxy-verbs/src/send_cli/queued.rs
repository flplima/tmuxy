//! `tmuxy pane send --queue`: wait in line while the pane is busy, then send
//! as any send does (`tmuxy_core::ask::queue`). And `tmuxy pane queue`, which
//! lists the line and takes a send back out of it.
//!
//! A queued send never goes into a pane at a prompt: it waits while the pane
//! is at one, and its keys go in through the same guard as every send, with
//! its place in line as an extra condition, so a retract that lands before
//! the keys stops them. Every way out but a delivery is exit 1 (nothing
//! sent), or 130 when interrupted.

use std::time::Duration;

use tmuxy_core::ask::queue::{self, Entry};
use tmuxy_core::PaneId;

use super::{interrupted, CliTmux, Delivery, Route};
use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_TARGET, EXIT_USAGE};

fn retracted(pane: &PaneId) -> (i32, String) {
    (
        EXIT_FAILED,
        format!("taken out of {pane}'s queue; nothing sent"),
    )
}

pub(super) async fn send<T: tmuxy_core::ask::Tmux>(
    tmux: &T,
    mut delivery: Delivery<'_>,
    route: &Route<'_>,
    stall: Duration,
    answer: &Answer,
) -> Result<(), (i32, String)> {
    let pane = delivery.pane;
    let caller = route.caller(tmux).await;
    let entry = Entry::join(tmux, pane, &caller, delivery.keys)
        .await
        .map_err(|e| (EXIT_TARGET, e.error))?;
    eprintln!(
        "tmuxy: queued for {pane} as {id}; `tmuxy pane queue -t {pane} --retract {id}` takes it back",
        id = entry.id()
    );
    let turn = tokio::select! {
        turn = entry.wait_turn(tmux) => turn,
        () = interrupted() => {
            entry.leave(tmux).await;
            std::process::exit(130);
        }
    };
    match turn {
        Ok(true) => {}
        Ok(false) => return Err(retracted(pane)),
        Err(e) => {
            entry.leave(tmux).await;
            return Err((EXIT_TARGET, format!("{pane} is gone: {}", e.error)));
        }
    }
    delivery.also = Some(entry.condition());
    match route.send(tmux, &delivery, answer).await {
        Ok(()) => {
            entry.leave_once_taken(tmux, stall).await;
            Ok(())
        }
        Err((code, message)) => {
            let taken_back = !entry.in_line(tmux).await.unwrap_or(true);
            entry.leave(tmux).await;
            if code == EXIT_FAILED && taken_back {
                return Err(retracted(pane));
            }
            Err((code, message))
        }
    }
}

#[derive(clap::Args, Debug)]
pub struct QueueArgs {
    /// The pane whose line to read (a pane id).
    #[arg(long)]
    target: String,
    /// Take this send out of the line instead.
    #[arg(long)]
    retract: Option<String>,
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
}

pub async fn run(args: QueueArgs) {
    let answer = Answer::new(args.json);
    let code = match queue_verb(&CliTmux, args, &answer).await {
        Ok(()) => 0,
        Err((code, message)) => answer.fail(code, &message),
    };
    std::process::exit(code);
}

async fn queue_verb<T: tmuxy_core::ask::Tmux>(
    tmux: &T,
    args: QueueArgs,
    answer: &Answer,
) -> Result<(), (i32, String)> {
    let pane = PaneId::parse(&args.target)
        .map_err(|_| (EXIT_USAGE, format!("not a pane id: {}", args.target)))?;
    let gone = |e: tmuxy_core::CommandError| (EXIT_TARGET, format!("{pane}: {}", e.error));
    if let Some(id) = &args.retract {
        if !queue::retract(tmux, &pane, id).await.map_err(gone)? {
            return Err((EXIT_TARGET, format!("no send {id} in {pane}'s queue")));
        }
        answer.done(
            &[
                ("paneId", cli_json::string(pane.as_str())),
                ("retracted", cli_json::string(id)),
            ],
            &format!("took {id} out of {pane}'s queue; none of it was sent"),
        );
        return Ok(());
    }
    let line = queue::list(tmux, &pane).await.map_err(gone)?;
    if args.json {
        let rows: Vec<_> = line
            .iter()
            .map(|q| {
                serde_json::json!({
                    "id": q.id, "caller": q.caller, "keys": q.keys, "waiting": q.waiting,
                })
            })
            .collect();
        println!("{}", serde_json::Value::Array(rows));
    } else if line.is_empty() {
        println!("nothing queued for {pane}");
    }
    for q in line.iter().filter(|_| !args.json) {
        let gone = if q.waiting { "" } else { "  (sender gone)" };
        println!("{}  {}: {}{gone}", q.id, q.caller, q.keys.join(" "));
    }
    Ok(())
}
