//! `tmuxy session save|restore|snapshots|forget` — the command line onto
//! session snapshots (`tmuxy_core::session_snapshot`).
//!
//! Everything here runs tmux as a subprocess. That is safe for `save`,
//! `snapshots` and `forget`, which only read; `restore` creates and splits,
//! which must not run as bare subprocesses while a control-mode client is
//! attached (docs/TMUX.md) — so the CLI wraps it in `tmux run-shell`, where
//! this binary's own tmux calls become tmux-internal. From a shell with
//! nothing attached it is simply safe as it is.

use std::path::PathBuf;

use tmuxy_core::session_snapshot::{self as snap, RestoreOptions};

use crate::cli_tmux::tmux;

#[derive(clap::Args, Debug)]
pub struct SessionArgs {
    #[command(subcommand)]
    pub verb: SessionVerb,
}

#[derive(clap::Subcommand, Debug)]
pub enum SessionVerb {
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
        /// Run each pane's program instead of leaving it typed at the prompt.
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
    tmuxy_core::session::session_exists(name).unwrap_or(false)
}

fn dir() -> PathBuf {
    snap::default_dir()
}

fn fail(message: &str) -> ! {
    eprintln!("tmuxy session: {message}");
    std::process::exit(1);
}

pub fn run(args: SessionArgs) {
    match args.verb {
        SessionVerb::Save { name, scrollback } => {
            let name = name.unwrap_or_else(tmuxy_core::session::session_name);
            if !tmuxy_core::session::is_safe_session_name(&name) {
                fail(&format!("not a usable session name: {name:?}"));
            }
            if !session_exists(&name) {
                fail(&format!("no running session called {name:?}"));
            }
            let mut snapshot = snap::take(&name, tmux)
                .unwrap_or_else(|e| fail(&e))
                .snapshot;
            if let Some(lines) = scrollback {
                snap::attach_scrollback(&mut snapshot, lines, tmux);
            }
            match snap::write(&dir(), &snapshot) {
                Ok(Some(path)) => println!("{}", path.display()),
                Ok(None) => println!("unchanged"),
                Err(e) => fail(&e.to_string()),
            }
        }
        SessionVerb::Restore { name, run } => {
            if !tmuxy_core::session::is_safe_session_name(&name) {
                fail(&format!("not a usable session name: {name:?}"));
            }
            if session_exists(&name) {
                fail(&format!("session {name:?} is already running"));
            }
            let snapshot = match snap::read_latest(&dir(), &name) {
                Ok(Some(snapshot)) => snapshot,
                Ok(None) => fail(&format!("no snapshot for {name:?}")),
                Err(e) => fail(&e.to_string()),
            };
            let options = RestoreOptions {
                run,
                fallback_cwd: snap::fallback_cwd(),
                onto_existing_window: false,
                existing_window_index: None,
            };
            snap::apply(&snapshot, &options, tmux).unwrap_or_else(|e| fail(&e));
            println!("{name}");
        }
        SessionVerb::Snapshots => {
            for (name, saved_at) in snap::list(&dir()) {
                let state = if session_exists(&name) {
                    "running"
                } else {
                    "exited"
                };
                println!("{name}\t{}\t{state}", snap::stamp(saved_at));
            }
        }
        SessionVerb::Forget { name, force } => {
            if !tmuxy_core::session::is_safe_session_name(&name) {
                fail(&format!("not a usable session name: {name:?}"));
            }
            if session_exists(&name) {
                if !force {
                    fail(&format!(
                        "session {name:?} is running; --force kills it first, or kill it yourself"
                    ));
                }
                tmux(&["kill-session".to_string(), "-t".to_string(), name.clone()])
                    .unwrap_or_else(|e| fail(&e));
            }
            let removed = snap::forget(&dir(), &name);
            if removed == 0 {
                fail(&format!("no snapshot for {name:?}"));
            }
            println!("{removed}");
        }
    }
}
