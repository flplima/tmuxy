//! `permissions.json`, the user's rules for what a caller may type into
//! another pane's shell (docs/PERMISSIONS.md).
//!
//! The file is the user's, in the config directory, and is read from disk on
//! every send: nothing caches it, so an edit holds from the next keystroke on
//! and no process can be handed a stale or rewritten copy.
//!
//! This version can only make a send STRICTER than it is without the file. A
//! `deny` rule refuses it, whatever program the target pane runs; an `ask`
//! rule (and everything the rules cannot judge) puts the question to the
//! user even where a tmux option would have skipped it; and an `allow` rule
//! is read, checked and reported but skips no question yet. A file that cannot be read as rules refuses every send into
//! another pane and says why: it is never taken for "no rules".
//!
//! The rules bind callers that go through tmuxy (`tmuxy pane send`, the MCP
//! endpoint). A process with the tmux socket can type into a pane without
//! asking anyone, so this is a guardrail for cooperating agents, not a
//! sandbox.

use std::collections::BTreeMap;
use std::path::Path;

mod json;
mod keys;

use json::Json;
pub use keys::command_of;
use keys::names_a_key;

/// The section whose rules bind every caller.
pub const ANY_CALLER: &str = "*";

/// The shells a `Send` rule is about when the file names none: a command is
/// only a command where a shell reads it.
pub const DEFAULT_SHELLS: &[&str] = &["zsh", "bash", "fish", "sh", "dash", "ash", "nu"];

/// A file past this is not rules anyone wrote by hand.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// What turns a line into more than the one command its first word names.
/// The rules match the text of a command, so a line holding any of these is
/// asked about unless a `deny` rule refuses it first.
const SHELL_OPERATORS: &[&str] = &[
    ";", "|", "&", ">", "<", "`", "$(", "(", ")", "{", "}", "!", "\n", "\r",
];

/// Where a line is cut into the commands it may hold, for the `deny` rules:
/// each piece is matched on its own, so `ls; rm -rf x` is refused by
/// `Send(rm *)` as `rm -rf x` alone is.
const PIECE_ENDS: &[char] = &[';', '|', '&', '>', '<', '`', '(', ')', '{', '}', '\n', '\r'];

/// One `Send(<pattern>)` rule, kept as written for the messages that name it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    text: String,
    pattern: String,
}

impl Rule {
    /// `Send(gh *)`. Any other kind is an error, not a rule skipped: a rule
    /// the reader does not understand may be the one that was meant to deny.
    fn parse(text: &str) -> Result<Self, String> {
        let trimmed = text.trim();
        let inside = trimmed
            .strip_suffix(')')
            .and_then(|rest| rest.split_once('('));
        let Some((kind, pattern)) = inside else {
            return Err(format!("rule `{text}` is not of the form Send(<pattern>)"));
        };
        if kind != "Send" {
            return Err(format!(
                "rule `{text}`: only Send(...) rules are understood by this version"
            ));
        }
        let pattern = squeeze(pattern);
        if pattern.is_empty() {
            return Err(format!("rule `{text}` has an empty pattern"));
        }
        Ok(Self {
            text: trimmed.to_string(),
            pattern,
        })
    }

    fn matches(&self, command: &str) -> bool {
        glob(&self.pattern, command)
    }
}

/// `text` with every run of whitespace as one space and none at the ends:
/// how a pattern and a command are compared, so `rm  -rf` is `rm -rf`.
fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `pattern` against the whole of `text`: `*` is any run of characters, the
/// empty one included, and every other character is itself.
fn glob(pattern: &str, text: &str) -> bool {
    let (pattern, text): (Vec<char>, Vec<char>) =
        (pattern.chars().collect(), text.chars().collect());
    // The classic two-pointer walk: on a mismatch, go back to the last `*`
    // and let it take one more character.
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

/// One caller's rules.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Section {
    allow: Vec<Rule>,
    ask: Vec<Rule>,
    deny: Vec<Rule>,
}

/// The rules of a file that parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permissions {
    callers: BTreeMap<String, Section>,
    shells: Vec<String>,
}

/// What the file says of one send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// The file has nothing to say: no section binds this caller. The send
    /// goes as it would without the file.
    NoOpinion,
    /// A `deny` rule matched: nothing is typed and nobody is asked.
    Deny(String),
    /// The user is asked, whatever a tmux option says: an `ask` rule matched,
    /// no rule did, or the rules cannot judge what is being typed or what
    /// the program in the target pane makes of it.
    Ask(String),
    /// An `allow` rule matched. Reported, and in this version asked like any
    /// other send.
    Allow(String),
}

impl Decision {
    pub fn word(&self) -> &'static str {
        match self {
            Decision::NoOpinion => "none",
            Decision::Deny(_) => "deny",
            Decision::Ask(_) => "ask",
            Decision::Allow(_) => "allow",
        }
    }

    pub fn reason(&self) -> &str {
        match self {
            Decision::NoOpinion => "no section of permissions.json binds this caller",
            Decision::Deny(why) | Decision::Ask(why) | Decision::Allow(why) => why,
        }
    }
}

