use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::{Agent, Hook};

pub(crate) const SKILL: &str = include_str!("../../../../.agents/skills/tmuxy/SKILL.md");
pub(super) const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Written beside an installed SKILL.md: what makes the directory tmuxy's to
/// update or remove, and the version `status` compares against.
const SKILL_MARKER: &str = ".tmuxy-version";
/// Every installed hook command contains this, followed by agent and event.
const HOOK_VERB: &str = " agent hook ";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Scope {
    Home,
    Project,
}

pub(super) struct Places {
    pub(super) home: PathBuf,
    pub(super) cwd: PathBuf,
    pub(super) claude_dir: PathBuf,
    pub(super) codex_home: PathBuf,
    /// `$XDG_CONFIG_HOME`, else `~/.config`: where OpenCode and Crush keep theirs.
    pub(super) config_home: PathBuf,
    /// `$CRUSH_SKILLS_DIR`, else Crush's own under `config_home`.
    pub(super) crush_skills: PathBuf,
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
        let config_home = env_dir("XDG_CONFIG_HOME", home.join(".config"));
        Ok(Places {
            claude_dir: env_dir("CLAUDE_CONFIG_DIR", home.join(".claude")),
            codex_home: env_dir("CODEX_HOME", home.join(".codex")),
            crush_skills: env_dir("CRUSH_SKILLS_DIR", config_home.join("crush/skills")),
            config_home,
            path: std::env::var_os("PATH"),
            home,
            cwd,
        })
    }

    /// Where an agent's hooks are kept; none for an agent whose hooks are code.
    pub(super) fn hooks_file(&self, agent: Agent, scope: Scope) -> Option<PathBuf> {
        Some(match (agent, scope) {
            (Agent::Claude, Scope::Home) => self.claude_dir.join("settings.json"),
            // A hook names a path on this machine, so it is personal: the
            // project's local settings, not the shared ones.
            (Agent::Claude, Scope::Project) => self.cwd.join(".claude/settings.local.json"),
            (Agent::Codex, Scope::Home) => self.codex_home.join("hooks.json"),
            (Agent::Codex, Scope::Project) => self.cwd.join(".codex/hooks.json"),
            (Agent::Agy, Scope::Home) => self.home.join(".gemini/config/hooks.json"),
            (Agent::Agy, Scope::Project) => self.cwd.join(".agents/hooks.json"),
            (Agent::Opencode | Agent::Pi | Agent::Crush, _) => return None,
        })
    }

    /// Where an agent reads the tmuxy skill from; none where it reads no
    /// project skills tmuxy knows of.
    pub(super) fn skill_dir(&self, agent: Agent, scope: Scope) -> Option<PathBuf> {
        let root = match (agent, scope) {
            (Agent::Claude, Scope::Home) => self.claude_dir.join("skills"),
            (Agent::Claude, Scope::Project) => self.cwd.join(".claude/skills"),
            (Agent::Codex, Scope::Home) => self.home.join(".agents/skills"),
            (Agent::Agy, Scope::Home) => self.home.join(".gemini/config/skills"),
            (Agent::Codex | Agent::Agy, Scope::Project) => self.cwd.join(".agents/skills"),
            (Agent::Opencode, Scope::Home) => self.config_home.join("opencode/skills"),
            (Agent::Opencode, Scope::Project) => self.cwd.join(".opencode/skills"),
            (Agent::Pi, Scope::Home) => self.home.join(".pi/agent/skills"),
            (Agent::Crush, Scope::Home) => self.crush_skills.clone(),
            (Agent::Pi | Agent::Crush, Scope::Project) => return None,
        };
        Some(root.join("tmuxy"))
    }

    /// Installed on this machine: its binary is on PATH, or it has left its
    /// configuration directory behind.
    pub(super) fn detected(&self, agent: Agent) -> bool {
        let (binary, dir) = match agent {
            Agent::Claude => ("claude", self.claude_dir.clone()),
            Agent::Codex => ("codex", self.codex_home.clone()),
            Agent::Agy => ("agy", self.home.join(".gemini/antigravity-cli")),
            Agent::Opencode => ("opencode", self.config_home.join("opencode")),
            Agent::Pi => ("pi", self.home.join(".pi/agent")),
            Agent::Crush => ("crush", self.config_home.join("crush")),
        };
        dir.is_dir()
            || self
                .path
                .as_ref()
                .is_some_and(|path| std::env::split_paths(path).any(|d| d.join(binary).is_file()))
    }

    pub(super) fn show(&self, path: &Path) -> String {
        match path.strip_prefix(&self.home) {
            Ok(rest) => format!("~/{}", rest.display()),
            Err(_) => path.display().to_string(),
        }
    }
}

