//! `tmuxy agent install|uninstall|status` — wire coding agents (Claude Code,
//! Codex, Antigravity) into tmuxy: their lifecycle hooks declare what the pane
//! is doing (`@tmuxy-pane-state`, drawn by the sidebar tree), and the tmuxy
//! skill teaches them the CLI.
//!
//! The installed hooks hold no logic. Each one runs `tmuxy agent hook <agent>
//! <event>`, and what an event means is decided here, by [`state`], when it
//! fires — so an upgrade changes the behaviour without a reinstall, and
//! uninstall finds tmuxy's entries by that command alone.

use std::fmt::Write as _;
use std::io::{IsTerminal, Read};

use crate::cli_json::{self, Answer, EXIT_FAILED};
use serde_json::Value;

mod config;
mod spawn;
mod wait;
pub(crate) use config::SKILL;
use config::*;

#[cfg(test)]
mod tests;

#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    /// Claude Code
    Claude,
    /// OpenAI Codex CLI
    Codex,
    /// Google Antigravity CLI
    Agy,
}

const ALL: [Agent; 3] = [Agent::Claude, Agent::Codex, Agent::Agy];

impl Agent {
    fn name(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Agy => "agy",
        }
    }

    fn hooks(self) -> &'static [Hook] {
        match self {
            Agent::Claude => CLAUDE_HOOKS,
            Agent::Codex => CODEX_HOOKS,
            Agent::Agy => AGY_HOOKS,
        }
    }

    /// Antigravity names each hook set, under one top-level key; Claude and
    /// Codex list matcher groups per event under `hooks`.
    fn named_hooks(self) -> bool {
        self == Agent::Agy
    }
}

/// Claude Code notifications that mean the user has to act. `idle_prompt`
/// is left out: by the time it fires, `Stop` has already said idle.
const CLAUDE_NEEDS_INPUT: &str =
    "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input";
const HOOK_TIMEOUT: u32 = 5;

const CLAUDE_HOOKS: &[Hook] = &[
    Hook::on("SessionStart"),
    Hook::on("UserPromptSubmit"),
    Hook::on("PostToolUse"),
    Hook::on("PermissionRequest"),
    Hook {
        event: "Notification",
        matcher: Some(CLAUDE_NEEDS_INPUT),
        timeout: HOOK_TIMEOUT,
    },
    Hook::on("Stop"),
    Hook::on("StopFailure"),
    Hook::on("SessionEnd"),
];

const CODEX_HOOKS: &[Hook] = &[
    Hook::on("SessionStart"),
    Hook::on("UserPromptSubmit"),
    Hook::on("PostToolUse"),
    Hook::on("PermissionRequest"),
    // A model request that failed (`error`) is the turn's error, until a
    // retry within the turn answers.
    Hook::on("PostModelRequest"),
    Hook::on("Stop"),
    Hook::on("Interrupt"),
    // Codex allows SessionEnd three seconds at most.
    Hook {
        event: "SessionEnd",
        matcher: None,
        timeout: 3,
    },
];

/// Antigravity has no hook for a permission prompt: `needs-input` comes from
/// its screen (`tmuxy_core::host::socket_watch::agent_screen`). A tool finishing is back to working, as a
/// prompt answered by the user is.
const AGY_HOOKS: &[Hook] = &[
    Hook::on("SessionStart"),
    Hook::on("PreInvocation"),
    Hook::on("PostToolUse"),
    Hook::on("Stop"),
];

struct Hook {
    event: &'static str,
    matcher: Option<&'static str>,
    timeout: u32,
}

impl Hook {
    const fn on(event: &'static str) -> Hook {
        Hook {
            event,
            matcher: None,
            timeout: HOOK_TIMEOUT,
        }
    }
}

/// What an agent's event says about its pane: a `@tmuxy-pane-state` value,
/// `clear` to unset it, or nothing to leave it as it is.
///
/// `idle` covers "finished": whether the user has seen the result is the
/// UI's to judge, since only it knows which pane is in front of them.
pub fn state(agent: Agent, event: &str, payload: &Value) -> Option<&'static str> {
    use tmuxy_core::PaneStateName::{Error, Idle, NeedsInput, Working};
    let field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or("");
    let state = match (agent, event) {
        (_, "SessionStart") => Idle,
        (_, "UserPromptSubmit" | "PostToolUse" | "PreInvocation") => Working,
        (_, "PermissionRequest") => NeedsInput,
        (Agent::Claude, "Notification") => {
            let kind = field("notification_type");
            if !CLAUDE_NEEDS_INPUT.split('|').any(|k| k == kind) {
                return None;
            }
            NeedsInput
        }
        (Agent::Codex, "PostModelRequest") => {
            let failed = payload
                .get("error")
                .is_some_and(|e| !e.is_null() && e.as_str() != Some(""));
            if failed {
                Error
            } else {
                Working
            }
        }
        (Agent::Agy, "Stop") => {
            if !field("error").is_empty() || field("terminationReason") == "error" {
                Error
            } else {
                Idle
            }
        }
        (_, "Stop" | "Interrupt") => Idle,
        (_, "StopFailure") => Error,
        (_, "SessionEnd") => return Some("clear"),
        _ => return None,
    };
    Some(state.as_str())
}

