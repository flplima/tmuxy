//! `tmuxy agent spawn`: an agent in a new pane of the caller's own tab,
//! with its task, tagged so `agent wait` and the tree can name it.
//!
//! The pane goes in the caller's tab only: a new first-level row of a
//! collapsible stack (`--place stack`, what `stack new` does), or a plain
//! split. Focus stays with the caller unless `--focus`.
//!
//! The agent's command line comes from a small table per agent: how it takes
//! a task, and how it takes a permission mode. The permission mode is passed
//! only when the caller names one, as written: spawn never adds one, so an
//! agent starts in whatever mode its own settings give it.
//!
//! The command runs through a private wrapper script, as `pane run`'s does,
//! so the task text never passes through tmux's parser.

use std::path::{Path, PathBuf};

use tmuxy_core::argv::shell_word;
use tmuxy_core::constants::tmux_options;
use tmuxy_core::paths::Layout;
use tmuxy_core::run_shell;

use crate::run_cli::fail_to_run;

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_USAGE};

/// The agents spawn knows how to hand a task to, and `cmd` for any other.
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnAgent {
    Claude,
    Codex,
    Gemini,
    Cmd,
}

#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    /// A new first-level row of the caller's tab, made a collapsible stack.
    Stack,
    /// A split below the caller's pane.
    Split,
}

#[derive(clap::Args, Debug)]
pub struct SpawnArgs {
    /// The agent to start; `cmd` runs the command after `--` as it is.
    #[arg(long, value_enum, default_value = "claude")]
    agent: SpawnAgent,
    /// Name the pane, for `agent wait`, `-t` and the tree. Must be unused.
    #[arg(long)]
    label: Option<String>,
    /// Start in this directory; default: the caller's.
    #[arg(long)]
    cwd: Option<PathBuf>,
    /// The agent's task.
    #[arg(long, conflicts_with = "prompt_file")]
    prompt: Option<String>,
    /// The agent's task, from a file.
    #[arg(long)]
    prompt_file: Option<PathBuf>,
    /// The agent's permission mode, passed to it as written (Claude Code's
    /// `--permission-mode`, Codex's `--ask-for-approval`, Gemini CLI's
    /// `--approval-mode`). Left out, the agent's own settings decide.
    #[arg(long)]
    permission_mode: Option<String>,
    /// Where the pane goes, always in the caller's tab.
    #[arg(long, value_enum, default_value = "stack")]
    place: Place,
    /// Move the focus to the new pane.
    #[arg(long)]
    focus: bool,
    /// With `--agent cmd`: the command and its arguments.
    #[arg(last = true)]
    command: Vec<String>,
}

/// How an agent's CLI takes a task and a permission mode.
struct Adapter {
    program: &'static str,
    /// The flag before the task; `None`: the task is the last argument,
    /// after `--`, so one that starts with `-` is not read as an option.
    prompt_flag: Option<&'static str>,
    permission_flag: &'static str,
}

fn adapter(agent: SpawnAgent) -> Option<Adapter> {
    match agent {
        SpawnAgent::Claude => Some(Adapter {
            program: "claude",
            prompt_flag: None,
            permission_flag: "--permission-mode",
        }),
        SpawnAgent::Codex => Some(Adapter {
            program: "codex",
            prompt_flag: None,
            permission_flag: "--ask-for-approval",
        }),
        SpawnAgent::Gemini => Some(Adapter {
            program: "gemini",
            prompt_flag: Some("--prompt-interactive"),
            permission_flag: "--approval-mode",
        }),
        SpawnAgent::Cmd => None,
    }
}

/// The most task text spawn hands an agent.
const MAX_PROMPT_BYTES: usize = 256 * 1024;

/// The agent's argv, or why the arguments do not make one.
pub fn agent_argv(
    agent: SpawnAgent,
    prompt: Option<&str>,
    permission_mode: Option<&str>,
    command: &[String],
) -> Result<Vec<String>, String> {
    let Some(adapter) = adapter(agent) else {
        if command.is_empty() {
            return Err("--agent cmd needs the command after --".into());
        }
        if prompt.is_some() || permission_mode.is_some() {
            return Err(
                "--prompt and --permission-mode are for a known agent; with --agent cmd, \
                 put them in the command"
                    .into(),
            );
        }
        return Ok(command.to_vec());
    };
    if !command.is_empty() {
        return Err("a command after -- is for --agent cmd".into());
    }
    let mut argv = vec![adapter.program.to_string()];
    if let Some(mode) = permission_mode {
        if mode.is_empty()
            || !mode
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(format!("--permission-mode {mode:?} is not one word"));
        }
        argv.extend([adapter.permission_flag.to_string(), mode.to_string()]);
    }
    if let Some(prompt) = prompt.filter(|p| !p.is_empty()) {
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(format!("the task is over {} KiB", MAX_PROMPT_BYTES / 1024));
        }
        match adapter.prompt_flag {
            Some(flag) => argv.extend([flag.to_string(), prompt.to_string()]),
            None => argv.extend(["--".to_string(), prompt.to_string()]),
        }
    }
    Ok(argv)
}

/// The wrapper script: it removes its own directory, then becomes the agent.
pub fn wrapper(dir: &Path, argv: &[String]) -> String {
    let words: Vec<String> = argv.iter().map(|w| shell_word(w)).collect();
    format!(
        "rm -rf -- {}\nexec {}\n",
        shell_word(&dir.to_string_lossy()),
        words.join(" ")
    )
}

