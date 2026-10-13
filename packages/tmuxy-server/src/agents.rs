//! `tmuxy agent install|uninstall|status` — wire coding agents (Claude Code,
//! Codex, Antigravity) into tmuxy: their lifecycle hooks declare what the pane
//! is doing (`@tmuxy-pane-state`, drawn by the sidebar tree), and the tmuxy
//! skill teaches them the CLI.
//!
//! The installed hooks hold no logic. Each one runs `tmuxy agent hook <agent>
//! <event>`, and what an event means is decided here, by [`state`], when it
//! fires — so an upgrade changes the behaviour without a reinstall, and
//! uninstall finds tmuxy's entries by that command alone.

use std::ffi::OsString;
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// The skill every agent gets: the same text `tmuxy skill` prints (a CLI test
/// keeps the two equal).
const SKILL: &str = include_str!("../../../.agents/skills/tmuxy/SKILL.md");
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Written beside an installed SKILL.md: what makes the directory tmuxy's to
/// update or remove, and the version `status` compares against.
const SKILL_MARKER: &str = ".tmuxy-version";
/// Every installed hook command contains this, followed by agent and event.
const HOOK_VERB: &str = " agent hook ";

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

// --- Where each agent keeps things -----------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Home,
    Project,
}

/// The directories the agents' files are found from; [`Places::from_env`]
/// in the CLI, a scratch tree in the tests.
struct Places {
    home: PathBuf,
    cwd: PathBuf,
    claude_dir: PathBuf,
    codex_home: PathBuf,
    path: Option<OsString>,
}

impl Places {
    fn from_env() -> Result<Places, String> {
        let home = dirs::home_dir().ok_or("no home directory")?;
        let cwd = std::env::current_dir().map_err(|e| format!("current directory: {e}"))?;
        let env_dir = |key: &str, default: PathBuf| {
            std::env::var_os(key)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or(default)
        };
        Ok(Places {
            claude_dir: env_dir("CLAUDE_CONFIG_DIR", home.join(".claude")),
            codex_home: env_dir("CODEX_HOME", home.join(".codex")),
            path: std::env::var_os("PATH"),
            home,
            cwd,
        })
    }

    fn hooks_file(&self, agent: Agent, scope: Scope) -> PathBuf {
        match (agent, scope) {
            (Agent::Claude, Scope::Home) => self.claude_dir.join("settings.json"),
            // A hook names a path on this machine, so it is personal: the
            // project's local settings, not the shared ones.
            (Agent::Claude, Scope::Project) => self.cwd.join(".claude/settings.local.json"),
            (Agent::Codex, Scope::Home) => self.codex_home.join("hooks.json"),
            (Agent::Codex, Scope::Project) => self.cwd.join(".codex/hooks.json"),
            (Agent::Agy, Scope::Home) => self.home.join(".gemini/config/hooks.json"),
            (Agent::Agy, Scope::Project) => self.cwd.join(".agents/hooks.json"),
        }
    }

    fn skill_dir(&self, agent: Agent, scope: Scope) -> PathBuf {
        let root = match (agent, scope) {
            (Agent::Claude, Scope::Home) => self.claude_dir.join("skills"),
            (Agent::Claude, Scope::Project) => self.cwd.join(".claude/skills"),
            (Agent::Codex, Scope::Home) => self.home.join(".agents/skills"),
            (Agent::Agy, Scope::Home) => self.home.join(".gemini/config/skills"),
            (Agent::Codex | Agent::Agy, Scope::Project) => self.cwd.join(".agents/skills"),
        };
        root.join("tmuxy")
    }

    /// Installed on this machine: its binary is on PATH, or it has left its
    /// configuration directory behind.
    fn detected(&self, agent: Agent) -> bool {
        let (binary, dir) = match agent {
            Agent::Claude => ("claude", self.claude_dir.clone()),
            Agent::Codex => ("codex", self.codex_home.clone()),
            Agent::Agy => ("agy", self.home.join(".gemini/antigravity-cli")),
        };
        dir.is_dir()
            || self
                .path
                .as_ref()
                .is_some_and(|path| std::env::split_paths(path).any(|d| d.join(binary).is_file()))
    }

    /// `~/…` for a path under the home directory, for messages.
    fn show(&self, path: &Path) -> String {
        match path.strip_prefix(&self.home) {
            Ok(rest) => format!("~/{}", rest.display()),
            Err(_) => path.display().to_string(),
        }
    }
}

// --- Hook entries in an agent's config --------------------------------------

fn is_ours(handler: &Value) -> bool {
    handler
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(HOOK_VERB) && c.contains("tmuxy"))
}

