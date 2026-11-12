//! The agent session a pane runs, recorded from its hooks, and `tmuxy agent
//! revive`, which brings an exited agent back into the same conversation.
//!
//! What is kept is the agent's kind and its session id, nothing else:
//! `@tmuxy-agent-session` = `<agent>:<uuid>`. Never a command line: any
//! process of the same user can write a pane option, so one that revive ran
//! as written would be a way to get a command run from the pane menu.
//! Revive builds the command itself, from a fixed table of agents, and the
//! id must be a UUID, checked when it is recorded and again when it is read.
//!
//! The id comes from the hook event's own JSON (`session_id`); nothing here
//! reads an agent's files.

use serde_json::Value;
use tmuxy_core::argv::{format_literal, shell_word};
use tmuxy_core::paths::Layout;
use tmuxy_core::run_shell;

use super::Agent;
use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_TARGET};

/// The option the session is kept in.
pub const AGENT_SESSION: &str = tmuxy_core::constants::tmux_options::AGENT_SESSION;

/// The agents revive knows how to resume, and how.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resumable {
    Claude,
    Codex,
}

impl Resumable {
    fn name(self) -> &'static str {
        match self {
            Resumable::Claude => "claude",
            Resumable::Codex => "codex",
        }
    }

    fn of(agent: Agent) -> Option<Resumable> {
        match agent {
            Agent::Claude => Some(Resumable::Claude),
            Agent::Codex => Some(Resumable::Codex),
            _ => None,
        }
    }

    fn named(name: &str) -> Option<Resumable> {
        [Resumable::Claude, Resumable::Codex]
            .into_iter()
            .find(|r| r.name() == name)
    }
}

/// Whether `id` is a UUID: 8-4-4-4-12 hex digits, nothing else.
pub fn is_uuid(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, len)| g.len() == len && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The value to record for a hook event, if it names a session to resume:
/// on a session's start and on each prompt, for an agent revive knows.
pub fn token(agent: Agent, event: &str, payload: &Value) -> Option<String> {
    if !matches!(event, "SessionStart" | "UserPromptSubmit") {
        return None;
    }
    let kind = Resumable::of(agent)?;
    let id = payload.get("session_id")?.as_str()?;
    is_uuid(id).then(|| format!("{}:{id}", kind.name()))
}

/// A recorded value, read back: its agent and id, if it is still one.
pub fn parse(token: &str) -> Option<(Resumable, String)> {
    let (name, id) = token.trim().split_once(':')?;
    let kind = Resumable::named(name)?;
    is_uuid(id).then(|| (kind, id.to_string()))
}

/// The command that resumes `id`.
pub fn resume_argv(kind: Resumable, id: &str) -> Vec<String> {
    match kind {
        Resumable::Claude => vec!["claude".into(), "--resume".into(), id.into()],
        Resumable::Codex => vec!["codex".into(), "resume".into(), id.into()],
    }
}

/// Record the hook's session on `pane`, if it names one. A hook never
/// fails for this: an error is dropped.
pub fn record(pane: &str, agent: Agent, event: &str, payload: &Value) {
    let Some(token) = token(agent, event, payload) else {
        return;
    };
    let set = ["set-option", "-p", "-t", pane, AGENT_SESSION, &token].map(String::from);
    let _ = run_shell::tmux(&Layout::current(), &set);
}

/// The wrapper's file name, which the pane's start command names.
const REVIVE_SCRIPT: &str = "revive.sh";

/// The shells a pane sits in once its agent has exited.
const SHELLS: [&str; 7] = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh"];

/// What revive needs to know about a pane.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PaneNow {
    pub dead: bool,
    pub command: String,
    /// The command the pane was (re)spawned with.
    pub start: String,
    pub path: String,
    pub session: String,
}

fn pane_format() -> String {
    format!(
        "#{{pane_id}}\t#{{pane_dead}}\t#{{pane_current_command}}\t#{{{AGENT_SESSION}}}\t#{{pane_start_command}}\t#{{pane_current_path}}"
    )
}

