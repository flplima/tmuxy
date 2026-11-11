//! `permissions.json`, the user's rules for what a caller may type into
//! another pane's shell (docs/PERMISSIONS.md).
//!
//! The file is the user's, in the config directory, and is read from disk on
//! every send: nothing caches it, so an edit holds from the next keystroke on
//! and no process can be handed a stale or rewritten copy.
//!
//! This version can only make a send STRICTER than it is without the file. A
//! `deny` rule refuses it, an `ask` rule (and everything the rules cannot
//! judge) puts the question to the user even where a tmux option would have
//! skipped it, and an `allow` rule is read, checked and reported but skips no
//! question yet. A file that cannot be read as rules refuses every send into
//! another pane and says why: it is never taken for "no rules".
//!
//! The rules bind callers that go through tmuxy (`tmuxy pane send`, the MCP
//! endpoint). A process with the tmux socket can type into a pane without
//! asking anyone, so this is a guardrail for cooperating agents, not a
//! sandbox.

use std::collections::BTreeMap;
use std::path::Path;

/// The section whose rules bind every caller.
pub const ANY_CALLER: &str = "*";

/// The shells a `Send` rule is about when the file names none: a command is
/// only a command where a shell reads it.
pub const DEFAULT_SHELLS: &[&str] = &["zsh", "bash", "fish", "sh", "dash", "ash", "nu"];

/// A file past this is not rules anyone wrote by hand.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// What turns a line into more than the one command its first word names.
/// The rules match the text of a command, so a line holding any of these is
/// asked about whatever they say.
const SHELL_OPERATORS: &[&str] = &[";", "|", "&", ">", "<", "`", "$(", "!!", "\n", "\r"];

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

impl Section {
    fn is_empty(&self) -> bool {
        self.allow.is_empty() && self.ask.is_empty() && self.deny.is_empty()
    }
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
    /// The file has nothing to say: no rules bind this caller, or the target
    /// is not running a shell. The send goes as it would without the file.
    NoOpinion,
    /// A `deny` rule matched: nothing is typed and nobody is asked.
    Deny(String),
    /// The user is asked, whatever a tmux option says: an `ask` rule matched,
    /// no rule did, or the rules cannot judge what is being typed.
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
            Decision::NoOpinion => "no rule in permissions.json binds this send",
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
    /// Pasted rather than typed: never a command the rules can match.
    pub paste: bool,
}

