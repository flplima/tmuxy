pub use crate::tmux_quote;

/// Build the `new-window` rewrite: `new-window`/`neww` crashes tmux 3.5a with
/// control mode attached, so both transports send `splitw ; breakp` instead.
///
/// `resizew` targets the current window, which is the new one after `breakp`,
/// so the new window matches the viewport at creation rather than inheriting
/// the half-width post-split size or the control-mode PTY default.
///
/// Shared by the SSE server and the Tauri app so the rewrite shape can't drift
/// between transports. Tabs carry no marker (an untagged window is a tab), so
/// there is nothing to tag.
pub fn new_window_rewrite(session: &str, size: Option<(u32, u32)>) -> String {
    let session = tmux_quote(session);
    match size {
        Some((cols, rows)) => {
            format!("splitw -t {session} ; breakp ; resizew -x {cols} -y {rows}")
        }
        None => format!("splitw -t {session} ; breakp"),
    }
}

/// The verb of a single tmux command — its first whitespace-delimited token.
pub(crate) fn command_verb(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or("")
}

/// A tmux command the router has a policy for, with every verb tmux runs it
/// by: its name, its alias, and any prefix of the name no other command
/// shares — tmux runs `resize-w` as `resize-window`.
pub struct TmuxCommand {
    pub name: &'static str,
    pub alias: &'static str,
    /// The shortest prefix of `name` that names no other tmux command.
    pub unique_prefix: &'static str,
}

pub const RESIZE_WINDOW: TmuxCommand = TmuxCommand {
    name: "resize-window",
    alias: "resizew",
    unique_prefix: "resize-w",
};

pub const NEW_WINDOW: TmuxCommand = TmuxCommand {
    name: "new-window",
    alias: "neww",
    unique_prefix: "new-w",
};

impl TmuxCommand {
    /// Whether tmux runs this command for `verb`.
    pub fn named_by(&self, verb: &str) -> bool {
        verb == self.alias || (verb.starts_with(self.unique_prefix) && self.name.starts_with(verb))
    }
}

/// Does any command in a (possibly compound) command list run `command`?
///
/// The keyboard actor prepends `select-window -t @N \; select-pane -t %N \;`
/// to every bound command, so a binding arrives as a compound whose FIRST
/// command is the pin. Any interception written as
/// `command.starts_with("<verb>")` silently stops matching the moment a
/// binding is pinned — the guard is still there, it just never fires again.
/// Ask about the whole list instead, the commands inside its `{ … }` blocks
/// included: `if-shell -F 1 { resizew }` runs a `resizew` too.
pub fn compound_runs(list: &str, command: &TmuxCommand) -> bool {
    every_command(list).any(|part| command.named_by(command_verb(part)))
}

/// Rewrite every `new-window` in a (possibly pinned) command list, leaving the
/// commands around it — the keyboard actor's window/pane pin — in place.
///
/// Without this, `prefix c` (`select-window … \; select-pane … \; new-window`)
/// misses the `starts_with("new-window")` intercept and the raw `new-window`
/// runs as an external subprocess against an attached control-mode client:
/// the exact crash the rewrite exists to prevent (see docs/TMUX.md).
///
/// Keeping the pin matters beyond the crash. `splitw -t <session>` targets the
/// session's *current* window, so the pin ahead of it is what makes the new tab
/// come from the window the user is actually looking at rather than whichever
/// one tmux last considered current.
///
/// A `new-window` inside a `{ … }` block (a conditional binding, a menu item)
/// crashes tmux just the same when it runs, so it is rewritten in place and
/// the block keeps its shape: the binding still opens a window.
///
/// Returns `None` when the list contains no `new-window`.
pub fn rewrite_new_window_in_compound(
    command: &str,
    session: &str,
    size: Option<(u32, u32)>,
) -> Option<String> {
    let commands = scan_commands(command);
    let is_new_window =
        |found: &Scanned| NEW_WINDOW.named_by(command_verb(&command[found.span.clone()]));
    if !commands.iter().any(is_new_window) {
        return None;
    }
    let rewrite = new_window_rewrite(session, size);
    let parts: Vec<String> = commands
        .iter()
        .filter(|found| found.depth == 0)
        .filter_map(|top| {
            if command[top.span.clone()].trim().is_empty() {
                return None;
            }
            if is_new_window(top) {
                return Some(rewrite.clone());
            }
            let mut out = String::new();
            let mut copied = top.span.start;
            for inner in &commands {
                // Sorted by start: a command inside one already rewritten
                // starts before `copied`, and goes with it.
                let inside =
                    inner.depth > 0 && inner.span.start >= copied && inner.span.end <= top.span.end;
                if inside && is_new_window(inner) {
                    out.push_str(&command[copied..inner.span.start]);
                    out.push_str(&format!(" {rewrite} "));
                    copied = inner.span.end;
                }
            }
            out.push_str(&command[copied..top.span.end]);
            Some(out.trim().to_string())
        })
        .collect();

    // Bare `;` on purpose: control mode's line parser rejects the shell-escaped
    // `\;` the frontend joins with, and the monitor's unescape only rewrites
    // the form it already knows.
    Some(parts.join(" ; "))
}