/// The hook's command. Guarded, because an agent's settings often live in a
/// dotfiles repo shared with machines that have no tmuxy (or an older one
/// without `agent hook`): there it does nothing and still succeeds, rather
/// than report a failed hook on every event.
fn hook_command(agent: Agent, event: &str, tmuxy: &str) -> String {
    format!(
        "command -v {tmuxy} >/dev/null 2>&1 && {tmuxy}{HOOK_VERB}{} {event} 2>/dev/null || true",
        agent.name()
    )
}

fn handler(agent: Agent, hook: &Hook, tmuxy: &str) -> Value {
    json!({
        "type": "command",
        "command": hook_command(agent, hook.event, tmuxy),
        "timeout": hook.timeout,
    })
}

/// Take every tmuxy hook out of `doc`, leaving the rest as it was. Returns
/// whether anything was removed.
fn remove_hooks(doc: &mut Map<String, Value>, agent: Agent) -> bool {
    if agent.named_hooks() {
        return doc.remove("tmuxy").is_some();
    }
    let Some(Value::Object(events)) = doc.get_mut("hooks") else {
        return false;
    };
    let mut removed = false;
    for groups in events.values_mut() {
        let Value::Array(groups) = groups else {
            continue;
        };
        groups.retain_mut(|group| {
            let Some(Value::Array(handlers)) = group.get_mut("hooks") else {
                return true;
            };
            let before = handlers.len();
            handlers.retain(|h| !is_ours(h));
            let emptied = handlers.is_empty() && before > 0;
            removed |= handlers.len() != before;
            !emptied
        });
    }
    events.retain(|_, groups| !matches!(groups, Value::Array(g) if g.is_empty()));
    if events.is_empty() {
        doc.remove("hooks");
    }
    removed
}

fn add_hooks(doc: &mut Map<String, Value>, agent: Agent, tmuxy: &str) -> Result<(), String> {
    if agent.named_hooks() {
        let mut set = Map::new();
        for hook in agent.hooks() {
            set.insert(hook.event.into(), json!([handler(agent, hook, tmuxy)]));
        }
        doc.insert("tmuxy".into(), Value::Object(set));
        return Ok(());
    }
    let events = doc
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("`hooks` is not an object")?;
    for hook in agent.hooks() {
        let mut group = Map::new();
        if let Some(matcher) = hook.matcher {
            group.insert("matcher".into(), json!(matcher));
        }
        group.insert("hooks".into(), json!([handler(agent, hook, tmuxy)]));
        events
            .entry(hook.event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("`hooks.{}` is not a list", hook.event))?
            .push(Value::Object(group));
    }
    Ok(())
}

/// How many of the agent's events carry a tmuxy hook.
fn hooked_events(doc: &Map<String, Value>, agent: Agent) -> usize {
    let has_ours = |handlers: Option<&Value>| {
        handlers
            .and_then(Value::as_array)
            .is_some_and(|hs| hs.iter().any(is_ours))
    };
    agent
        .hooks()
        .iter()
        .filter(|hook| {
            if agent.named_hooks() {
                has_ours(doc.get("tmuxy").and_then(|set| set.get(hook.event)))
            } else {
                doc.get("hooks")
                    .and_then(|e| e.get(hook.event))
                    .and_then(Value::as_array)
                    .is_some_and(|groups| groups.iter().any(|g| has_ours(g.get("hooks"))))
            }
        })
        .count()
}

fn read_doc(path: &Path) -> Result<Map<String, Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str(&text) {
        Ok(Value::Object(doc)) => Ok(doc),
        Ok(_) => Err(format!("{}: not a JSON object", path.display())),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Write `doc` if it differs from what is on disk, keeping the previous file
/// as `<name>.tmuxy-bak`. Returns whether it wrote.
fn write_doc(path: &Path, doc: &Map<String, Value>) -> Result<bool, String> {
    // A settings file kept in a dotfiles repo is a symlink into it: write
    // through to the file it points at, or the rename below would replace
    // the link with a copy and cut the file off from the repo.
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let path = resolved.as_path();
    let text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())? + "\n";
    let old = std::fs::read_to_string(path).ok();
    if old.as_deref() == Some(text.as_str()) {
        return Ok(false);
    }
    let fail = |e: std::io::Error| format!("{}: {e}", path.display());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    if old.is_some() {
        std::fs::copy(path, backup_path(path)).map_err(fail)?;
    }
    let tmp = path.with_extension("tmuxy-tmp");
    std::fs::write(&tmp, text).map_err(fail)?;
    std::fs::rename(&tmp, path).map_err(fail)?;
    Ok(true)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmuxy-bak");
    path.with_file_name(name)
}

// --- The skill --------------------------------------------------------------

enum SkillState {
    Missing,
    Ours(String),
    /// A `tmuxy` skill tmuxy did not write: the user's own, left alone.
    Foreign,
}

