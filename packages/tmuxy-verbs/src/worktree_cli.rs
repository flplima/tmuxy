//! `tmuxy worktree remove`: take a linked git worktree away without losing
//! work in it (`tmuxy_core::worktrees::guard`).

use std::path::PathBuf;

use tmuxy_core::worktrees::guard;

use crate::cli_json::{self, Answer, EXIT_FAILED};

#[derive(clap::Args, Debug)]
pub struct WorktreeArgs {
    #[command(subcommand)]
    verb: WorktreeVerb,
    /// Answer in JSON.
    #[arg(long, global = true)]
    json: bool,
}

#[derive(clap::Subcommand, Debug)]
enum WorktreeVerb {
    /// Remove a linked worktree, keeping its branch. Refused while it has
    /// uncommitted changes, untracked files or commits on no remote.
    Remove {
        /// A directory in the worktree; default: the current one.
        path: Option<PathBuf>,
        /// Remove it even so. What it held is said, and the branch stays.
        #[arg(long)]
        force: bool,
    },
}

pub fn run(args: WorktreeArgs) {
    let answer = Answer::new(args.json);
    let WorktreeVerb::Remove { path, force } = args.verb;
    let path = match path.map_or_else(std::env::current_dir, Ok) {
        Ok(path) => path,
        Err(e) => answer.exit(EXIT_FAILED, &format!("current directory: {e}")),
    };
    match guard::remove(&path, force) {
        Ok(removed) => {
            let branch = removed.branch.as_deref().map_or_else(
                || "it was on no branch".to_string(),
                |b| format!("branch {b} kept"),
            );
            let lost = if removed.lost.is_empty() {
                String::new()
            } else {
                format!("; it had {}", removed.lost.said())
            };
            let text = format!("removed {}; {branch}{lost}", removed.path);
            let fields = [
                ("path", cli_json::string(&removed.path)),
                (
                    "branch",
                    removed
                        .branch
                        .as_deref()
                        .map_or_else(|| "null".to_string(), cli_json::string),
                ),
                (
                    "lost",
                    serde_json::to_string(&removed.lost).unwrap_or_else(|_| "null".into()),
                ),
            ];
            answer.done(&fields, &text);
        }
        Err(error) => answer.exit(EXIT_FAILED, &error.to_string()),
    }
}