/// Rewrite long-form mutating verbs (`split-window`, `kill-pane`, `kill-window`, `break-pane`)
/// to their safe short forms (`splitw`, `killp`, `killw`, `breakp`).
///
/// This protects control mode from triggering server-level `command-alias` safety traps
/// configured to block external mutating commands on the tmuxy socket.
pub fn rewrite_mutating_verbs(command: &str) -> String {
    const LONG_FORMS: [&str; 4] = ["split-window", "kill-pane", "kill-window", "break-pane"];
    if !split_compound(command)
        .iter()
        .any(|part| LONG_FORMS.contains(&command_verb(part)))
    {
        return command.to_string();
    }
    let parts: Vec<String> = split_compound(command)
        .iter()
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }
            let verb = command_verb(trimmed);
            let short = match verb {
                "split-window" => Some("splitw"),
                "kill-pane" => Some("killp"),
                "kill-window" => Some("killw"),
                "break-pane" => Some("breakp"),
                _ => None,
            };
            if let Some(short_verb) = short {
                let rest = trimmed[verb.len()..].trim_start();
                if rest.is_empty() {
                    Some(short_verb.to_string())
                } else {
                    Some(format!("{short_verb} {rest}"))
                }
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect();

    parts.join(" ; ")
}

/// Split a command list into its top-level commands, where tmux would. A
/// `{ … }` block stays whole inside the command it belongs to, so a rewrite
/// that rejoins the commands with ` ; ` leaves every block as it came.
pub(crate) fn split_compound(cmd: &str) -> Vec<&str> {
    scan_commands(cmd)
        .into_iter()
        .filter(|found| found.depth == 0)
        .map(|found| &cmd[found.span])
        .collect()
}

/// Every command of a list, the ones inside `{ … }` blocks included at any
/// depth: what a policy has to look at.
pub(crate) fn every_command(cmd: &str) -> impl Iterator<Item = &str> {
    scan_commands(cmd)
        .into_iter()
        .map(move |found| &cmd[found.span])
}

/// One command of a list as [`scan_commands`] reads it: the bytes of the list
/// it spans (its blocks included), and how many `{ … }` blocks it sits in.
struct Scanned {
    span: std::ops::Range<usize>,
    depth: usize,
}

/// Read a command list into its commands, the way tmux's parser does.
///
/// The separators are the ones tmux acts on outside quotes — a bare `;`, the
/// frontend's `\;` (the monitor turns it into `;`) and a newline, which ends
/// the control-mode line whatever is open — read the way tmux's parser reads
/// quotes: nothing escapes inside single quotes, and a backslash escapes the
/// next character anywhere else. Splitting only on `\;`, and toggling on
/// every quote, let a policy miss a command tmux then ran:
/// `display x ; resizew` and `display "\"" \; resizew` both hid the
/// `resizew` from the router. A plain `cmd.split("\\;")` also splits inside
/// quoted payloads, so `send-keys -l 'a\;b'` was torn into two bogus
/// commands.
///
/// An unquoted `{` that starts a word opens a block, a command list of its
/// own, which the matching `}` closes. A `{` glued to a word (`#{pane_id}`)
/// is text to tmux, and so is the `}` that matches it.
///
/// Where tmux's reading is in doubt (a `;` glued to a word or inside a glued
/// brace) this splits: a policy that sees a command too many refuses a
/// command too many, never runs one it did not see.
fn scan_commands(cmd: &str) -> Vec<Scanned> {
    #[derive(PartialEq)]
    enum Quote {
        None,
        Single,
        Double,
    }
    /// A block being read (the list itself is the outermost): where its
    /// current command starts, and how many glued braces are open in it.
    struct Block {
        start: usize,
        glued: usize,
    }
    fn end_command(blocks: &[Block], found: &mut Vec<Scanned>, end: usize) {
        if let Some(block) = blocks.last() {
            found.push(Scanned {
                span: block.start..end,
                depth: blocks.len() - 1,
            });
        }
    }

    let mut found = Vec::new();
    let mut blocks = vec![Block { start: 0, glued: 0 }];
    let mut quote = Quote::None;
    let mut word_start = true;
    let mut chars = cmd.char_indices().peekable();

    while let Some((i, c)) = chars.next() {
        let mut next_starts_word = false;
        match (&quote, c) {
            (_, '\n') => {
                quote = Quote::None;
                while !blocks.is_empty() {
                    end_command(&blocks, &mut found, i);
                    blocks.pop();
                }
                blocks.push(Block {
                    start: i + 1,
                    glued: 0,
                });
                next_starts_word = true;
            }
            (Quote::None, ';') => {
                end_command(&blocks, &mut found, i);
                if let Some(block) = blocks.last_mut() {
                    block.start = i + 1;
                }
                next_starts_word = true;
            }
            (Quote::None, '\\') if chars.peek().map(|&(_, next)| next) == Some(';') => {
                chars.next();
                end_command(&blocks, &mut found, i);
                if let Some(block) = blocks.last_mut() {
                    block.start = i + 2;
                }
                next_starts_word = true;
            }
            (Quote::None | Quote::Double, '\\') => {
                if chars.peek().is_some_and(|&(_, next)| next != '\n') {
                    chars.next();
                }
            }
            (Quote::None, '{') if word_start => {
                blocks.push(Block {
                    start: i + 1,
                    glued: 0,
                });
                next_starts_word = true;
            }
            (Quote::None, '{') => {
                if let Some(block) = blocks.last_mut() {
                    block.glued += 1;
                }
            }
            (Quote::None, '}') => {
                if let Some(block) = blocks.last_mut().filter(|block| block.glued > 0) {
                    block.glued -= 1;
                } else if blocks.len() > 1 {
                    end_command(&blocks, &mut found, i);
                    blocks.pop();
                    next_starts_word = true;
                }
            }
            (Quote::None, '\'') => quote = Quote::Single,
            (Quote::None, '"') => quote = Quote::Double,
            (Quote::Single, '\'') | (Quote::Double, '"') => quote = Quote::None,
            (Quote::None, ' ' | '\t') => next_starts_word = true,
            _ => {}
        }
        word_start = next_starts_word;
    }
    while !blocks.is_empty() {
        end_command(&blocks, &mut found, cmd.len());
        blocks.pop();
    }
    found.sort_by_key(|found| found.span.start);
    found
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