/// The tmux command list that places the pane and prints its id.
pub fn place_argv(
    place: Place,
    caller: &str,
    cwd: Option<&Path>,
    focus: bool,
    script: &Path,
) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    let mut split = vec!["split-window", "-v"];
    if place == Place::Stack {
        argv.extend(
            [
                "set-option",
                "-w",
                "-t",
                caller,
                tmux_options::COLLAPSIBLE,
                "1",
                ";",
            ]
            .map(String::from),
        );
        // -f: a full-width first-level row, not a split of one pane.
        split.push("-f");
    }
    if !focus {
        split.push("-d");
    }
    argv.extend(split.into_iter().map(String::from));
    let cwd = cwd.map_or_else(
        || "#{pane_current_path}".to_string(),
        |dir| dir.to_string_lossy().into_owned(),
    );
    argv.extend(["-t", caller, "-c", &cwd, "-P", "-F", "#{pane_id}"].map(String::from));
    argv.push(format!("sh {}", shell_word(&script.to_string_lossy())));
    argv
}

/// The tags that name the new pane: label and title, who spawned it, and
/// which agent it is.
pub fn tag_argv(pane: &str, caller: &str, agent: &str, label: Option<&str>) -> Vec<String> {
    let mut argv: Vec<String> = [
        "set-option",
        "-p",
        "-t",
        pane,
        tmux_options::SPAWNED_BY,
        caller,
        ";",
        "set-option",
        "-p",
        "-t",
        pane,
        tmux_options::AGENT,
        agent,
    ]
    .map(String::from)
    .to_vec();
    if let Some(label) = label {
        argv.extend(
            [
                ";",
                "set-option",
                "-p",
                "-t",
                pane,
                tmux_options::PANE_LABEL,
                label,
                ";",
                "select-pane",
                "-t",
                pane,
                "-T",
                label,
            ]
            .map(String::from),
        );
    }
    argv
}

fn agent_name(agent: SpawnAgent, argv: &[String]) -> String {
    match agent {
        SpawnAgent::Cmd => argv
            .first()
            .map(|p| p.rsplit('/').next().unwrap_or(p).to_string())
            .unwrap_or_default(),
        known => adapter(known)
            .map(|a| a.program.to_string())
            .unwrap_or_default(),
    }
}

/// A private directory for the wrapper, readable by the user only: the
/// task may be anything the caller wrote.
fn wrapper_dir() -> std::io::Result<PathBuf> {
    let base = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let dir = base.join(format!("tmuxy-spawn.{}.{stamp}", std::process::id()));
    std::fs::create_dir(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Whether a pane already carries `label`.
fn label_taken(label: &str) -> bool {
    let format = format!("#{{{}}}", tmux_options::PANE_LABEL);
    let read = ["list-panes", "-a", "-F", &format].map(String::from);
    tmuxy_core::session::tmux_output(&read)
        .map(|out| out.lines().any(|l| l == label))
        .unwrap_or(false)
}

pub fn run(answer: &Answer, args: SpawnArgs) {
    let Some(caller) = run_shell::caller_pane() else {
        answer.exit(
            EXIT_USAGE,
            "run this inside a pane: the agent goes in that pane's tab",
        )
    };
    let prompt = match &args.prompt_file {
        Some(file) => match std::fs::read(file) {
            Ok(bytes) if bytes.len() <= MAX_PROMPT_BYTES => {
                Some(String::from_utf8_lossy(&bytes).into_owned())
            }
            Ok(_) => answer.exit(
                EXIT_USAGE,
                &format!("the task is over {} KiB", MAX_PROMPT_BYTES / 1024),
            ),
            Err(e) => answer.exit(EXIT_USAGE, &format!("{}: {e}", file.display())),
        },
        None => args.prompt.clone(),
    };
    let argv = agent_argv(
        args.agent,
        prompt.as_deref(),
        args.permission_mode.as_deref(),
        &args.command,
    )
    .unwrap_or_else(|e| answer.exit(EXIT_USAGE, &e));
    if let Some(label) = &args.label {
        if label.is_empty() || label.starts_with('%') {
            answer.exit(EXIT_USAGE, "a label is a name, not a pane id");
        }
        if label_taken(label) {
            answer.exit(EXIT_FAILED, &format!("a pane is already labelled {label}"));
        }
    }
    let dir = wrapper_dir().unwrap_or_else(|e| answer.exit(EXIT_FAILED, &e.to_string()));
    let script = dir.join("spawn.sh");
    if let Err(e) = std::fs::write(&script, wrapper(&dir, &argv)) {
        let _ = std::fs::remove_dir_all(&dir);
        answer.exit(EXIT_FAILED, &e.to_string());
    }
    let layout = Layout::current();
    let placed = run_shell::tmux(
        &layout,
        &place_argv(
            args.place,
            &caller,
            args.cwd.as_deref(),
            args.focus,
            &script,
        ),
    );
    let out = placed.unwrap_or_else(|e| {
        let _ = std::fs::remove_dir_all(&dir);
        fail_to_run(answer, e)
    });
    let pane = out
        .split_whitespace()
        .rfind(|w| w.starts_with('%'))
        .unwrap_or_default()
        .to_string();
    if pane.is_empty() {
        answer.exit(EXIT_FAILED, "tmux made no pane");
    }
    let agent = agent_name(args.agent, &argv);
    if let Err(e) = run_shell::tmux(
        &layout,
        &tag_argv(&pane, &caller, &agent, args.label.as_deref()),
    ) {
        fail_to_run(answer, e);
    }
    let label = args.label.as_deref().unwrap_or_default();
    answer.done(
        &[
            ("paneId", cli_json::string(&pane)),
            ("label", cli_json::string(label)),
            ("agent", cli_json::string(&agent)),
        ],
        &pane,
    );
}

#[cfg(test)]
#[path = "spawn_tests.rs"]
mod tests;
