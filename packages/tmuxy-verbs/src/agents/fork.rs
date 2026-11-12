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

/// The tab's shell line: the fork, then a shell, so the tab outlives it.
pub fn fork_line(argv: &[String]) -> String {
    let words: Vec<String> = argv.iter().map(|w| shell_word(w)).collect();
    format!("{}; exec \"${{SHELL:-sh}}\"", words.join(" "))
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
    let branch = args.branch.unwrap_or_else(|| default_branch(&id));
    let created = match create::create(std::path::Path::new(&now.path), &branch, None) {
        Ok(created) => created,
        Err(error) => answer.exit(EXIT_FAILED, &error.to_string()),
    };
    let cwd = tmuxy_core::argv::format_literal(&created.path);
    let tab = crate::run_cli::new_tab(answer, Some(&branch), Some(&cwd), Some(&fork_line(&argv)));
    answer.done(
        &[
            ("path", cli_json::string(&created.path)),
            ("branch", cli_json::string(&created.branch)),
            ("tabId", cli_json::string(&tab)),
            ("session", cli_json::string(&id)),
        ],
        &format!(
            "{} on branch {}, in tab {tab}",
            created.path, created.branch
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
            format!("claude --resume {ID} --fork-session; exec \"${{SHELL:-sh}}\"")
        );
    }

    #[test]
    fn a_fork_is_on_its_own_branch_by_default() {
        assert_eq!(default_branch(ID), "fork-0b5c2f4e");
    }
}
