//! `tmuxy agent install|uninstall|status` — wire coding agents (Claude Code,
//! Codex, Antigravity) into tmuxy: their lifecycle hooks declare what the pane
//! is doing (`@tmuxy-pane-state`, drawn by the sidebar tree), and the tmuxy
//! skill teaches them the CLI.
//!
//! The installed hooks hold no logic. Each one runs `tmuxy agent hook <agent>
//! <event>`, and what an event means is decided here, by [`state`], when it
//! fires — so an upgrade changes the behaviour without a reinstall, and
//! uninstall finds tmuxy's entries by that command alone.

use std::io::{IsTerminal, Read};

use serde_json::Value;

mod config;
use config::*;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
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

    /// The events tmuxy hooks, and the matcher that narrows one where the
    /// agent would otherwise call the hook for nothing.
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
    Hook::on("Stop"),
    Hook::on("Interrupt"),
    // Codex allows SessionEnd three seconds at most.
    Hook {
        event: "SessionEnd",
        matcher: None,
        timeout: 3,
    },
];

const AGY_HOOKS: &[Hook] = &[
    Hook::on("SessionStart"),
    Hook::on("PreInvocation"),
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
    let field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or("");
    Some(match (agent, event) {
        (_, "SessionStart") => "idle",
        (_, "UserPromptSubmit" | "PostToolUse" | "PreInvocation") => "working",
        (_, "PermissionRequest") => "needs-input",
        (Agent::Claude, "Notification") => {
            let kind = field("notification_type");
            if !CLAUDE_NEEDS_INPUT.split('|').any(|k| k == kind) {
                return None;
            }
            "needs-input"
        }
        (Agent::Agy, "Stop") => {
            if !field("error").is_empty() || field("terminationReason") == "error" {
                "error"
            } else {
                "idle"
            }
        }
        (_, "Stop" | "Interrupt") => "idle",
        (_, "StopFailure") => "error",
        (_, "SessionEnd") => "clear",
        _ => return None,
    })
}

// --- The command line -------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct AgentArgs {
    #[command(subcommand)]
    verb: AgentVerb,
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
    /// The pane state an agent event means (backs `tmuxy agent hook`). Reads
    /// the event's JSON on stdin.
    #[command(hide = true)]
    State { agent: Agent, event: String },
}

pub fn run(args: AgentArgs) {
    if let AgentVerb::State { agent, event } = &args.verb {
        let mut input = String::new();
        if !std::io::stdin().is_terminal() {
            let _ = std::io::stdin().read_to_string(&mut input);
        }
        let payload = serde_json::from_str(&input).unwrap_or(Value::Null);
        if let Some(state) = state(*agent, event, &payload) {
            println!("{state}");
        }
        return;
    }
    let places = match Places::from_env() {
        Ok(places) => places,
        Err(e) => {
            eprintln!("tmuxy agent: {e}");
            std::process::exit(1);
        }
    };
    let result = match args.verb {
        AgentVerb::Install {
            which,
            force,
            hook_command,
        } => install(&places, &which, force, &hook_command),
        AgentVerb::Uninstall { which } => uninstall(&places, &which),
        AgentVerb::Status { agents, project } => {
            status(&places, &agents, scope(project));
            Ok(())
        }
        AgentVerb::State { .. } => Ok(()),
    };
    if let Err(e) = result {
        eprintln!("tmuxy agent: {e}");
        std::process::exit(1);
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

fn install(places: &Places, which: &Which, force: bool, tmuxy: &str) -> Result<(), String> {
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
            println!("{name:<7} hooks  {}  {what}", places.show(&path));
            if agent == Agent::Codex && !which.dry_run {
                println!("        Codex runs new hooks once you approve them: /hooks in Codex.");
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
            println!("{name:<7} skill  {}  {what}", places.show(&dir));
        }
    }
    Ok(())
}

fn uninstall(places: &Places, which: &Which) -> Result<(), String> {
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
                println!("{name:<7} hooks  {}  {what}", places.show(&path));
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
                println!("{name:<7} skill  {}  {what}", places.show(&dir));
            }
        }
    }
    Ok(())
}

fn status(places: &Places, agents: &[Agent], scope: Scope) {
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
        println!("{name}  ({found})");
        let path = places.hooks_file(agent, scope);
        let hooks = match read_doc(&path) {
            Err(e) => format!("unreadable: {e}"),
            Ok(doc) => match hooked_events(&doc, agent) {
                0 => "not installed".into(),
                n if n == agent.hooks().len() => "installed".into(),
                n => format!("partly installed ({n} of {} events)", agent.hooks().len()),
            },
        };
        println!("  hooks  {}  {hooks}", places.show(&path));
        let dir = places.skill_dir(agent, scope);
        let skill = match skill_state(&dir) {
            SkillState::Missing => "not installed".into(),
            SkillState::Ours(v) if v == VERSION => format!("installed ({v})"),
            SkillState::Ours(v) => format!("out of date ({v}; this is {VERSION})"),
            SkillState::Foreign => "someone else's (not written by tmuxy)".into(),
        };
        println!("  skill  {}  {skill}", places.show(&dir));
    }
}
