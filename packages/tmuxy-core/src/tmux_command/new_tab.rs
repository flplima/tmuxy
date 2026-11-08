//! A new tab, and the one a client's `new-window` becomes.

use super::{unquote, Command};
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

/// The tab a client's `new-window` becomes, keeping what the command named:
/// its name (`-n`), directory (`-c`), `-d`, and the shell command after the
/// flags — a binding's `new-window -c "#{pane_current_path}"` opens the tab
/// where the user is. The flags a tab has no place for (a window index, an
/// environment variable, a print format) go, with their values. A word tmux
/// works out at run time (`unquote` reads none) is left out, the command
/// whole rather than with a word missing.
pub(super) fn new_tab_in_place_of(
    command: &Command,
    session: &str,
    size: Option<(u32, u32)>,
) -> String {
    let mut name = None;
    let mut cwd = None;
    let mut background = false;
    let mut args = command.args().iter().copied().peekable();
    while let Some(flag) = args.next_if(|word| word.starts_with('-') && word.len() > 1) {
        if flag == "--" {
            break;
        }
        // tmux's getopt: a cluster's last letter may take the next word.
        let letters = &flag[1..];
        if letters.contains('d') {
            background = true;
        }
        match letters.chars().last() {
            Some('n') => name = args.next().and_then(unquote),
            Some('c') => cwd = args.next().and_then(unquote),
            Some('t' | 'e' | 'F') => {
                args.next();
            }
            _ => {}
        }
    }
    let program = args
        .map(unquote)
        .collect::<Option<Vec<String>>>()
        .filter(|words| !words.is_empty())
        .map(|words| words.join(" "));
    NewTab {
        from: Some(session),
        name: name.as_deref(),
        cwd: cwd.as_deref(),
        program: program.as_deref(),
        background,
        size,
        ..NewTab::default()
    }
    .command_line()
}
