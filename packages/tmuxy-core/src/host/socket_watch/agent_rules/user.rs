//! The user's own screen rules: `~/.config/tmuxy/agents/<name>.toml`, one
//! file per agent.
//!
//! ```toml
//! command = "gemini"            # the pane's command; default: the file's name
//!
//! [[rule]]
//! match = 'Waiting for your reply'
//! state = "..."                 # one of [`STATES`]
//! ```
//!
//! A file names an agent the built-in rules do not know, or adds rules to
//! one they do. A rule is a regex over the bottom of the screen; the first
//! that matches gives the state, ahead of the built-in signs. A file for an
//! agent with hooks (Claude Code, Codex, Antigravity) is ignored: its hooks
//! own its state.
//!
//! Pane output is untrusted and the pattern is the user's, so both are
//! bounded: a pattern compiles with the plugins' limits (256 characters,
//! linear-time matching, bounded memory), and it reads at most
//! [`MAX_LINES`] lines of [`MAX_LINE_CHARS`] each. Nothing here sends keys.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::PaneStateName;

/// How much of the bottom of a screen a rule reads.
pub const MAX_LINES: usize = 15;
pub const MAX_LINE_CHARS: usize = 512;
/// The most rules read from one file, and the most files.
const MAX_RULES: usize = 32;
const MAX_FILES: usize = 32;
/// How often the files are read again: a change shows within this.
const RELOAD: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub struct Rule {
    pub pattern: String,
    regex: regex::Regex,
    pub state: PaneStateName,
}

#[derive(Debug)]
pub struct UserAgent {
    /// The file it came from, for `explain`.
    pub file: String,
    pub command: String,
    pub rules: Vec<Rule>,
}

/// Every user rule, and what was wrong with the ones that were left out.
#[derive(Debug, Default)]
pub struct UserRules {
    pub agents: Vec<UserAgent>,
    pub problems: Vec<String>,
    read_at: Option<Instant>,
}

/// The text a rule reads: the bottom [`MAX_LINES`] non-empty lines of the
/// screen, each cut to [`MAX_LINE_CHARS`] characters.
pub fn bottom(screen: &str) -> String {
    let lines: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(MAX_LINES)..]
        .iter()
        .map(|line| line.chars().take(MAX_LINE_CHARS).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The states a rule may give: never `done`, which no screen can tell
/// from a pause.
pub const STATES: [PaneStateName; 4] = [
    PaneStateName::NeedsInput,
    PaneStateName::Working,
    PaneStateName::Idle,
    PaneStateName::Error,
];

fn state(word: &str) -> Option<PaneStateName> {
    STATES.into_iter().find(|s| s.as_str() == word)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    command: Option<String>,
    #[serde(default)]
    rule: Vec<RawRule>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    #[serde(rename = "match")]
    pattern: String,
    state: String,
}

/// One file's agent, or why it was left out. `name` is the file's stem.
pub fn parse(name: &str, text: &str) -> Result<UserAgent, String> {
    let file: File = toml::from_str(text).map_err(|e| e.message().to_string())?;
    let command = file.command.unwrap_or_else(|| name.to_string());
    if super::super::agent_screen::is_agent(&command) {
        return Err(format!("{command} has hooks, which own its state"));
    }
    if file.rule.len() > MAX_RULES {
        return Err(format!("more than {MAX_RULES} rules"));
    }
    let mut rules = Vec::new();
    for (n, raw) in file.rule.into_iter().enumerate() {
        let state = state(&raw.state).ok_or_else(|| {
            let states: Vec<&str> = STATES.iter().map(|s| s.as_str()).collect();
            format!(
                "rule {}: state {:?} is not one of {}",
                n + 1,
                raw.state,
                states.join(", ")
            )
        })?;
        let regex = crate::plugins::manifest::sections::compile(&raw.pattern)
            .map_err(|e| format!("rule {}: {e}", n + 1))?;
        rules.push(Rule {
            pattern: raw.pattern,
            regex,
            state,
        });
    }
    Ok(UserAgent {
        file: format!("{name}.toml"),
        command,
        rules,
    })
}

impl UserRules {
    /// Read `dir`'s `*.toml` again when [`RELOAD`] has passed.
    pub fn refresh(&mut self, dir: &Path, now: Instant) {
        if self
            .read_at
            .is_some_and(|at| now.duration_since(at) < RELOAD)
        {
            return;
        }
        *self = Self::read(dir);
        self.read_at = Some(now);
    }

    pub fn read(dir: &Path) -> Self {
        let mut rules = UserRules::default();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return rules;
        };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "toml"))
            .collect();
        files.sort();
        for path in files.into_iter().take(MAX_FILES) {
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            // A rules file is a few lines: one far larger is not one.
            let text = match std::fs::metadata(&path) {
                Ok(meta) if meta.len() <= 64 * 1024 => std::fs::read_to_string(&path).ok(),
                _ => None,
            };
            match text.map(|text| parse(&name, &text)) {
                Some(Ok(agent)) => rules.agents.push(agent),
                Some(Err(problem)) => rules.problems.push(format!("{name}.toml: {problem}")),
                None => rules.problems.push(format!("{name}.toml: not read")),
            }
        }
        rules
    }

    pub fn knows(&self, command: &str) -> bool {
        self.agents.iter().any(|a| a.command == command)
    }

    /// The first rule of `command`'s that matches the bottom of `screen`.
    pub fn matching(&self, command: &str, screen: &str) -> Option<&Rule> {
        let text = bottom(screen);
        self.agents
            .iter()
            .filter(|a| a.command == command)
            .flat_map(|a| a.rules.iter())
            .find(|rule| rule.regex.is_match(&text))
    }
}

#[cfg(test)]
#[path = "user_tests.rs"]
mod tests;
