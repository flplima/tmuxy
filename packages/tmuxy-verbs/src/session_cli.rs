//! Everything here runs tmux as a subprocess. That is safe for `save` and
//! `snapshots`, which only read; `restore` creates and splits, and
//! `forget --force` kills the session, which must not run as bare subprocesses
//! while a control-mode client is attached (docs/TMUX.md) — so the CLI wraps
//! both in `tmux run-shell`, where this binary's own tmux calls become
//! tmux-internal. From a shell with nothing attached it is simply safe as it is.

use std::path::PathBuf;

use tmuxy_core::session_snapshot as snap;
use tmuxy_core::TmuxError;

use crate::cli_json::{self, Answer, EXIT_FAILED};

fn tmux(argv: Vec<String>) -> std::future::Ready<Result<String, TmuxError>> {
    std::future::ready(tmuxy_core::session::tmux_output(&argv))
}

#[derive(clap::Args, Debug)]
pub struct SessionArgs {
    #[command(subcommand)]
    verb: SessionVerb,
    /// Answer in JSON.
    #[arg(long, global = true)]
    json: bool,
}

#[derive(clap::Subcommand, Debug)]
enum SessionVerb {
    /// Snapshot a running session now (the autosave does this on every change).
    Save {
        /// The session. Defaults to `TMUXY_SESSION`, then `tmuxy`.
        name: Option<String>,
        /// Also keep the last N lines of every pane, replayed on restore.
        #[arg(long, value_name = "N")]
        scrollback: Option<u32>,
    },
    /// Rebuild a session from its latest snapshot. Refuses a running session.
    Restore {
        name: String,
        /// Run each pane's program instead of offering it in a banner.
        #[arg(long)]
        run: bool,
    },
    /// The sessions that have a snapshot, and when it was taken.
    Snapshots,
    /// Delete a session's snapshots. A running session keeps running unless
    /// `--force`, which kills it first.
    Forget {
        name: String,
        #[arg(long)]
        force: bool,
    },
}

fn session_exists(name: &str) -> bool {
    tmuxy_core::session::session_known(name)
}

fn dir() -> PathBuf {
    snap::default_dir()
}

fn fail(answer: &Answer, message: &str) -> ! {
    answer.exit(EXIT_FAILED, message)
}

pub async fn run(args: SessionArgs) {
    let answer = &Answer::new(args.json);
    match args.verb {
        SessionVerb::Save { name, scrollback } => {
            let name = name.unwrap_or_else(tmuxy_core::session::session_name);
            if !tmuxy_core::session::is_safe_session_name(&name) {
                fail(answer, &format!("not a usable session name: {name:?}"));
            }
            if !session_exists(&name) {
                fail(answer, &format!("no running session called {name:?}"));
            }
            let mut snapshot = snap::take(&name, tmux)
                .await
                .unwrap_or_else(|e| fail(answer, &e.to_string()))
                .snapshot;
            if let Some(lines) = scrollback {
                snap::attach_scrollback(&mut snapshot, lines, tmux).await;
            }
            let written = match snap::write(&dir(), &snapshot) {
                Ok(Some(path)) => path.display().to_string(),
                Ok(None) => "unchanged".to_string(),
                Err(e) => fail(answer, &e.to_string()),
            };
            answer.done(&[("output", cli_json::string(&written))], &written);
        }
        SessionVerb::Restore { name, run } => {
            if run && !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
                fail(
                    answer,
                    "--run needs a terminal; without it each command is offered in its pane",
                );
            }
            let running = session_exists(&name);
            let (snapshot, options) =
                snap::named_restore(&name, running, run).unwrap_or_else(|e| fail(answer, &e.error));
            snap::apply(&snapshot, &options, tmux)
                .await
                .unwrap_or_else(|e| fail(answer, &e.to_string()));
            answer.done(&[], &name);
        }
        SessionVerb::Snapshots => {
            let snapshots: Vec<(String, String, &str)> = snap::list(&dir())
                .into_iter()
                .map(|(name, saved_at)| {
                    let state = if session_exists(&name) {
                        "running"
                    } else {
                        "exited"
                    };
                    (name, snap::stamp(saved_at), state)
                })
                .collect();
            if answer.is_json() {
                let rows: Vec<serde_json::Value> = snapshots
                    .iter()
                    .map(|(name, saved, state)| {
                        serde_json::json!({ "name": name, "saved": saved, "state": state })
                    })
                    .collect();
                println!("{}", serde_json::Value::from(rows));
            } else {
                for (name, saved, state) in snapshots {
                    println!("{name}\t{saved}\t{state}");
                }
            }
        }
        SessionVerb::Forget { name, force } => {
            if !tmuxy_core::session::is_safe_session_name(&name) {
                fail(answer, &format!("not a usable session name: {name:?}"));
            }
            if session_exists(&name) {
                if !force {
                    fail(
                        answer,
                        &format!(
                        "session {name:?} is running; --force kills it first, or kill it yourself"
                    ),
                    );
                }
                tmux(vec![
                    "kill-session".to_string(),
                    "-t".to_string(),
                    name.clone(),
                ])
                .await
                .unwrap_or_else(|e| fail(answer, &e.to_string()));
            }
            let removed = snap::forget(&dir(), &name);
            if removed == 0 {
                fail(answer, &format!("no snapshot for {name:?}"));
            }
            answer.done(&[("removed", removed.to_string())], &removed.to_string());
        }
    }
}
