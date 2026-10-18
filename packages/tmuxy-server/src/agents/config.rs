use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::{Agent, Hook};

/// The skill every agent gets: the same text `tmuxy skill` prints (a CLI test
/// keeps the two equal).
pub(super) const SKILL: &str = include_str!("../../../../.agents/skills/tmuxy/SKILL.md");
pub(super) const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Written beside an installed SKILL.md: what makes the directory tmuxy's to
/// update or remove, and the version `status` compares against.
const SKILL_MARKER: &str = ".tmuxy-version";
/// Every installed hook command contains this, followed by agent and event.
const HOOK_VERB: &str = " agent hook ";

// --- Where each agent keeps things -----------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Scope {
    Home,
    Project,
}

/// The directories the agents' files are found from; [`Places::from_env`]
/// in the CLI, a scratch tree in the tests.
pub(super) struct Places {
    pub(super) home: PathBuf,
    pub(super) cwd: PathBuf,
    pub(super) claude_dir: PathBuf,
    pub(super) codex_home: PathBuf,
    pub(super) path: Option<OsString>,
}

impl Places {
    pub(super) fn from_env() -> Result<Places, String> {
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

    pub(super) fn hooks_file(&self, agent: Agent, scope: Scope) -> PathBuf {
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

    pub(super) fn skill_dir(&self, agent: Agent, scope: Scope) -> PathBuf {
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
    pub(super) fn detected(&self, agent: Agent) -> bool {
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
    pub(super) fn show(&self, path: &Path) -> String {
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
pub(super) fn hook_command(agent: Agent, event: &str, tmuxy: &str) -> String {
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
pub(super) fn remove_hooks(doc: &mut Map<String, Value>, agent: Agent) -> bool {
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

pub(super) fn add_hooks(
    doc: &mut Map<String, Value>,
    agent: Agent,
    tmuxy: &str,
) -> Result<(), String> {
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
pub(super) fn hooked_events(doc: &Map<String, Value>, agent: Agent) -> usize {
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

pub(super) fn read_doc(path: &Path) -> Result<Map<String, Value>, String> {
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
pub(super) fn write_doc(path: &Path, doc: &Map<String, Value>) -> Result<bool, String> {
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

pub(super) fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmuxy-bak");
    path.with_file_name(name)
}

// --- The skill --------------------------------------------------------------

pub(super) enum SkillState {
    Missing,
    Ours(String),
    /// A `tmuxy` skill tmuxy did not write: the user's own, left alone.
    Foreign,
}

pub(super) fn skill_state(dir: &Path) -> SkillState {
    if !dir.exists() {
        return SkillState::Missing;
    }
    match std::fs::read_to_string(dir.join(SKILL_MARKER)) {
        Ok(version) => SkillState::Ours(version.trim().to_string()),
        Err(_) => SkillState::Foreign,
    }
}

pub(super) fn write_skill(dir: &Path, force: bool) -> Result<&'static str, String> {
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
pub(super) fn remove_skill(dir: &Path) -> Result<bool, String> {
    if !matches!(skill_state(dir), SkillState::Ours(_)) {
        return Ok(false);
    }
    let fail = |e: std::io::Error| format!("{}: {e}", dir.display());
    std::fs::remove_file(dir.join("SKILL.md")).map_err(fail)?;
    std::fs::remove_file(dir.join(SKILL_MARKER)).map_err(fail)?;
    let _ = std::fs::remove_dir(dir);
    Ok(true)
}
