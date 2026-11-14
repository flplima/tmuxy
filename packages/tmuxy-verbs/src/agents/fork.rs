//! `tmuxy agent fork <pane>`: the conversation a pane's agent is having,
//! carried on in a new worktree and tab, as a branch of it: Claude Code's
//! `--resume <id> --fork-session` keeps the original conversation as it is.
//!
//! The session is the one the hooks recorded (`session.rs`), validated the
//! same way, and the command is built from the same table: a recorded value
//! picks an agent and fills in a UUID, nothing more. The worktree comes from
//! `tmuxy worktree new`'s code, in the repository the pane is in.

use tmuxy_core::argv::shell_word;
use tmuxy_core::worktrees::create;

use super::session::{self, Resumable};
use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_TARGET};

#[derive(clap::Args, Debug)]
pub struct ForkArgs {
    /// The pane whose conversation to fork, by id or label.
    pane: String,
    /// The new worktree's branch; default: `fork-<first part of the id>`.
    #[arg(long)]
    branch: Option<String>,
    /// Copy the pane's untracked files into the fork too. Uncommitted
    /// changes to tracked files are always carried.
    #[arg(long)]
    untracked: bool,
}

/// The command that forks `id`, for an agent that can fork.
pub fn fork_argv(kind: Resumable, id: &str) -> Option<Vec<String>> {
    match kind {
        Resumable::Claude => Some(vec![
            "claude".into(),
            "--resume".into(),
            id.into(),
            "--fork-session".into(),
        ]),
        Resumable::Codex => None,
    }
}

/// The tab's shell line: the fork, a word if it fails (a conversation it
/// cannot find, say), then a shell, so the tab outlives it.
pub fn fork_line(argv: &[String]) -> String {
    let words: Vec<String> = argv.iter().map(|w| shell_word(w)).collect();
    format!(
        "{} || echo \"tmuxy: the fork ended with an error (exit $?): see above\"; exec \"${{SHELL:-sh}}\"",
        words.join(" ")
    )
}

/// The branch a fork of `id` gets unless one is named.
pub fn default_branch(id: &str) -> String {
    format!("fork-{}", id.split('-').next().unwrap_or(id))
}

pub fn run(answer: &Answer, args: ForkArgs) {
    let pane =
        super::wait::resolve_one(&args.pane).unwrap_or_else(|(code, e)| answer.exit(code, &e));
    let Some(now) = session::read_pane(&pane) else {
        answer.exit(EXIT_TARGET, &format!("no pane {pane}"))
    };
    let Some((kind, id)) = session::parse(&now.session) else {
        answer.exit(EXIT_FAILED, &format!("{pane} has no agent session to fork"))
    };
    let Some(argv) = fork_argv(kind, &id) else {
        answer.exit(
            EXIT_FAILED,
            &format!("{pane}'s agent cannot fork a conversation"),
        )
    };
    let named = args.branch.is_some();
    let branch = args.branch.unwrap_or_else(|| default_branch(&id));
    let source = std::path::Path::new(&now.path);
    // The fork starts where the pane's worktree is, with its uncommitted
    // work: the conversation is about those files as they are.
    let created = create::head(source)
        .and_then(|base| create::create(source, &branch, Some(&base)))
        .unwrap_or_else(|e| {
            // A second fork of one conversation meets the first's branch.
            let hint = if named {
                ""
            } else {
                "; name another branch with --branch"
            };
            answer.exit(EXIT_FAILED, &format!("{e}{hint}"))
        });
    let carried = create::carry(source, std::path::Path::new(&created.path), args.untracked)
        .unwrap_or_else(|e| {
            let _ = tmuxy_core::worktrees::guard::remove(std::path::Path::new(&created.path), true);
            answer.exit(
                EXIT_FAILED,
                &format!("could not carry the uncommitted work, so no fork was made: {e}"),
            )
        });
    let cwd = tmuxy_core::argv::format_literal(&created.path);
    let tab = crate::run_cli::new_tab(answer, Some(&branch), Some(&cwd), Some(&fork_line(&argv)));
    answer.done(
        &[
            ("path", cli_json::string(&created.path)),
            ("branch", cli_json::string(&created.branch)),
            ("tabId", cli_json::string(&tab)),
            ("session", cli_json::string(&id)),
            ("carried", carried.changed.len().to_string()),
            ("untracked", carried.untracked.len().to_string()),
            (
                "skipped",
                serde_json::to_string(&carried.skipped).unwrap_or_else(|_| "[]".into()),
            ),
        ],
        &format!(
            "{} on branch {}, in tab {tab}; carried {} changed and {} untracked files{}",
            created.path,
            created.branch,
            carried.changed.len(),
            carried.untracked.len(),
            if carried.skipped.is_empty() {
                String::new()
            } else {
                format!(", left behind: {}", carried.skipped.join(", "))
            }
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0b5c2f4e-9d3a-4c1b-8e7f-2a6d9c0e1f34";

    #[test]
    fn only_claude_forks_and_its_command_comes_from_the_table() {
        assert_eq!(
            fork_argv(Resumable::Claude, ID).unwrap(),
            ["claude", "--resume", ID, "--fork-session"]
        );
        assert_eq!(fork_argv(Resumable::Codex, ID), None);
        assert_eq!(
            fork_line(&fork_argv(Resumable::Claude, ID).unwrap()),
            format!(
                "claude --resume {ID} --fork-session || echo \"tmuxy: the fork ended with an \
                 error (exit $?): see above\"; exec \"${{SHELL:-sh}}\""
            )
        );
    }

    #[test]
    fn a_fork_is_on_its_own_branch_by_default() {
        assert_eq!(default_branch(ID), "fork-0b5c2f4e");
    }
}