#[derive(clap::Args, Debug)]
pub struct SkillArgs {
    /// Answer in JSON: `{"ok":true,"output":…}`.
    #[arg(long)]
    json: bool,
}

pub fn skill(args: SkillArgs) {
    if args.json {
        Answer::new(true).done(&[("output", cli_json::string(SKILL.trim_end()))], "");
    } else {
        print!("{SKILL}");
    }
}

#[derive(clap::Args, Debug)]
pub struct AgentArgs {
    #[command(subcommand)]
    verb: AgentVerb,
    /// Answer in JSON: `{"ok":true,"output":…}`.
    #[arg(long, global = true)]
    json: bool,
}

#[derive(clap::Args, Debug)]
struct Which {
    /// The agents; default: every one installed on this machine.
    #[arg(value_enum)]
    agents: Vec<Agent>,
    /// Only the hooks.
    #[arg(long, conflicts_with = "skill_only")]
    hooks_only: bool,
    /// Only the skill.
    #[arg(long)]
    skill_only: bool,
    /// This project's agent config (./.claude, ./.codex, ./.agents) instead of
    /// the home directory's.
    #[arg(long)]
    project: bool,
    /// Say what would change; write nothing.
    #[arg(long)]
    dry_run: bool,
}

#[derive(clap::Subcommand, Debug)]
enum AgentVerb {
    /// Install the hooks that show each agent's state in tmuxy, and the skill.
    Install {
        #[command(flatten)]
        which: Which,
        /// Replace a `tmuxy` skill tmuxy did not write (it is moved aside).
        #[arg(long)]
        force: bool,
        /// The command the hooks run tmuxy with: `tmuxy` on PATH, so the
        /// same settings work on every machine they are synced to.
        #[arg(long, hide = true, default_value = "tmuxy")]
        hook_command: String,
    },
    /// Remove tmuxy's hooks and skill; everything else is left as it was.
    Uninstall {
        #[command(flatten)]
        which: Which,
    },
    /// What is installed, per agent.
    Status {
        #[arg(value_enum)]
        agents: Vec<Agent>,
        #[arg(long)]
        project: bool,
    },
    /// Wait for agents in panes to reach a state (`@tmuxy-pane-state`): idle,
    /// needs-input, error or done; by default any of them, in the first pane.
    Wait(wait::WaitArgs),
    /// Start an agent in a new pane of your own tab, with its task: a row of
    /// a collapsible stack by default, focus staying with you.
    Spawn(spawn::SpawnArgs),
    /// The pane state an agent event means (backs `tmuxy agent hook`). Reads
    /// the event's JSON on stdin.
    #[command(hide = true)]
    State { agent: Agent, event: String },
}

pub fn run(args: AgentArgs) {
    if let AgentVerb::State { agent, event } = &args.verb {
        // A hook event is a small JSON object; more than this is not one.
        const MAX_EVENT_BYTES: u64 = 1024 * 1024;
        let mut input = String::new();
        if !std::io::stdin().is_terminal() {
            let _ = std::io::stdin()
                .take(MAX_EVENT_BYTES)
                .read_to_string(&mut input);
        }
        let payload = serde_json::from_str(&input).unwrap_or(Value::Null);
        if let Some(state) = state(*agent, event, &payload) {
            println!("{state}");
        }
        return;
    }
    let answer = Answer::new(args.json);
    let verb = match args.verb {
        AgentVerb::Wait(wait) => return wait::run(&answer, wait),
        AgentVerb::Spawn(spawn) => return spawn::run(&answer, spawn),
        verb => verb,
    };
    let places = match Places::from_env() {
        Ok(places) => places,
        Err(e) => answer.exit(EXIT_FAILED, &e),
    };
    let mut out = String::new();
    let result = match verb {
        AgentVerb::Install {
            which,
            force,
            hook_command,
        } => install(&mut out, &places, &which, force, &hook_command),
        AgentVerb::Uninstall { which } => uninstall(&mut out, &places, &which),
        AgentVerb::Status { agents, project } => {
            status(&mut out, &places, &agents, scope(project));
            Ok(())
        }
        AgentVerb::State { .. } | AgentVerb::Wait(_) | AgentVerb::Spawn(_) => Ok(()),
    };
    // What was done before a failure is still said.
    if !answer.is_json() {
        print!("{out}");
    }
    match result {
        Ok(()) => answer.done(&[("output", cli_json::string(out.trim_end()))], ""),
        Err(e) => answer.exit(EXIT_FAILED, &e),
    }
}

