//! `tmuxy worktree new|remove`: a worktree for a task, in a tab of its own
//! with its agent (`tmuxy_core::worktrees::create`), and its removal without
//! losing work in it (`tmuxy_core::worktrees::guard`).

use std::path::PathBuf;

use tmuxy_core::worktrees::{create, guard};

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_USAGE};

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
    /// A new worktree of this repository on a new branch, beside the main
    /// one, and a tab in it named after the branch, running the agent with
    /// the task when one is given.
    New {
        /// The branch; default: the task in a few words.
        #[arg(long)]
        branch: Option<String>,
        /// What the branch starts from; default: the repository's HEAD.
        #[arg(long)]
        from: Option<String>,
        /// The agent's command line, started in the tab with the task as its
        /// last argument (`--agent claude`). A shell otherwise.
        #[arg(long)]
        agent: Option<String>,
        /// Make the worktree only, with no tab.
        #[arg(long)]
        no_tab: bool,
        /// The task, after `--`.
        #[arg(last = true)]
        task: Vec<String>,
    },
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
    match args.verb {
        WorktreeVerb::New {
            branch,
            from,
            agent,
            no_tab,
            task,
        } => new(
            &answer,
            branch,
            from.as_deref(),
            agent.as_deref(),
            no_tab,
            &task.join(" "),
        ),
        WorktreeVerb::Remove { path, force } => remove(&answer, path, force),
    }
}

/// The shell line a worktree's tab runs: the agent with the task, then a
/// shell, so the tab outlives the agent. The task comes after `--`, so one
/// that starts with a dash (`--resume`, a pasted "- fix the login") reaches
/// the agent as text, not as an option.
fn agent_line(agent: &str, task: &str) -> String {
    let task = if task.is_empty() {
        String::new()
    } else {
        format!(" -- {}", tmuxy_core::argv::shell_word(task))
    };
    format!("{agent}{task}; exec \"${{SHELL:-sh}}\"")
}

fn new(
    answer: &Answer,
    branch: Option<String>,
    from: Option<&str>,
    agent: Option<&str>,
    no_tab: bool,
    task: &str,
) {
    if agent.is_none() && !task.is_empty() {
        answer.exit(
            EXIT_USAGE,
            "a task needs an agent to give it to: --agent <command>",
        );
    }
    let Some(branch) = branch.or_else(|| Some(create::slug(task)).filter(|s| !s.is_empty())) else {
        answer.exit(
            EXIT_USAGE,
            "name the branch (--branch) or give a task after --",
        );
    };
    let here = match std::env::current_dir() {
        Ok(path) => path,
        Err(e) => answer.exit(EXIT_FAILED, &format!("current directory: {e}")),
    };
    let created = match create::create(&here, &branch, from) {
        Ok(created) => created,
        Err(error) => answer.exit(EXIT_FAILED, &error.to_string()),
    };
    let tab = if no_tab {
        String::new()
    } else {
        let program = agent.map(|agent| agent_line(agent, task));
        // The directory is a tmux format: a `#` in it is doubled, so a path
        // like `app-#(cmd)` names itself and runs nothing.
        let cwd = created.path.replace('#', "##");
        crate::run_cli::new_tab(answer, Some(&branch), Some(&cwd), program.as_deref())
    };
    let tab_field = if tab.is_empty() {
        "null".to_string()
    } else {
        cli_json::string(&tab)
    };
    let text = match tab.as_str() {
        "" => format!("{} on branch {}", created.path, created.branch),
        id => format!("{} on branch {}, in tab {id}", created.path, created.branch),
    };
    answer.done(
        &[
            ("path", cli_json::string(&created.path)),
            ("branch", cli_json::string(&created.branch)),
            ("repository", cli_json::string(&created.repository)),
            ("tabId", tab_field),
        ],
        &text,
    );
}

fn remove(answer: &Answer, path: Option<PathBuf>, force: bool) {
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

#[cfg(test)]
mod tests {
    use super::agent_line;

    #[test]
    fn the_agent_gets_the_task_as_one_quoted_word_and_a_shell_follows() {
        assert_eq!(
            agent_line("claude", "fix the login; rm -rf ~"),
            "claude -- 'fix the login; rm -rf ~'; exec \"${SHELL:-sh}\""
        );
        assert_eq!(
            agent_line("claude", "--resume"),
            "claude -- --resume; exec \"${SHELL:-sh}\"",
            "a task that looks like an option is still the task"
        );
        assert_eq!(agent_line("codex", ""), "codex; exec \"${SHELL:-sh}\"");
    }
}