fn skill_state(dir: &Path) -> SkillState {
    if !dir.exists() {
        return SkillState::Missing;
    }
    match std::fs::read_to_string(dir.join(SKILL_MARKER)) {
        Ok(version) => SkillState::Ours(version.trim().to_string()),
        Err(_) => SkillState::Foreign,
    }
}

fn write_skill(dir: &Path, force: bool) -> Result<&'static str, String> {
    let fail = |e: std::io::Error| format!("{}: {e}", dir.display());
    match skill_state(dir) {
        SkillState::Ours(version)
            if version == VERSION
                && std::fs::read_to_string(dir.join("SKILL.md"))
                    .ok()
                    .as_deref()
                    == Some(SKILL) =>
        {
            return Ok("up to date");
        }
        SkillState::Foreign if !force => {
            return Ok("left alone: not written by tmuxy (--force moves it aside)");
        }
        SkillState::Foreign => {
            let aside = backup_path(dir);
            if aside.exists() {
                std::fs::remove_dir_all(&aside).map_err(fail)?;
            }
            std::fs::rename(dir, &aside).map_err(fail)?;
        }
        _ => {}
    }
    std::fs::create_dir_all(dir).map_err(fail)?;
    std::fs::write(dir.join("SKILL.md"), SKILL).map_err(fail)?;
    std::fs::write(dir.join(SKILL_MARKER), format!("{VERSION}\n")).map_err(fail)?;
    Ok("installed")
}