/// One send, as the rules see it.
#[derive(Debug, Clone, Copy)]
pub struct Send<'a> {
    /// The names the caller answers to: its own, and for an MCP client `mcp`.
    pub callers: &'a [&'a str],
    /// The program in front in the target pane ([`crate::program::program_name`]).
    pub program: &'a str,
    /// The keys, as `send-keys` would take them.
    pub keys: &'a [String],
    /// Pasted rather than typed: never a command a rule can allow.
    pub paste: bool,
}

impl Permissions {
    /// Read rules out of the file's text. Strict on purpose: an unknown key,
    /// a key written twice, a rule of a kind this version does not know and
    /// a value of the wrong type are each an error, since the alternative is
    /// to carry on without a rule the user wrote.
    pub fn parse(text: &str) -> Result<Self, String> {
        let root: Json = serde_json::from_str(text).map_err(|e| {
            if e.is_data() {
                e.to_string()
            } else {
                format!("not JSON: {e}")
            }
        })?;
        let root = root.object().ok_or("the file must hold one JSON object")?;
        let mut callers = BTreeMap::new();
        let mut shells: Vec<String> = DEFAULT_SHELLS.iter().map(|s| s.to_string()).collect();
        for (key, value) in root {
            match key.as_str() {
                "callers" => {
                    let sections = value.object().ok_or("`callers` must be an object")?;
                    for (caller, section) in sections {
                        if caller.trim().is_empty() {
                            return Err("a caller's name is empty".into());
                        }
                        callers.insert(caller.clone(), parse_section(caller, section)?);
                    }
                }
                "shells" => shells = strings(value, "`shells`")?,
                other => return Err(format!("unknown key `{other}`")),
            }
        }
        if shells.iter().any(|shell| shell.trim().is_empty()) {
            return Err("`shells` holds an empty name".into());
        }
        Ok(Self { callers, shells })
    }

    /// How many rules the file holds, and for how many callers.
    pub fn counts(&self) -> (usize, usize) {
        let rules = self
            .callers
            .values()
            .map(|s| s.allow.len() + s.ask.len() + s.deny.len())
            .sum();
        (rules, self.callers.len())
    }

    /// The callers the file has a section for, `*` included.
    pub fn callers(&self) -> Vec<&str> {
        self.callers.keys().map(String::as_str).collect()
    }

    /// The sections that bind a caller: its own, by each name it answers to,
    /// and `*`. A section with no rules binds too: its caller is asked.
    fn sections<'a>(&'a self, callers: &[&str]) -> Vec<(&'a str, &'a Section)> {
        self.callers
            .iter()
            .filter(|(name, _)| *name == ANY_CALLER || callers.contains(&name.as_str()))
            .map(|(name, section)| (name.as_str(), section))
            .collect()
    }

    /// What the rules say of `send`: `deny` over `ask` over `allow`, across
    /// every section that binds the caller, and `ask` when none matches.
    ///
    /// The `deny` rules are tried first and against more than the others:
    /// whatever the keys hold that could be a command, in any program and
    /// with or without an Enter. Being wrong that way only refuses a send.
    /// `ask` and `allow` are tried against one command a shell will run.
    pub fn check_send(&self, send: Send<'_>) -> Decision {
        let sections = self.sections(send.callers);
        if sections.is_empty() {
            return Decision::NoOpinion;
        }
        let matched = |pick: fn(&Section) -> &Vec<Rule>, texts: &[String]| {
            sections.iter().find_map(|(caller, section)| {
                pick(section)
                    .iter()
                    .find(|rule| texts.iter().any(|text| rule.matches(text)))
                    .map(|rule| format!("`{}` (callers.{caller})", rule.text))
            })
        };
        if let Some(rule) = matched(|s| &s.deny, &pieces_of(send.keys, send.paste)) {
            return Decision::Deny(format!("denied by {rule}"));
        }
        if !self.shells.iter().any(|shell| shell == send.program) {
            return Decision::Ask(format!(
                "the target pane runs `{}`, not a listed shell, so the rules cannot judge what the keys do there",
                send.program
            ));
        }
        let Some(command) = command_of(send.keys).filter(|_| !send.paste) else {
            return Decision::Ask(
                "not one command ending in Enter, so the rules cannot judge it".into(),
            );
        };
        if let Some(operator) = operator_in(&command) {
            let shown = operator.escape_default();
            return Decision::Ask(format!(
                "the line holds `{shown}`, so it may be more than the command the rules would match"
            ));
        }
        let command = [squeeze(&command)];
        if let Some(rule) = matched(|s| &s.ask, &command) {
            return Decision::Ask(format!("asked by {rule}"));
        }
        if let Some(rule) = matched(|s| &s.allow, &command) {
            return Decision::Allow(format!("allowed by {rule}"));
        }
        Decision::Ask("no rule matches".into())
    }
}