fn scope(project: bool) -> Scope {
    if project {
        Scope::Project
    } else {
        Scope::Home
    }
}

fn chosen(places: &Places, agents: &[Agent]) -> Result<Vec<Agent>, String> {
    if !agents.is_empty() {
        return Ok(agents.to_vec());
    }
    let found: Vec<Agent> = ALL.into_iter().filter(|a| places.detected(*a)).collect();
    if found.is_empty() {
        return Err("no agent found on this machine; name one (claude, codex, agy)".into());
    }
    Ok(found)
}

fn install(
    out: &mut String,
    places: &Places,
    which: &Which,
    force: bool,
    tmuxy: &str,
) -> Result<(), String> {
    let scope = scope(which.project);
    for agent in chosen(places, &which.agents)? {
        let name = agent.name();
        if !which.skill_only {
            let path = places.hooks_file(agent, scope);
            let mut doc = read_doc(&path)?;
            remove_hooks(&mut doc, agent);
            add_hooks(&mut doc, agent, tmuxy)?;
            let what = if which.dry_run {
                "would be installed"
            } else if write_doc(&path, &doc)? {
                "installed"
            } else {
                "up to date"
            };
            let _ = writeln!(out, "{name:<7} hooks  {}  {what}", places.show(&path));
            if agent == Agent::Codex && !which.dry_run {
                let _ = writeln!(
                    out,
                    "        Codex runs new hooks once you approve them: /hooks in Codex."
                );
            }
        }
        if !which.hooks_only {
            let dir = places.skill_dir(agent, scope);
            let what = if which.dry_run {
                match skill_state(&dir) {
                    SkillState::Foreign if !force => "would be left alone: not written by tmuxy",
                    _ => "would be installed",
                }
            } else {
                write_skill(&dir, force)?
            };
            let _ = writeln!(out, "{name:<7} skill  {}  {what}", places.show(&dir));
        }
    }
    Ok(())
}

fn uninstall(out: &mut String, places: &Places, which: &Which) -> Result<(), String> {
    let scope = scope(which.project);
    let agents = if which.agents.is_empty() {
        ALL.to_vec()
    } else {
        which.agents.clone()
    };
    for agent in agents {
        let name = agent.name();
        if !which.skill_only {
            let path = places.hooks_file(agent, scope);
            let mut doc = read_doc(&path)?;
            if remove_hooks(&mut doc, agent) {
                if !which.dry_run {
                    write_doc(&path, &doc)?;
                }
                let what = if which.dry_run {
                    "would be removed"
                } else {
                    "removed"
                };
                let _ = writeln!(out, "{name:<7} hooks  {}  {what}", places.show(&path));
            }
        }
        if !which.hooks_only {
            let dir = places.skill_dir(agent, scope);
            let ours = matches!(skill_state(&dir), SkillState::Ours(_));
            if ours && (which.dry_run || remove_skill(&dir)?) {
                let what = if which.dry_run {
                    "would be removed"
                } else {
                    "removed"
                };
                let _ = writeln!(out, "{name:<7} skill  {}  {what}", places.show(&dir));
            }
        }
    }
    Ok(())
}

fn status(out: &mut String, places: &Places, agents: &[Agent], scope: Scope) {
    let agents = if agents.is_empty() {
        ALL.to_vec()
    } else {
        agents.to_vec()
    };
    for agent in agents {
        let name = agent.name();
        let found = if places.detected(agent) {
            "found"
        } else {
            "not found"
        };
        let _ = writeln!(out, "{name}  ({found})");
        let path = places.hooks_file(agent, scope);
        let hooks = match read_doc(&path) {
            Err(e) => format!("unreadable: {e}"),
            Ok(doc) => match hooked_events(&doc, agent) {
                0 => "not installed".into(),
                n if n == agent.hooks().len() => "installed".into(),
                n => format!("partly installed ({n} of {} events)", agent.hooks().len()),
            },
        };
        let _ = writeln!(out, "  hooks  {}  {hooks}", places.show(&path));
        let dir = places.skill_dir(agent, scope);
        let skill = match skill_state(&dir) {
            SkillState::Missing => "not installed".into(),
            SkillState::Ours(v) if v == VERSION => format!("installed ({v})"),
            SkillState::Ours(v) => format!("out of date ({v}; this is {VERSION})"),
            SkillState::Foreign => "someone else's (not written by tmuxy)".into(),
        };
        let _ = writeln!(out, "  skill  {}  {skill}", places.show(&dir));
    }
}