/// Remove tmuxy's own files, and the directory once nothing else is in it.
fn remove_skill(dir: &Path) -> Result<bool, String> {
    if !matches!(skill_state(dir), SkillState::Ours(_)) {
        return Ok(false);
    }
    let fail = |e: std::io::Error| format!("{}: {e}", dir.display());
    std::fs::remove_file(dir.join("SKILL.md")).map_err(fail)?;
    std::fs::remove_file(dir.join(SKILL_MARKER)).map_err(fail)?;
    let _ = std::fs::remove_dir(dir);
    Ok(true)
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> Places {
        let root = std::env::temp_dir().join(format!("tmuxy-agents-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Places {
            claude_dir: root.join("home/.claude"),
            codex_home: root.join("home/.codex"),
            home: root.join("home"),
            cwd: root.join("project"),
            path: None,
        }
    }

    fn which(agents: &[Agent]) -> Which {
        Which {
            agents: agents.to_vec(),
            hooks_only: false,
            skill_only: false,
            project: false,
            dry_run: false,
        }
    }

    #[test]
    fn each_event_means_a_state() {
        let none = Value::Null;
        assert_eq!(
            state(Agent::Claude, "UserPromptSubmit", &none),
            Some("working")
        );
        assert_eq!(
            state(Agent::Claude, "PermissionRequest", &none),
            Some("needs-input")
        );
        assert_eq!(state(Agent::Claude, "Stop", &none), Some("idle"));
        assert_eq!(state(Agent::Claude, "StopFailure", &none), Some("error"));
        assert_eq!(state(Agent::Claude, "SessionEnd", &none), Some("clear"));
        let asked = json!({ "notification_type": "permission_prompt" });
        assert_eq!(
            state(Agent::Claude, "Notification", &asked),
            Some("needs-input")
        );
        let idle = json!({ "notification_type": "idle_prompt" });
        assert_eq!(state(Agent::Claude, "Notification", &idle), None);
        assert_eq!(state(Agent::Codex, "Interrupt", &none), Some("idle"));
        assert_eq!(state(Agent::Agy, "PreInvocation", &none), Some("working"));
        let failed = json!({ "terminationReason": "error", "error": "", "fullyIdle": true });
        assert_eq!(state(Agent::Agy, "Stop", &failed), Some("error"));
        let done = json!({ "terminationReason": "model_stop", "fullyIdle": true });
        assert_eq!(state(Agent::Agy, "Stop", &done), Some("idle"));
        assert_eq!(state(Agent::Codex, "PreCompact", &none), None);
    }

    #[test]
    fn every_installed_event_means_something() {
        for agent in ALL {
            for hook in agent.hooks() {
                let payload = json!({ "notification_type": "permission_prompt" });
                assert!(
                    state(agent, hook.event, &payload).is_some(),
                    "{:?} {}",
                    agent,
                    hook.event
                );
            }
        }
    }

    #[test]
    fn install_keeps_the_users_settings_and_hooks_and_uninstall_restores_them() {
        let places = scratch("claude");
        let path = places.hooks_file(Agent::Claude, Scope::Home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = r#"{
  "theme": "dark",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "say done"
          }
        ]
      }
    ]
  },
  "model": "opus"
}
"#;
        std::fs::write(&path, original).unwrap();

        install(&places, &which(&[Agent::Claude]), false, "/bin/tmuxy").unwrap();
        let doc = read_doc(&path).unwrap();
        let keys: Vec<&str> = doc.keys().map(String::as_str).collect();
        assert_eq!(keys, ["theme", "hooks", "model"], "order kept");
        let stop = doc["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop[0]["hooks"][0]["command"], "say done");
        assert_eq!(
            stop[1]["hooks"][0]["command"],
            hook_command(Agent::Claude, "Stop", "/bin/tmuxy")
        );
        assert_eq!(
            doc["hooks"]["Notification"][0]["matcher"],
            CLAUDE_NEEDS_INPUT
        );
        assert_eq!(
            hooked_events(&doc, Agent::Claude),
            Agent::Claude.hooks().len()
        );
        assert_eq!(
            std::fs::read_to_string(backup_path(&path)).unwrap(),
            original
        );

        // Installing again replaces tmuxy's entries rather than adding more.
        install(
            &places,
            &which(&[Agent::Claude]),
            false,
            "/usr/local/bin/tmuxy",
        )
        .unwrap();
        let doc = read_doc(&path).unwrap();
        assert_eq!(doc["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            doc["hooks"]["Stop"][1]["hooks"][0]["command"],
            hook_command(Agent::Claude, "Stop", "/usr/local/bin/tmuxy")
        );

        uninstall(&places, &which(&[Agent::Claude])).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn antigravity_gets_a_named_hook_set_beside_the_users() {
        let places = scratch("agy");
        let path = places.hooks_file(Agent::Agy, Scope::Home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"browser-cleanup":{"Stop":[{"type":"command","command":"reap"}]}}"#,
        )
        .unwrap();

        install(&places, &which(&[Agent::Agy]), false, "tmuxy").unwrap();
        let doc = read_doc(&path).unwrap();
        assert_eq!(doc["browser-cleanup"]["Stop"][0]["command"], "reap");
        assert_eq!(
            doc["tmuxy"]["Stop"][0]["command"],
            hook_command(Agent::Agy, "Stop", "tmuxy")
        );
        assert_eq!(hooked_events(&doc, Agent::Agy), 3);

        uninstall(&places, &which(&[Agent::Agy])).unwrap();
        let doc = read_doc(&path).unwrap();
        assert!(doc.get("tmuxy").is_none());
        assert_eq!(doc["browser-cleanup"]["Stop"][0]["command"], "reap");
    }

    #[test]
    fn codex_hooks_go_in_hooks_json_and_session_end_fits_its_limit() {
        let places = scratch("codex");
        install(&places, &which(&[Agent::Codex]), false, "tmuxy").unwrap();
        let doc = read_doc(&places.codex_home.join("hooks.json")).unwrap();
        assert_eq!(doc["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 3);
        assert_eq!(
            doc["hooks"]["PermissionRequest"][0]["hooks"][0]["command"],
            hook_command(Agent::Codex, "PermissionRequest", "tmuxy")
        );
        assert_eq!(
            places.skill_dir(Agent::Codex, Scope::Home),
            places.home.join(".agents/skills/tmuxy")
        );
    }

    #[test]
    fn a_skill_tmuxy_did_not_write_is_left_alone_unless_forced() {
        let places = scratch("skill");
        let dir = places.skill_dir(Agent::Claude, Scope::Home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "mine").unwrap();
        let skill_only = Which {
            skill_only: true,
            ..which(&[Agent::Claude])
        };

        install(&places, &skill_only, false, "tmuxy").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "mine"
        );
        uninstall(&places, &skill_only).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "mine"
        );

        install(&places, &skill_only, true, "tmuxy").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            SKILL
        );
        assert_eq!(
            std::fs::read_to_string(backup_path(&dir).join("SKILL.md")).unwrap(),
            "mine"
        );
        assert!(matches!(skill_state(&dir), SkillState::Ours(v) if v == VERSION));

        uninstall(&places, &skill_only).unwrap();
        assert!(!dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_settings_file_that_is_a_symlink_stays_one() {
        let places = scratch("symlink");
        let path = places.hooks_file(Agent::Claude, Scope::Home);
        let real = places.home.join("dotfiles/claude-settings.json");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&real, "{\"theme\": \"dark\"}\n").unwrap();
        std::os::unix::fs::symlink(&real, &path).unwrap();

        install(&places, &which(&[Agent::Claude]), false, "tmuxy").unwrap();
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(hooked_events(&read_doc(&real).unwrap(), Agent::Claude), 8);
    }

    #[test]
    fn a_file_that_is_not_json_is_refused_untouched() {
        let places = scratch("broken");
        let path = places.hooks_file(Agent::Claude, Scope::Home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(install(&places, &which(&[Agent::Claude]), false, "tmuxy").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
