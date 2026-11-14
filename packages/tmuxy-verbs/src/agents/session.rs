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
///
/// A session that ends normally (`SessionEnd`) is taken off: revive is for
/// an agent that was killed or crashed, and a pane reused for something else
/// must not resume an old conversation.
pub fn record(pane: &str, agent: Agent, event: &str, payload: &Value) {
    let set = if event == "SessionEnd" && Resumable::of(agent).is_some() {
        ["set-option", "-pu", "-t", pane, AGENT_SESSION]
            .map(String::from)
            .to_vec()
    } else if let Some(token) = token(agent, event, payload) {
        ["set-option", "-p", "-t", pane, AGENT_SESSION, &token]
            .map(String::from)
            .to_vec()
    } else {
        return;
    };
    let _ = run_shell::tmux(&Layout::current(), &set);
}

/// The shells a pane sits in once its agent has exited.
const SHELLS: [&str; 7] = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh"];

/// What revive needs to know about a pane.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PaneNow {
    pub dead: bool,
    pub command: String,
    /// The pane's first process.
    pub pid: Option<u32>,
    pub path: String,
    pub session: String,
}

fn pane_format() -> String {
    format!(
        "#{{pane_id}}\t#{{pane_dead}}\t#{{pane_current_command}}\t#{{{AGENT_SESSION}}}\t#{{pane_pid}}\t#{{pane_current_path}}"
    )
}

/// `pane` as a read of [`pane_format`] gives it; `None` for an answer
/// about another pane (`display-message -t` falls back to one when its
/// target is gone).
pub fn parse_pane(pane: &str, read: &str) -> Option<PaneNow> {
    let read = read.strip_suffix('\n').unwrap_or(read);
    let f: Vec<&str> = read.splitn(6, '\t').collect();
    let [id, dead, command, session, pid, path] = f[..] else {
        return None;
    };
    (id == pane).then(|| PaneNow {
        dead: dead == "1",
        command: command.into(),
        pid: pid.parse().ok(),
        path: path.into(),
        session: session.into(),
    })
}

/// Why `now` cannot be revived, if it cannot. `children` are the commands
/// of the pane's first process's children, `None` when they could not be
/// listed. Revive respawns the pane, killing its process and everything
/// under it, so a live pane is revived only when that is a shell with no
/// child at all: no job running, stopped or in the background.
pub fn refusal(pane: &str, now: &PaneNow, children: Option<&[String]>) -> Option<String> {
    if parse(&now.session).is_none() {
        return Some(format!("{pane} has no agent session to resume"));
    }
    if now.dead {
        return None;
    }
    if !SHELLS.contains(&now.command.trim_start_matches('-')) {
        return Some(format!(
            "{pane} is still running {}: revive is for a pane whose agent has exited",
            now.command
        ));
    }
    match children {
        None => Some(format!(
            "cannot tell whether {pane}'s shell has jobs, so it is left alone"
        )),
        Some([]) => None,
        Some(jobs) => Some(format!(
            "{pane}'s shell still has jobs ({}): revive would kill them",
            jobs.join(", ")
        )),
    }
}

/// The command names of `pid`'s child processes; `None` when they cannot
/// be listed.
#[cfg(target_os = "linux")]
pub fn children(pid: u32) -> Option<Vec<String>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // A process that ended between the listing and the read is gone.
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if let Some((comm, ppid)) = parent_of(&stat) {
            if ppid == pid {
                found.push(comm);
            }
        }
    }
    Some(found)
}

/// A `/proc/<pid>/stat` line's command name and parent: the name is in
/// parentheses and may hold spaces or `)`, so the fields after the last `)`
/// are read from there.
pub fn parent_of(stat: &str) -> Option<(String, u32)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat.get(open + 1..close)?.to_string();
    let ppid = stat
        .get(close + 1..)?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some((comm, ppid))
}

#[cfg(not(target_os = "linux"))]
pub fn children(pid: u32) -> Option<Vec<String>> {
    let output = std::process::Command::new("ps")
        .args(["-A", "-o", "ppid=,comm="])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let (ppid, comm) = line.trim().split_once(char::is_whitespace)?;
                (ppid.parse::<u32>().ok()? == pid).then(|| comm.trim().to_string())
            })
            .collect(),
    )
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

/// The tmux command that respawns `pane` in `path` with the wrapper
/// `script`. tmux expands formats in a start directory and reads an argument
/// ending in `;` as the end of its command, so the path goes as text.
pub fn respawn_argv(pane: &str, path: &str, script: &std::path::Path) -> Vec<String> {
    [
        "respawn-pane",
        "-k",
        "-t",
        pane,
        "-c",
        &super::spawn::tmux_word(&format_literal(path)),
        &format!("sh {}", shell_word(&script.to_string_lossy())),
    ]
    .map(String::from)
    .to_vec()
}

#[derive(clap::Args, Debug)]
pub struct ReviveArgs {
    /// The pane, by id or label.
    pane: String,
}

/// `pane` as tmux has it now; `None` when no such pane answers.
pub fn read_pane(pane: &str) -> Option<PaneNow> {
    let read = ["display-message", "-p", "-t", pane, &pane_format()].map(String::from);
    tmuxy_core::session::tmux_output(&read)
        .ok()
        .and_then(|out| parse_pane(pane, &out))
}

/// The children of a pane's first process, when this machine can see them:
/// with tmux on another host (`TMUXY_SSH`), the pid is that host's, so they
/// cannot be listed here and a live pane is left alone.
fn pane_children(pid: Option<u32>) -> Option<Vec<String>> {
    if tmuxy_core::session::ssh_target().is_some() {
        return None;
    }
    pid.and_then(children)
}

pub fn revive(answer: &Answer, args: ReviveArgs) {
    let pane =
        super::wait::resolve_one(&args.pane).unwrap_or_else(|(code, e)| answer.exit(code, &e));
    let Some(now) = read_pane(&pane) else {
        answer.exit(EXIT_TARGET, &format!("no pane {pane}"))
    };
    let jobs = pane_children(now.pid);
    if let Some(why) = refusal(&pane, &now, jobs.as_deref()) {
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
    let script = dir.join("revive.sh");
    if let Err(e) = std::fs::write(&script, revive_script(&dir, &argv)) {
        let _ = std::fs::remove_dir_all(&dir);
        answer.exit(EXIT_FAILED, &e.to_string());
    }
    if let Err(e) = run_shell::tmux(&Layout::current(), &respawn_argv(&pane, &now.path, &script)) {
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
