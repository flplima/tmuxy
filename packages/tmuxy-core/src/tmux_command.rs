//! The tmux command-list grammar: how tmux splits what a client sends into
//! commands and words, and the commands tmuxy has a policy for.
//!
//! Every reader of a command list asks this one: readers that tokenize for
//! themselves disagree, and a `movew` inside an `if-shell { }`, or
//! `set-o @tmuxy-…`, becomes a command one reader sees and the next does not.

use std::borrow::Cow;
use std::ops::Range;

use crate::tmux_quote;

/// A new tab: a split broken out into a window of its own. `new-window`
/// crashes tmux 3.5a with a control-mode client attached, so every new tab —
/// the router's `new-window` rewrite, `tmuxy tab create`, the MCP's
/// `tab_create` — is this command list.
#[derive(Debug, Clone, Default)]
pub struct NewTab<'a> {
    /// The pane, window or session the split is made from; tmux's current
    /// one otherwise.
    pub from: Option<&'a str>,
    /// The session the window is broken into (`breakp -t <session>:`). An
    /// unattached client (`run-shell`'s) otherwise breaks it into the session
    /// tmux touched last.
    pub into: Option<&'a str>,
    pub name: Option<&'a str>,
    /// The new pane's directory (`splitw -c`, a format).
    pub cwd: Option<&'a str>,
    /// The new pane's command, one shell line; the default shell otherwise.
    pub program: Option<&'a str>,
    /// Leave focus where it was: `breakp -d`, and `from` gets its focused
    /// pane back, which the split took.
    pub background: bool,
    /// `breakp -P`: print the new window's id.
    pub print_id: bool,
    /// The viewport the window is sized to. `resizew` targets the current
    /// window, which is the new one after `breakp`, so the window matches the
    /// viewport at creation rather than inheriting the half-width post-split
    /// size or the control-mode PTY default.
    pub size: Option<(u32, u32)>,
}

/// A word of a [`NewTab`] command: tmux's own (a verb, a flag, a number), or a
/// value, which is quoted.
enum Word {
    Own(String),
    Value(String),
}