impl Permissions {
    /// Read rules out of the file's text. Strict on purpose: an unknown key,
    /// a rule of a kind this version does not know and a value of the wrong
    /// type are each an error, since the alternative is to carry on without
    /// a rule the user wrote.
    pub fn parse(text: &str) -> Result<Self, String> {
        let root: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
        let root = root
            .as_object()
            .ok_or("the file must hold one JSON object")?;
        let mut callers = BTreeMap::new();
        let mut shells: Vec<String> = DEFAULT_SHELLS.iter().map(|s| s.to_string()).collect();
        for (key, value) in root {
            match key.as_str() {
                "callers" => {
                    let sections = value.as_object().ok_or("`callers` must be an object")?;
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

    /// The sections that bind a caller: its own, by each name it answers to,
    /// and `*`.
    fn sections<'a>(&'a self, callers: &[&str]) -> Vec<(&'a str, &'a Section)> {
        self.callers
            .iter()
            .filter(|(name, section)| {
                !section.is_empty() && (*name == ANY_CALLER || callers.contains(&name.as_str()))
            })
            .map(|(name, section)| (name.as_str(), section))
            .collect()
    }

    /// What the rules say of `send`: `deny` over `ask` over `allow`, across
    /// every section that binds the caller, and `ask` when none matches.
    pub fn check_send(&self, send: Send<'_>) -> Decision {
        let sections = self.sections(send.callers);
        if sections.is_empty() {
            return Decision::NoOpinion;
        }
        if !self.shells.iter().any(|shell| shell == send.program) {
            return Decision::NoOpinion;
        }
        let Some(command) = command_of(send.keys).filter(|_| !send.paste) else {
            return Decision::Ask(
                "not one command ending in Enter, so the rules cannot judge it".into(),
            );
        };
        if let Some(operator) = SHELL_OPERATORS.iter().find(|op| command.contains(**op)) {
            let shown = operator.escape_default();
            return Decision::Ask(format!(
                "the line holds `{shown}`, so it may be more than the command the rules would match"
            ));
        }
        let command = squeeze(&command);
        let matched = |pick: fn(&Section) -> &Vec<Rule>| {
            sections.iter().find_map(|(caller, section)| {
                pick(section)
                    .iter()
                    .find(|rule| rule.matches(&command))
                    .map(|rule| format!("`{}` (callers.{caller})", rule.text))
            })
        };
        if let Some(rule) = matched(|s| &s.deny) {
            return Decision::Deny(format!("denied by {rule}"));
        }
        if let Some(rule) = matched(|s| &s.ask) {
            return Decision::Ask(format!("asked by {rule}"));
        }
        if let Some(rule) = matched(|s| &s.allow) {
            return Decision::Allow(format!("allowed by {rule}"));
        }
        Decision::Ask("no rule matches".into())
    }
}

fn parse_section(caller: &str, value: &serde_json::Value) -> Result<Section, String> {
    let object = value
        .as_object()
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

fn strings(value: &serde_json::Value, what: &str) -> Result<Vec<String>, String> {
    let not_strings = || format!("{what} must be a list of strings");
    value
        .as_array()
        .ok_or_else(not_strings)?
        .iter()
        .map(|item| item.as_str().map(str::to_string).ok_or_else(not_strings))
        .collect()
}

/// The command `keys` type and run: text, then exactly one `Enter`, last.
/// `None` for anything else: no Enter, an Enter in the middle or spelled
/// another way (`C-m`, a newline in the text), or a key name among the text.
/// tmux reads an argument that names a key as that key, so text and keys can
/// only be told apart the way tmux does it.
pub fn command_of(keys: &[String]) -> Option<String> {
    let (last, text) = keys.split_last()?;
    if last != "Enter" || text.is_empty() {
        return None;
    }
    if text.iter().any(|arg| names_a_key(arg)) {
        return None;
    }
    let command = text.concat();
    (!command.trim().is_empty()).then_some(command)
}

/// tmux's named keys (`key-string.c`), matched as tmux does, without case.
const NAMED_KEYS: &[&str] = &[
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
    "ic",
    "insert",
    "dc",
    "delete",
    "home",
    "end",
    "npage",
    "pagedown",
    "pgdn",
    "ppage",
    "pageup",
    "pgup",
    "btab",
    "space",
    "bspace",
    "tab",
    "enter",
    "escape",
    "up",
    "down",
    "left",
    "right",
    "kp/",
    "kp*",
    "kp-",
    "kp7",
    "kp8",
    "kp9",
    "kp+",
    "kp4",
    "kp5",
    "kp6",
    "kp1",
    "kp2",
    "kp3",
    "kpenter",
    "kp0",
    "kp.",
    "any",
    "none",
    "focusin",
    "focusout",
    "pastestart",
    "pasteend",
];

/// The families of key names tmux numbers or suffixes (`MouseDown1Pane`,
/// `WheelUpStatus`, `User0`).
const KEY_FAMILIES: &[&str] = &[
    "mouse",
    "wheel",
    "doubleclick",
    "tripleclick",
    "secondclick",
    "user",
];

/// Whether tmux would read `arg` as a key rather than as text. Wider than
/// tmux where it is cheap to be: an argument taken for a key only sends the
/// rules' verdict to "ask".
fn names_a_key(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    let modified = |prefix: &str| lower.len() > prefix.len() && lower.starts_with(prefix);
    NAMED_KEYS.contains(&lower.as_str())
        || KEY_FAMILIES.iter().any(|family| lower.starts_with(family))
        || ["c-", "m-", "s-"].iter().any(|prefix| modified(prefix))
        || (arg.len() == 2 && arg.starts_with('^'))
        || modified("0x")
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
