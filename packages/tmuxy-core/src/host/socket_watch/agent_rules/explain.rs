//! Where a pane's state came from, in words: `tmuxy pane state explain`.
//!
//! The screen rules leave a note of what they wrote and why
//! (`@tmuxy-rules-state`, `@tmuxy-rules-why`); anything else that sets the
//! state leaves none. So a state equal to the rules' note is theirs, one
//! that differs was declared, and a send's question owns the state while it
//! is up.

use serde::Serialize;

use super::user::UserRules;
use crate::constants::tmux_options;

/// Why the rules wrote a state, kept on the pane as a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    Dialog,
    Changed,
    Still,
    /// A user's rule: its file and its number in it, from 1.
    User {
        file: String,
        rule: usize,
    },
}

impl Why {
    /// One word, safe in a tmux command: a user file's name holds only
    /// letters, digits, `.`, `_` and `-` (`user::parse`).
    pub fn token(&self) -> String {
        match self {
            Why::Dialog => "dialog".into(),
            Why::Changed => "changed".into(),
            Why::Still => "still".into(),
            Why::User { file, rule } => format!("user:{file}:{rule}"),
        }
    }

    pub fn parse(token: &str) -> Option<Why> {
        match token {
            "dialog" => Some(Why::Dialog),
            "changed" => Some(Why::Changed),
            "still" => Some(Why::Still),
            _ => {
                let (file, rule) = token.strip_prefix("user:")?.rsplit_once(':')?;
                Some(Why::User {
                    file: file.to_string(),
                    rule: rule.parse().ok()?,
                })
            }
        }
    }

    /// In words, with a user rule's pattern from `user` when its file still
    /// has it.
    pub fn describe(&self, user: &UserRules) -> String {
        match self {
            Why::Dialog => "an approval dialog is on screen".into(),
            Why::Changed => "the screen changed since the last pass".into(),
            Why::Still => format!("the screen held still for {} passes", super::STILL_PASSES),
            Why::User { file, rule } => match user.rule(file, *rule) {
                Some(found) => format!("{file} rule {rule} matched '{}'", found.pattern),
                None => format!("{file} rule {rule} (no longer in the file)"),
            },
        }
    }
}

/// What a pane says about its state, as tmux holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    pub state: String,
    pub rules_state: String,
    pub rules_why: String,
    pub asking: bool,
    pub command: String,
    pub pid: Option<u32>,
}

/// The tmux format [`Facts::parse`] reads. The question is asked for as
/// a flag and the state comes last, so the two values anything may write
/// cannot shift the other fields: a state holding a tab stays one value.
pub fn facts_format() -> String {
    format!(
        "#{{{}}}\t#{{{}}}\t#{{?{},1,}}\t#{{pane_current_command}}\t#{{pane_pid}}\t#{{{}}}",
        tmux_options::RULES_STATE,
        tmux_options::RULES_WHY,
        tmux_options::ASK,
        tmux_options::PANE_STATE,
    )
}

impl Facts {
    pub fn parse(line: &str) -> Option<Facts> {
        let line = line.strip_suffix('\n').unwrap_or(line);
        let f: Vec<&str> = line.splitn(6, '\t').collect();
        let [rules_state, rules_why, ask, command, pid, state] = f[..] else {
            return None;
        };
        Some(Facts {
            state: state.into(),
            rules_state: rules_state.into(),
            rules_why: rules_why.into(),
            asking: !ask.is_empty(),
            command: command.into(),
            pid: pid.parse().ok(),
        })
    }

    /// `pane`'s facts, read from tmux; `None` when no pane answers.
    pub fn read(pane: &str) -> Option<Facts> {
        let output = crate::session::tmux_command()
            .args(["display-message", "-p", "-t", pane, &facts_format()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Facts::parse(&String::from_utf8_lossy(&output.stdout))
    }
}

/// Where the state came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    None,
    ScreenRules,
    Declared,
    Question,
}

/// What reads the pane's screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "file")]
pub enum ReadBy {
    /// The built-in signs.
    ScreenRules,
    /// A user's file (and the signs after it).
    UserRules(String),
    /// An agent with hooks: its hooks, and the screen for dialogs only.
    Hooks,
    Nothing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub state: String,
    pub source: Source,
    /// Why the screen rules wrote it, in words, when they did.
    pub rule: Option<String>,
    /// The program as the rules find it.
    pub program: String,
    pub command: String,
    pub read_by: ReadBy,
    /// The user's rule files that were left out, and why.
    pub problems: Vec<String>,
}

pub fn explain(facts: &Facts, program: &str, user: &UserRules) -> Explanation {
    let source = if facts.asking {
        Source::Question
    } else if facts.state.is_empty() {
        Source::None
    } else if facts.state == facts.rules_state {
        Source::ScreenRules
    } else {
        Source::Declared
    };
    let rule = (source == Source::ScreenRules)
        .then(|| Why::parse(&facts.rules_why).map(|why| why.describe(user)))
        .flatten();
    let read_by = if let Some(agent) = user.agents.iter().find(|a| a.command == program) {
        ReadBy::UserRules(agent.file.clone())
    } else if super::is_rule_agent(program) {
        ReadBy::ScreenRules
    } else if super::super::agent_screen::is_agent(&facts.command) {
        ReadBy::Hooks
    } else {
        ReadBy::Nothing
    };
    Explanation {
        state: facts.state.clone(),
        source,
        rule,
        program: program.to_string(),
        command: facts.command.clone(),
        read_by,
        problems: user.problems.clone(),
    }
}

impl Explanation {
    /// The text `explain` prints, one fact per line.
    pub fn render(&self, pane: &str) -> String {
        let state = if self.state.is_empty() {
            "no state"
        } else {
            &self.state
        };
        let source = match (self.source, &self.rule) {
            (Source::None, _) => "nothing has set one".to_string(),
            (Source::Question, _) => "a send's question is up on the pane".to_string(),
            (Source::Declared, _) => {
                "declared: an agent's hook, `tmuxy pane state`, or the program itself".to_string()
            }
            (Source::ScreenRules, Some(rule)) => format!("the screen rules: {rule}"),
            (Source::ScreenRules, None) => "the screen rules".to_string(),
        };
        let program = if self.program == self.command {
            self.program.clone()
        } else {
            format!("{} (tmux names it {})", self.program, self.command)
        };
        let read_by = match &self.read_by {
            ReadBy::ScreenRules => "the screen rules' built-in signs".to_string(),
            ReadBy::UserRules(file) => format!("the screen rules, with {file} first"),
            ReadBy::Hooks => "its hooks; the screen only for approval dialogs".to_string(),
            ReadBy::Nothing => "nothing: only a declared state shows".to_string(),
        };
        let mut lines = vec![
            format!("{pane} {state}"),
            format!("source: {source}"),
            format!("program: {program}"),
            format!("read by: {read_by}"),
        ];
        lines.extend(self.problems.iter().map(|p| format!("left out: {p}")));
        lines.join("\n")
    }
}

#[cfg(test)]
#[path = "explain_tests.rs"]
mod tests;