impl NewTab<'_> {
    fn commands(&self) -> Vec<Vec<Word>> {
        let own = |w: &str| Word::Own(w.to_string());
        let value = |w: &str| Word::Value(w.to_string());
        let mut split = vec![own("splitw")];
        if let Some(from) = self.from {
            split.extend([own("-t"), value(from)]);
        }
        if let Some(cwd) = self.cwd {
            split.extend([own("-c"), value(cwd)]);
        }
        if let Some(program) = self.program {
            split.push(value(program));
        }
        let mut breakp = vec![own("breakp")];
        if self.background {
            breakp.push(own("-d"));
        }
        if let Some(into) = self.into {
            breakp.extend([own("-t"), value(&format!("{into}:"))]);
        }
        if let Some(name) = self.name {
            breakp.extend([own("-n"), value(name)]);
        }
        if self.print_id {
            breakp.extend([own("-P"), own("-F"), value("#{window_id}")]);
        }
        let mut commands = vec![split, breakp];
        if let Some((cols, rows)) = self.size {
            commands.push(vec![
                own("resizew"),
                own("-x"),
                own(&cols.to_string()),
                own("-y"),
                own(&rows.to_string()),
            ]);
        }
        if let (true, Some(from)) = (self.background, self.from) {
            commands.push(vec![own("select-pane"), own("-t"), value(from)]);
        }
        commands
    }

    /// The list as one line tmux's command parser reads (control mode).
    pub fn command_line(&self) -> String {
        self.commands()
            .iter()
            .map(|command| {
                command
                    .iter()
                    .map(|word| match word {
                        Word::Own(w) => w.clone(),
                        Word::Value(w) => tmux_quote(w),
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect::<Vec<_>>()
            .join(" ; ")
    }

    /// The list as a tmux client's argv, `;` a word of its own.
    pub fn argv(&self) -> Vec<String> {
        self.commands()
            .into_iter()
            .map(|command| {
                command
                    .into_iter()
                    .map(|word| match word {
                        Word::Own(w) | Word::Value(w) => w,
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
            .join(&";".to_string())
    }
}

/// A tmux command tmuxy has a policy for, with every verb tmux runs it by:
/// its name, its alias, and any prefix of the name no other command shares
/// — tmux runs `resize-w` as `resize-window`.
pub struct TmuxCommand {
    pub name: &'static str,
    pub alias: &'static str,
    /// The shortest prefix of `name` that names no other tmux command.
    pub unique_prefix: &'static str,
}

impl TmuxCommand {
    pub fn named_by(&self, verb: &str) -> bool {
        verb == self.alias || (verb.starts_with(self.unique_prefix) && self.name.starts_with(verb))
    }
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
pub const SEND_KEYS: TmuxCommand = TmuxCommand {
    name: "send-keys",
    alias: "send",
    unique_prefix: "send-k",
};
pub const RUN_SHELL: TmuxCommand = TmuxCommand {
    name: "run-shell",
    alias: "run",
    unique_prefix: "ru",
};
pub const SET_OPTION: TmuxCommand = TmuxCommand {
    name: "set-option",
    alias: "set",
    unique_prefix: "set-o",
};
pub const SET_WINDOW_OPTION: TmuxCommand = TmuxCommand {
    name: "set-window-option",
    alias: "setw",
    unique_prefix: "set-w",
};
pub const MOVE_WINDOW: TmuxCommand = TmuxCommand {
    name: "move-window",
    alias: "movew",
    unique_prefix: "move-w",
};
pub const SWAP_WINDOW: TmuxCommand = TmuxCommand {
    name: "swap-window",
    alias: "swapw",
    unique_prefix: "swap-w",
};
pub const SWAP_PANE: TmuxCommand = TmuxCommand {
    name: "swap-pane",
    alias: "swapp",
    unique_prefix: "swap-p",
};
pub const SELECT_PANE: TmuxCommand = TmuxCommand {
    name: "select-pane",
    alias: "selectp",
    unique_prefix: "select-p",
};

/// One command of a list: the bytes it spans (its blocks included), how many
/// `{ … }` blocks it sits in, and its words as written — a block is one word
/// of the command it belongs to.
#[derive(Debug, Clone)]
pub struct Command<'a> {
    pub text: &'a str,
    pub depth: usize,
    words: Vec<&'a str>,
}

impl<'a> Command<'a> {
    pub fn verb(&self) -> &'a str {
        self.words.first().copied().unwrap_or("")
    }

    /// The words after the verb, exactly as written.
    pub fn args(&self) -> &[&'a str] {
        self.words.get(1..).unwrap_or(&[])
    }

    pub fn words(&self) -> &[&'a str] {
        &self.words
    }

    pub fn runs(&self, command: &TmuxCommand) -> bool {
        command.named_by(self.verb())
    }
}

/// A command list read the way tmux's parser reads it.
///
/// The separators are the ones tmux acts on outside quotes — a bare `;`, the
/// frontend's `\;` and a newline, which ends the control-mode line whatever
/// is open — read the way tmux's parser reads quotes: nothing escapes inside
/// single quotes, and a backslash escapes the next character anywhere else.
///
/// An unquoted `{` that starts a word opens a block, a command list of its
/// own, which the matching `}` closes. A `{` glued to a word (`#{pane_id}`)
/// is text to tmux, and so is the `}` that matches it.
///
/// Where tmux's reading is in doubt (a `;` glued to a word or inside a glued
/// brace) this splits: a policy that sees a command too many refuses a
/// command too many, never runs one it did not see.
#[derive(Debug, Clone)]
pub struct CommandList<'a> {
    source: &'a str,
    /// Every command, at every depth, in the order they start.
    commands: Vec<Command<'a>>,
    /// Where each `\;` separator starts.
    escaped_separators: Vec<usize>,
    /// A `;` was glued to the word before it.
    pub glued_separator: bool,
    /// A quote was still open at the end of the list.
    pub unterminated_quote: bool,
}

impl<'a> CommandList<'a> {
    /// Every command of the list, the ones inside `{ … }` blocks included at
    /// any depth: what a policy has to look at.
    pub fn every(&self) -> impl Iterator<Item = &Command<'a>> {
        self.commands.iter()
    }

    pub fn top_level(&self) -> impl Iterator<Item = &Command<'a>> {
        self.commands.iter().filter(|c| c.depth == 0)
    }

    /// Any command, inside a block or not. The keyboard actor prepends
    /// `select-window -t @N \; select-pane -t %N \;` to every bound command,
    /// so a binding arrives as a list whose FIRST command is the pin: a guard
    /// written as `starts_with("<verb>")` never fires once a binding is
    /// pinned. And `if-shell -F 1 { resizew }` runs a `resizew` too.
    pub fn runs(&self, command: &TmuxCommand) -> bool {
        self.every().any(|c| c.runs(command))
    }

    pub fn has_blocks(&self) -> bool {
        self.commands.iter().any(|c| c.depth > 0)
    }

    /// The list with every `\;` separator written as the bare `;` control
    /// mode reads — the frontend joins a pinned binding with `\;`, which is
    /// a separator in a shell or a binding but a literal argument on a
    /// control-mode line. Every other byte is as it came.
    pub fn with_plain_separators(&self) -> Cow<'a, str> {
        if self.escaped_separators.is_empty() {
            return Cow::Borrowed(self.source);
        }
        let mut out = String::with_capacity(self.source.len());
        let mut copied = 0;
        for &at in &self.escaped_separators {
            out.push_str(&self.source[copied..at]);
            out.push(';');
            copied = at + 2;
        }
        out.push_str(&self.source[copied..]);
        Cow::Owned(out)
    }

    /// Rewrite every `new-window` in the list, leaving the commands around
    /// it — the keyboard actor's window/pane pin — in place.
    ///
    /// Keeping the pin matters beyond the crash. `splitw -t <session>`
    /// targets the session's *current* window, so the pin ahead of it is
    /// what makes the new tab come from the window the user is actually
    /// looking at rather than whichever one tmux last considered current.
    ///
    /// A `new-window` inside a `{ … }` block (a conditional binding, a menu
    /// item) crashes tmux just the same when it runs, so it is rewritten in
    /// place and the block keeps its shape: the binding still opens a window.
    ///
    /// `None` when the list runs no `new-window`.
    pub fn rewrite_new_window(&self, session: &str, size: Option<(u32, u32)>) -> Option<String> {
        if !self.runs(&NEW_WINDOW) {
            return None;
        }
        let rewrite = NewTab {
            from: Some(session),
            size,
            ..NewTab::default()
        }
        .command_line();
        let span = |c: &Command| {
            let start = c.text.as_ptr() as usize - self.source.as_ptr() as usize;
            start..start + c.text.len()
        };
        let parts: Vec<String> = self
            .top_level()
            .map(|top| {
                if top.runs(&NEW_WINDOW) {
                    return rewrite.clone();
                }
                let top_span = span(top);
                let mut out = String::new();
                let mut copied = top_span.start;
                for inner in self.every().filter(|c| c.depth > 0) {
                    let inner_span = span(inner);
                    // Sorted by start: a command inside one already rewritten
                    // starts before `copied`, and goes with it.
                    let inside = inner_span.start >= copied && inner_span.end <= top_span.end;
                    if inside && inner.runs(&NEW_WINDOW) {
                        out.push_str(&self.source[copied..inner_span.start]);
                        out.push_str(&format!(" {rewrite} "));
                        copied = inner_span.end;
                    }
                }
                out.push_str(&self.source[copied..top_span.end]);
                out.trim().to_string()
            })
            .collect();
        Some(parts.join(" ; "))
    }
}

pub fn parse(list: &str) -> CommandList<'_> {
    #[derive(PartialEq)]
    enum Quote {
        None,
        Single,
        Double,
    }
    /// A block being read (the list itself is the outermost): where its
    /// current command starts, its words so far, where the word being read
    /// starts, and how many glued braces are open in it.
    struct Block {
        start: usize,
        words: Vec<Range<usize>>,
        word: Option<usize>,
        glued: usize,
    }
    impl Block {
        fn at(start: usize) -> Self {
            Block {
                start,
                words: Vec::new(),
                word: None,
                glued: 0,
            }
        }
        fn end_word(&mut self, end: usize) {
            if let Some(start) = self.word.take() {
                self.words.push(start..end);
            }
        }
        fn begin_word(&mut self, at: usize) {
            self.word.get_or_insert(at);
        }
    }
    fn end_command<'a>(
        source: &'a str,
        blocks: &mut [Block],
        found: &mut Vec<Command<'a>>,
        end: usize,
    ) {
        let depth = blocks.len().saturating_sub(1);
        if let Some(block) = blocks.last_mut() {
            block.end_word(end);
            let words: Vec<&str> = block.words.drain(..).map(|w| &source[w]).collect();
            if !words.is_empty() {
                found.push(Command {
                    text: &source[block.start..end],
                    depth,
                    words,
                });
            }
        }
    }

    let mut found = Vec::new();
    let mut escaped_separators = Vec::new();
    let mut glued_separator = false;
    let mut blocks = vec![Block::at(0)];
    let mut quote = Quote::None;
    let mut chars = list.char_indices().peekable();

    while let Some((i, c)) = chars.next() {
        let top = blocks.len() - 1;
        match (&quote, c) {
            (_, '\n') => {
                quote = Quote::None;
                while !blocks.is_empty() {
                    end_command(list, &mut blocks, &mut found, i);
                    blocks.pop();
                }
                blocks.push(Block::at(i + 1));
            }
            (Quote::None, ';') => {
                glued_separator |= blocks[top].word.is_some();
                end_command(list, &mut blocks, &mut found, i);
                blocks[top].start = i + 1;
            }
            (Quote::None, '\\') if chars.peek().map(|&(_, next)| next) == Some(';') => {
                chars.next();
                end_command(list, &mut blocks, &mut found, i);
                escaped_separators.push(i);
                blocks[top].start = i + 2;
            }
            (Quote::None | Quote::Double, '\\') => {
                blocks[top].begin_word(i);
                if chars.peek().is_some_and(|&(_, next)| next != '\n') {
                    chars.next();
                }
            }
            (Quote::None, '{') if blocks[top].word.is_none() => {
                blocks[top].begin_word(i);
                blocks.push(Block::at(i + 1));
            }
            (Quote::None, '{') => blocks[top].glued += 1,
            (Quote::None, '}') if blocks[top].glued > 0 => blocks[top].glued -= 1,
            (Quote::None, '}') if top > 0 => {
                end_command(list, &mut blocks, &mut found, i);
                blocks.pop();
                if let Some(parent) = blocks.last_mut() {
                    parent.end_word(i + 1);
                }
            }
            (Quote::None, '\'') => {
                blocks[top].begin_word(i);
                quote = Quote::Single;
            }
            (Quote::None, '"') => {
                blocks[top].begin_word(i);
                quote = Quote::Double;
            }
            (Quote::Single, '\'') | (Quote::Double, '"') => quote = Quote::None,
            (Quote::None, ' ' | '\t' | '\r') => blocks[top].end_word(i),
            (Quote::None, _) => blocks[top].begin_word(i),
            _ => {}
        }
    }
    let unterminated_quote = quote != Quote::None;
    while !blocks.is_empty() {
        end_command(list, &mut blocks, &mut found, list.len());
        blocks.pop();
    }
    found.sort_by_key(|c| c.text.as_ptr() as usize);
    CommandList {
        source: list,
        commands: found,
        escaped_separators,
        glued_separator,
        unterminated_quote,
    }
}

