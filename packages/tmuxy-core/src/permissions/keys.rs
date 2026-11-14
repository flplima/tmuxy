//! Which of `send-keys`' arguments are text and which are keys, as tmux
//! reads them: what makes keys one command a rule can judge.

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
pub(super) fn names_a_key(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    let modified = |prefix: &str| lower.len() > prefix.len() && lower.starts_with(prefix);
    NAMED_KEYS.contains(&lower.as_str())
        || KEY_FAMILIES.iter().any(|family| lower.starts_with(family))
        || ["c-", "m-", "s-"].iter().any(|prefix| modified(prefix))
        || (arg.len() == 2 && arg.starts_with('^'))
        || modified("0x")
}