/// `pane` as a read of [`pane_format`] gives it; `None` for an answer
/// about another pane (`display-message -t` falls back to one when its
/// target is gone).
pub fn parse_pane(pane: &str, read: &str) -> Option<PaneNow> {
    let read = read.strip_suffix('\n').unwrap_or(read);
    let f: Vec<&str> = read.splitn(6, '\t').collect();
    let [id, dead, command, session, start, path] = f[..] else {
        return None;
    };
    (id == pane).then(|| PaneNow {
        dead: dead == "1",
        command: command.into(),
        start: start.into(),
        path: path.into(),
        session: session.into(),
    })
}

/// Why `now` cannot be revived, if it cannot.
pub fn refusal(pane: &str, now: &PaneNow) -> Option<String> {
    if parse(&now.session).is_none() {
        return Some(format!("{pane} has no agent session to resume"));
    }
    // A revived agent runs under revive's wrapper, which tmux names `sh`
    // until it hands the pane to a shell once the agent exits.
    let wrapped = now.start.contains(REVIVE_SCRIPT) && now.command == "sh";
    if !now.dead && wrapped {
        return Some(format!("{pane} is still running its revived agent"));
    }
    let at_shell = SHELLS.contains(&now.command.trim_start_matches('-'));
    (!now.dead && !at_shell).then(|| {
        format!(
            "{pane} is still running {}: revive is for a pane whose agent has exited",
            now.command
        )
    })
}

/// The wrapper revive runs: it removes its directory, runs the agent, and
/// leaves a shell when the agent exits, as the pane had before.
pub fn revive_script(dir: &std::path::Path, argv: &[String]) -> String {
    let words: Vec<String> = argv.iter().map(|w| shell_word(w)).collect();
    format!(
        "rm -rf -- {}\n{}\nexec \"${{SHELL:-sh}}\"\n",
        shell_word(&dir.to_string_lossy()),
        words.join(" ")
    )
}

#[derive(clap::Args, Debug)]
pub struct ReviveArgs {
    /// The pane, by id or label: the shell resolves a label first.
    pane: String,
}

pub fn revive(answer: &Answer, args: ReviveArgs) {
    let pane = args.pane;
    let read = ["display-message", "-p", "-t", &pane, &pane_format()].map(String::from);
    let Some(now) = tmuxy_core::session::tmux_output(&read)
        .ok()
        .and_then(|out| parse_pane(&pane, &out))
    else {
        answer.exit(EXIT_TARGET, &format!("no pane {pane}"))
    };
    if let Some(why) = refusal(&pane, &now) {
        answer.exit(EXIT_FAILED, &why);
    }
    let Some((kind, id)) = parse(&now.session) else {
        answer.exit(
            EXIT_FAILED,
            &format!("{pane} has no agent session to resume"),
        )
    };
    let argv = resume_argv(kind, &id);
    let dir =
        super::spawn::wrapper_dir().unwrap_or_else(|e| answer.exit(EXIT_FAILED, &e.to_string()));
    let script = dir.join(REVIVE_SCRIPT);
    if let Err(e) = std::fs::write(&script, revive_script(&dir, &argv)) {
        let _ = std::fs::remove_dir_all(&dir);
        answer.exit(EXIT_FAILED, &e.to_string());
    }
    let respawn = [
        "respawn-pane",
        "-k",
        "-t",
        &pane,
        "-c",
        &format_literal(&now.path),
        &format!("sh {}", shell_word(&script.to_string_lossy())),
    ]
    .map(String::from);
    if let Err(e) = run_shell::tmux(&Layout::current(), &respawn) {
        let _ = std::fs::remove_dir_all(&dir);
        crate::run_cli::fail_to_run(answer, e);
    }
    answer.done(
        &[
            ("paneId", cli_json::string(&pane)),
            ("agent", cli_json::string(kind.name())),
            ("session", cli_json::string(&id)),
        ],
        &format!("{pane} {} {id}", kind.name()),
    );
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