/// The text one tmux word stands for: its single-quoted, double-quoted and
/// backslash-escaped pieces joined, as tmux's parser joins them. `None` for
/// a word whose text tmux works out at run time (a `$VARIABLE`, a leading
/// `~`, a `{ … }` block) or that never closes its quote.
pub fn unquote(word: &str) -> Option<String> {
    if word.starts_with('~') || word.starts_with('{') {
        return None;
    }
    let mut out = String::with_capacity(word.len());
    let mut chars = word.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => loop {
                match chars.next()? {
                    '\'' => break,
                    c => out.push(c),
                }
            },
            '"' => loop {
                match chars.next()? {
                    '"' => break,
                    '\\' => out.push(escaped(&mut chars)?),
                    '$' => return None,
                    c => out.push(c),
                }
            },
            '\\' => out.push(escaped(&mut chars)?),
            '$' => return None,
            c => out.push(c),
        }
    }
    Some(out)
}

/// The character a backslash escape stands for. Octal escapes (`\101`) are
/// one byte each, which only an ASCII one makes a character of on its own.
fn escaped(chars: &mut std::iter::Peekable<std::str::Chars>) -> Option<char> {
    let c = chars.next()?;
    if !c.is_digit(8) {
        return Some(match c {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            c => c,
        });
    }
    let mut value = c.to_digit(8)?;
    for _ in 0..2 {
        value = value * 8 + chars.next()?.to_digit(8)?;
    }
    char::from_u32(value).filter(char::is_ascii)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