fn is_ours(handler: &Value) -> bool {
    handler
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(HOOK_VERB) && c.contains("tmuxy"))
}

/// The hook's command. Guarded, because an agent's settings often live in a
/// dotfiles repo shared with machines that have no tmuxy (or an older one
/// without `agent hook`): there it does nothing and still succeeds, rather
/// than report a failed hook on every event. The path is shell-quoted: the
/// agent runs this line through a shell, and `--hook-command` may name a path
/// with a space (`~/Library/Application Support/…`) or worse.
#[cfg(test)]
pub(super) fn hook_command(agent: Agent, event: &str, tmuxy: &str) -> String {
    quoted_hook_command(agent, event, &tmuxy_core::argv::shell_word(tmuxy))
}

/// [`hook_command`] with the tmuxy command already a shell word.
fn quoted_hook_command(agent: Agent, event: &str, tmuxy: &str) -> String {
    format!(
        "command -v {tmuxy} >/dev/null 2>&1 && {tmuxy}{HOOK_VERB}{} {event} 2>/dev/null || true",
        agent.name()
    )
}

/// The shell word an installed hook runs tmuxy with, read back from its
/// command: what `--hook-command` was when it was installed.
fn installed_tmuxy(command: &str) -> Option<&str> {
    command
        .strip_prefix("command -v ")?
        .split_once(" >/dev/null")
        .map(|(word, _)| word)
}

fn handler(agent: Agent, hook: &Hook, tmuxy: &str) -> Value {
    quoted_handler(agent, hook, &tmuxy_core::argv::shell_word(tmuxy))
}

fn quoted_handler(agent: Agent, hook: &Hook, tmuxy: &str) -> Value {
    json!({
        "type": "command",
        "command": quoted_hook_command(agent, hook.event, tmuxy),
        "timeout": hook.timeout,
    })
}

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

/// tmuxy's handlers in `doc`, each with its event and matcher, in a fixed
/// order: what two installs are compared by.
fn our_entries(doc: &Map<String, Value>, agent: Agent) -> Vec<(String, Value, Value)> {
    let mut entries = Vec::new();
    let mut take = |event: &str, matcher: Value, handlers: Option<&Value>| {
        for handler in handlers.and_then(Value::as_array).into_iter().flatten() {
            if is_ours(handler) {
                entries.push((event.to_string(), matcher.clone(), handler.clone()));
            }
        }
    };
    if agent.named_hooks() {
        for (event, handlers) in doc
            .get("tmuxy")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            take(event, Value::Null, Some(handlers));
        }
    } else {
        let events = doc.get("hooks").and_then(Value::as_object);
        for (event, groups) in events.into_iter().flatten() {
            for group in groups.as_array().into_iter().flatten() {
                let matcher = group.get("matcher").cloned().unwrap_or(Value::Null);
                take(event, matcher, group.get("hooks"));
            }
        }
    }
    entries.sort_by(|a, b| {
        (&a.0, a.1.to_string(), a.2.to_string()).cmp(&(&b.0, b.1.to_string(), b.2.to_string()))
    });
    entries
}

