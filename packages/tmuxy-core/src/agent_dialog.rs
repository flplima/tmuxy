//! Whether an agent's pane shows an approval dialog: what the sidebar's
//! screen corrector reads (`host/socket_watch/agent_screen.rs`), and what a
//! send checks so that nothing is ever typed into a permission prompt
//! (`crate::ask::at_prompt`).

/// How far up a dialog is looked for: the bottom of the screen, where every
/// agent draws its prompt, and not output that has scrolled above it.
pub(crate) const BOTTOM_LINES: usize = 15;

/// The question lines the agents' approval dialogs open with: Claude Code's
/// "Do you want to proceed?" / "Do you want to make this edit…", Codex's
/// "Would you like to run the following command?", Antigravity's "Do you
/// want to proceed?", "Allow access to this file?", "Requesting permission
/// for:".
const QUESTIONS: [&str; 4] = [
    "Do you want to",
    "Would you like to",
    "Requesting permission",
    "Allow access to",
];

/// The glyphs a dialog's menu marks its chosen option with.
const CURSORS: [char; 4] = ['❯', '›', '>', '▶'];

/// The processes of the agents tmuxy installs hooks for (`tmuxy agent`),
/// Antigravity under either of its names.
pub const AGENT_COMMANDS: [&str; 4] = ["claude", "codex", "agy", "antigravity"];

pub fn is_agent(command: &str) -> bool {
    AGENT_COMMANDS.contains(&crate::program::program_name(command))
}

/// A menu option's line (`N. text`, maybe after a cursor glyph): whether the
/// cursor is on it, and its text.
fn option_number(line: &str) -> Option<(bool, &str)> {
    let line = line.trim_start();
    let (cursor, rest) = match line.strip_prefix(CURSORS) {
        Some(rest) => (true, rest.trim_start()),
        None => (false, line),
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && rest[digits..].starts_with(". ")).then(|| (cursor, &rest[digits + 2..]))
}

/// Whether the bottom of `screen` shows an approval dialog: a numbered menu
/// with its cursor on an option, or one of the dialogs' questions over a
/// "Yes", or a `(y/n)`. Each needs two lines' agreement, or a closing
/// question in the agent's own reply ("Would you like to…?") would count.
pub fn shows_dialog(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).collect();
    let bottom = &lines[lines.len().saturating_sub(BOTTOM_LINES)..];
    let options: Vec<(bool, &str)> = bottom.iter().filter_map(|l| option_number(l)).collect();
    let menu = options.len() >= 2 && options.iter().any(|(cursor, _)| *cursor);
    let asked = bottom
        .iter()
        .position(|l| QUESTIONS.iter().any(|q| l.contains(q)))
        .is_some_and(|at| bottom[at + 1..].iter().any(|l| l.contains("Yes")));
    let yes_no = bottom.iter().any(|l| {
        let l = l.trim_end();
        ["(y/n)", "(Y/n)", "(y/N)", "[y/N]", "[Y/n]"]
            .iter()
            .any(|m| l.ends_with(m) || l.ends_with(&format!("{m}:")))
    });
    menu || asked || yes_no
}