/// The operator that makes `command` more than one command, if it holds one.
/// `^old^new` is history expansion only at the start of a line.
fn operator_in(command: &str) -> Option<&'static str> {
    if command.trim_start().starts_with('^') {
        return Some("^");
    }
    SHELL_OPERATORS
        .iter()
        .copied()
        .find(|op| command.contains(op))
}

/// Everything in `keys` that a `deny` rule is matched against: the text as a
/// whole, each of its lines, and each piece of a line between shell
/// operators. The text is read both ways an argument can be read: with key
/// names as keys (a line ends at each, `Space` is a space) and with every
/// argument as text, since tmux and this reader may disagree on which is
/// which.
fn pieces_of(keys: &[String], paste: bool) -> Vec<String> {
    let as_text = match keys.split_last() {
        Some((last, text)) if !paste && names_a_key(last) => text.concat(),
        _ => keys.concat(),
    };
    let mut as_keys = String::new();
    for arg in keys {
        match arg.to_ascii_lowercase().as_str() {
            _ if paste => as_keys.push_str(arg),
            "space" => as_keys.push(' '),
            _ if names_a_key(arg) => as_keys.push('\n'),
            _ => as_keys.push_str(arg),
        }
    }
    let mut pieces = Vec::new();
    for text in [as_text, as_keys] {
        pieces.push(squeeze(&text));
        for line in text.split(['\n', '\r']) {
            pieces.push(squeeze(line));
            pieces.extend(line.split(PIECE_ENDS).map(squeeze));
        }
    }
    pieces.retain(|piece| !piece.is_empty());
    pieces.sort();
    pieces.dedup();
    pieces
}

fn parse_section(caller: &str, value: &Json) -> Result<Section, String> {
    let object = value
        .object()
        .ok_or_else(|| format!("callers.{caller} must be an object"))?;
    let mut section = Section::default();
    for (key, rules) in object {
        let list = match key.as_str() {
            "allow" => &mut section.allow,
            "ask" => &mut section.ask,
            "deny" => &mut section.deny,
            other => return Err(format!("callers.{caller}: unknown key `{other}`")),
        };
        for rule in strings(rules, &format!("callers.{caller}.{key}"))? {
            list.push(Rule::parse(&rule).map_err(|e| format!("callers.{caller}.{key}: {e}"))?);
        }
    }
    Ok(section)
}

fn strings(value: &Json, what: &str) -> Result<Vec<String>, String> {
    let not_strings = || format!("{what} must be a list of strings");
    let Json::List(items) = value else {
        return Err(not_strings());
    };
    items
        .iter()
        .map(|item| match item {
            Json::Text(text) => Ok(text.clone()),
            _ => Err(not_strings()),
        })
        .collect()
}

/// The file as it was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Loaded {
    /// No file: tmuxy behaves as it does without one.
    Missing,
    Rules(Permissions),
    /// There is a file and it cannot be read as rules. The reason names what
    /// is wrong with it.
    Malformed(String),
}

impl Loaded {
    /// Read `path` now. Anything but "there is no such file" that keeps the
    /// rules from being read is [`Loaded::Malformed`]: a file that is there
    /// and unreadable must not behave like one that is not.
    pub fn read(path: &Path) -> Self {
        let size = match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() => meta.len(),
            Ok(_) => return Loaded::Malformed("it is not a regular file".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // A dangling symlink is a file the user meant to have.
                return match std::fs::symlink_metadata(path) {
                    Ok(_) => Loaded::Malformed("it is a link to a file that is not there".into()),
                    Err(_) => Loaded::Missing,
                };
            }
            Err(e) => return Loaded::Malformed(format!("it cannot be read: {e}")),
        };
        if size > MAX_FILE_BYTES {
            return Loaded::Malformed(format!("it is larger than {MAX_FILE_BYTES} bytes"));
        }
        match std::fs::read_to_string(path) {
            Ok(text) => match Permissions::parse(&text) {
                Ok(rules) => Loaded::Rules(rules),
                Err(why) => Loaded::Malformed(why),
            },
            Err(e) => Loaded::Malformed(format!("it cannot be read: {e}")),
        }
    }

    /// What the file says of `send`. A malformed file denies: its rules are
    /// unknown, and one of them may have been the deny for exactly this.
    pub fn check_send(&self, send: Send<'_>) -> Decision {
        match self {
            Loaded::Missing => Decision::NoOpinion,
            Loaded::Rules(rules) => rules.check_send(send),
            Loaded::Malformed(why) => Decision::Deny(format!(
                "permissions.json cannot be read as rules ({why}); fix it or remove it"
            )),
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_file;