/// How the hooks in `doc` compare with what an install writes today.
pub(super) fn hooks_state(doc: &Map<String, Value>, agent: Agent) -> ItemState {
    let found = our_entries(doc, agent);
    let Some(tmuxy) = found.iter().find_map(|(_, _, h)| {
        h.get("command")
            .and_then(Value::as_str)
            .and_then(installed_tmuxy)
    }) else {
        return if found.is_empty() {
            ItemState::Missing
        } else {
            ItemState::Outdated("written in a form this tmuxy does not write".into())
        };
    };
    let mut wanted = Map::new();
    if agent.named_hooks() {
        let mut set = Map::new();
        for hook in agent.hooks() {
            set.insert(
                hook.event.into(),
                json!([quoted_handler(agent, hook, tmuxy)]),
            );
        }
        wanted.insert("tmuxy".into(), Value::Object(set));
    } else {
        let mut events = Map::new();
        for hook in agent.hooks() {
            let mut group = Map::new();
            if let Some(matcher) = hook.matcher {
                group.insert("matcher".into(), json!(matcher));
            }
            group.insert("hooks".into(), json!([quoted_handler(agent, hook, tmuxy)]));
            events.insert(hook.event.into(), json!([group]));
        }
        wanted.insert("hooks".into(), Value::Object(events));
    }
    if found == our_entries(&wanted, agent) {
        return ItemState::Current;
    }
    let hooked = hooked_events(doc, agent);
    let all = agent.hooks().len();
    ItemState::Outdated(if hooked < all {
        format!("{hooked} of {all} events")
    } else {
        "the events or their settings changed".into()
    })
}

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

/// In a test, a write anywhere but the system's temp dir is a bug that would
/// have rewritten the developer's own agent config: stop there.
fn guard(path: &Path) {
    if cfg!(test) {
        let temp =
            std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
        let at = path
            .ancestors()
            .find_map(|p| std::fs::canonicalize(p).ok())
            .unwrap_or_else(|| path.to_path_buf());
        assert!(
            at.starts_with(&temp),
            "a test wrote outside the temp dir: {}",
            path.display()
        );
    }
}

pub(super) fn write_doc(path: &Path, doc: &Map<String, Value>) -> Result<bool, String> {
    guard(path);
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

pub(super) enum SkillState {
    Missing,
    Ours(String),
    /// A `tmuxy` skill tmuxy did not write: the user's own, left alone.
    Foreign,
}

/// Where one installed item stands against what an install writes today.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ItemState {
    /// What an install would write now.
    Current,
    /// tmuxy's, but not what an install would write now: why, in words.
    Outdated(String),
    Missing,
    /// A `tmuxy` skill tmuxy did not write.
    Foreign,
    /// The file could not be read: why.
    Unreadable(String),
    /// The agent has no such thing tmuxy can install: hooks that are code, a
    /// project skill folder tmuxy does not know of.
    Unsupported,
}

impl ItemState {
    pub(super) fn word(&self) -> &'static str {
        match self {
            ItemState::Current => "current",
            ItemState::Outdated(_) => "outdated",
            ItemState::Missing => "missing",
            ItemState::Foreign => "foreign",
            ItemState::Unreadable(_) => "unreadable",
            ItemState::Unsupported => "unsupported",
        }
    }

    /// The word, and why when there is a why.
    pub(super) fn said(&self) -> String {
        match self {
            ItemState::Outdated(why) | ItemState::Unreadable(why) => {
                format!("{}: {why}", self.word())
            }
            ItemState::Foreign => "foreign: not written by tmuxy".into(),
            _ => self.word().into(),
        }
    }
}

/// How the skill in `dir` compares with the one this tmuxy carries: by its
/// version, and by its text, which changes between builds of one version.
pub(super) fn skill_item(dir: &Path) -> ItemState {
    match skill_state(dir) {
        SkillState::Missing => ItemState::Missing,
        SkillState::Foreign => ItemState::Foreign,
        SkillState::Ours(version) if version != VERSION => {
            ItemState::Outdated(format!("written by {version}, this is {VERSION}"))
        }
        SkillState::Ours(_) => match std::fs::read_to_string(dir.join("SKILL.md")) {
            Ok(text) if text == SKILL => ItemState::Current,
            Ok(_) => ItemState::Outdated("the skill's text changed".into()),
            Err(e) => ItemState::Unreadable(e.to_string()),
        },
    }
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
    guard(dir);
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

pub(super) fn remove_skill(dir: &Path) -> Result<bool, String> {
    guard(dir);
    if !matches!(skill_state(dir), SkillState::Ours(_)) {
        return Ok(false);
    }
    let fail = |e: std::io::Error| format!("{}: {e}", dir.display());
    std::fs::remove_file(dir.join("SKILL.md")).map_err(fail)?;
    std::fs::remove_file(dir.join(SKILL_MARKER)).map_err(fail)?;
    let _ = std::fs::remove_dir(dir);
    Ok(true)
}
