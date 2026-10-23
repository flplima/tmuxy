//! The terminal a CheerpX guest pane runs on. CheerpX gives every process the
//! same pseudo-terminal, so the guest's tmux runs each pane on a socket pair
//! and execs the pane's program under `tmuxy-pty`, which does the part of a
//! pty the program relies on: the line discipline here (echo, line editing,
//! history, Ctrl+C, Ctrl+D) and output newline translation.

use unicode_width::UnicodeWidthChar;

/// What the pane's keystrokes ask for, in the order they asked.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Bytes to show in the pane.
    Echo(Vec<u8>),
    /// Input for the program: a finished line, or what Ctrl+D flushed.
    Send(Vec<u8>),
    /// Ctrl+C: SIGINT to every process in the pane.
    Interrupt,
    /// Ctrl+\: SIGQUIT to every process in the pane.
    Quit,
    /// Ctrl+D on an empty line: the end of the program's input.
    EndOfInput,
    /// Ctrl+L: clear the screen, as readline does at a shell prompt.
    ClearScreen,
    /// Tab: complete the word before the cursor (see `completion_word`).
    Complete,
}

const HISTORY_LIMIT: usize = 500;

#[derive(Default, PartialEq, Eq)]
enum Escape {
    #[default]
    None,
    Esc,
    /// `ESC [`, up to its final byte.
    Csi,
    /// `ESC O`, the arrows in application cursor mode.
    Ss3,
}

/// A canonical-mode line discipline with echo, and the line editing readline
/// would give a shell (the cursor keys, history): input is held and edited
/// until Enter, as a pty does it for a program that has not asked for raw
/// mode. A line that wraps past the pane's edge is edited on its last row only.
#[derive(Default)]
pub struct LineDiscipline {
    line: Vec<u8>,
    /// Where in `line` the cursor is: a byte offset, on a character boundary.
    cursor: usize,
    /// The bytes typed so far of a UTF-8 character, until it is whole.
    partial: Vec<u8>,
    history: Vec<Vec<u8>>,
    /// The history entry the arrows are on; `history.len()` is the line
    /// being typed, kept in `draft` while browsing.
    browse: usize,
    draft: Vec<u8>,
    escape: Escape,
    /// The parameter bytes of the `ESC [` sequence being read.
    params: Vec<u8>,
}

impl LineDiscipline {
    pub fn new() -> Self {
        Self::default()
    }

    /// What has been typed of the line so far, not yet sent.
    pub fn line(&self) -> &[u8] {
        &self.line
    }

    /// The word Tab completes, the one ending at the cursor, and whether it
    /// is the line's first (a command, rather than a file).
    pub fn completion_word(&self) -> (String, bool) {
        let before = &self.line[..self.cursor];
        let start = before
            .iter()
            .rposition(|&b| b == b' ')
            .map_or(0, |at| at + 1);
        let first = before[..start].iter().all(|&b| b == b' ');
        (
            String::from_utf8_lossy(&before[start..]).into_owned(),
            first,
        )
    }

    /// Type `text` at the cursor, as if keyed in: a completion, or a Tab
    /// that was not one.
    pub fn type_text(&mut self, text: &[u8]) -> Vec<Action> {
        let mut actions = Vec::new();
        self.insert(text, &mut actions);
        actions
    }

    /// The line was drawn again whole (a cleared screen, a completion list):
    /// the cursor is at its end.
    pub fn redrawn(&mut self) {
        self.cursor = self.line.len();
    }

    /// Feed bytes typed into the pane.
    pub fn input(&mut self, bytes: &[u8]) -> Vec<Action> {
        let mut actions = Vec::new();
        for &byte in bytes {
            self.byte(byte, &mut actions);
        }
        actions
    }

    fn byte(&mut self, byte: u8, actions: &mut Vec<Action>) {
        match self.escape {
            Escape::Esc => {
                self.params.clear();
                self.escape = match byte {
                    b'[' => Escape::Csi,
                    b'O' => Escape::Ss3,
                    _ => Escape::None,
                };
                return;
            }
            Escape::Csi | Escape::Ss3 => {
                if (0x40..=0x7e).contains(&byte) {
                    self.escape = Escape::None;
                    let params = std::mem::take(&mut self.params);
                    self.key(byte, &params, actions);
                } else {
                    self.params.push(byte);
                }
                return;
            }
            Escape::None => {}
        }
        if byte >= 0x80 {
            self.partial.push(byte);
            match std::str::from_utf8(&self.partial) {
                Ok(_) => {
                    let text = std::mem::take(&mut self.partial);
                    self.insert(&text, actions);
                }
                // Not a character, and no byte more would make it one.
                Err(e) if e.error_len().is_some() => self.partial.clear(),
                Err(_) => {}
            }
            return;
        }
        match byte {
            b'\r' | b'\n' => {
                echo(actions, b"\r\n");
                let mut line = std::mem::take(&mut self.line);
                self.cursor = 0;
                self.remember(&line);
                line.push(b'\n');
                actions.push(Action::Send(line));
            }
            0x7f | 0x08 => self.erase_char(actions),
            0x15 => self.erase_line(actions),
            0x17 => {
                while self.cursor > 0 && self.line[self.cursor - 1] == b' ' {
                    self.erase_char(actions);
                }
                while self.cursor > 0 && self.line[self.cursor - 1] != b' ' {
                    self.erase_char(actions);
                }
            }
            // Echoed as a terminal does it, with no newline: the shell starts a new
            // line itself once its command is gone.
            0x03 => self.abandon(b"^C", Action::Interrupt, actions),
            0x1c => self.abandon(b"^\\", Action::Quit, actions),
            0x04 => {
                if self.line.is_empty() {
                    actions.push(Action::EndOfInput);
                } else {
                    self.cursor = 0;
                    actions.push(Action::Send(std::mem::take(&mut self.line)));
                }
            }
            // The screen is drawn again with the line, the cursor at its end.
            0x0c => {
                self.cursor = self.line.len();
                actions.push(Action::ClearScreen);
            }
            0x01 => self.home(actions),
            0x05 => self.end(actions),
            0x02 => self.left(actions),
            0x06 => self.right(actions),
            0x1b => self.escape = Escape::Esc,
            b'\t' => actions.push(Action::Complete),
            0x00..=0x1f => {}
            _ => self.insert(&[byte], actions),
        }
    }

    /// A cursor key, `ESC [` (or `ESC O`) `params` `final_byte`.
    fn key(&mut self, final_byte: u8, params: &[u8], actions: &mut Vec<Action>) {
        // A modified key (`1;5C` is Ctrl+Right) is not one of these.
        if params.contains(&b';') {
            return;
        }
        match (final_byte, params) {
            (b'A', _) => self.recall(-1, actions),
            (b'B', _) => self.recall(1, actions),
            (b'C', _) => self.right(actions),
            (b'D', _) => self.left(actions),
            (b'H', _) | (b'~', b"1") | (b'~', b"7") => self.home(actions),
            (b'F', _) | (b'~', b"4") | (b'~', b"8") => self.end(actions),
            (b'~', b"3") => self.delete(actions),
            _ => {}
        }
    }

    /// Where the character before the cursor starts.
    fn previous(&self) -> Option<usize> {
        let mut at = self.cursor.checked_sub(1)?;
        while at > 0 && self.line[at] & 0xc0 == 0x80 {
            at -= 1;
        }
        Some(at)
    }

    /// Where the character after the cursor ends.
    fn next(&self) -> Option<usize> {
        if self.cursor >= self.line.len() {
            return None;
        }
        let mut at = self.cursor + 1;
        while at < self.line.len() && self.line[at] & 0xc0 == 0x80 {
            at += 1;
        }
        Some(at)
    }

    /// Put `text` (whole characters) in at the cursor.
    fn insert(&mut self, text: &[u8], actions: &mut Vec<Action>) {
        self.line
            .splice(self.cursor..self.cursor, text.iter().copied());
        self.cursor += text.len();
        echo(actions, text);
        self.redraw_tail(0, actions);
    }

    /// Show the line from the cursor on, and `cleared` columns blanked after
    /// it (what a removal left), then come back to the cursor.
    fn redraw_tail(&self, cleared: usize, actions: &mut Vec<Action>) {
        let tail = &self.line[self.cursor..];
        if tail.is_empty() && cleared == 0 {
            return;
        }
        echo(actions, tail);
        echo(actions, &b" ".repeat(cleared));
        back(actions, columns(tail) + cleared);
    }

    fn left(&mut self, actions: &mut Vec<Action>) {
        if let Some(at) = self.previous() {
            back(actions, columns(&self.line[at..self.cursor]));
            self.cursor = at;
        }
    }

    fn right(&mut self, actions: &mut Vec<Action>) {
        if let Some(at) = self.next() {
            echo(actions, &self.line[self.cursor..at]);
            self.cursor = at;
        }
    }

    fn home(&mut self, actions: &mut Vec<Action>) {
        back(actions, columns(&self.line[..self.cursor]));
        self.cursor = 0;
    }

    fn end(&mut self, actions: &mut Vec<Action>) {
        echo(actions, &self.line[self.cursor..]);
        self.cursor = self.line.len();
    }

    /// Backspace: drop the character before the cursor (all of a UTF-8
    /// sequence), going back as many columns as it took — two for a CJK
    /// character or an emoji. Nothing at the start of the line.
    fn erase_char(&mut self, actions: &mut Vec<Action>) {
        let Some(at) = self.previous() else {
            return;
        };
        let width = columns(&self.line[at..self.cursor]);
        self.line.drain(at..self.cursor);
        self.cursor = at;
        back(actions, width);
        self.redraw_tail(width, actions);
    }

    /// Delete: drop the character under the cursor.
    fn delete(&mut self, actions: &mut Vec<Action>) {
        if let Some(at) = self.next() {
            let width = columns(&self.line[self.cursor..at]);
            self.line.drain(self.cursor..at);
            self.redraw_tail(width, actions);
        }
    }

    /// Ctrl+U: the whole line, wherever the cursor is.
    fn erase_line(&mut self, actions: &mut Vec<Action>) {
        let width = columns(&self.line);
        back(actions, columns(&self.line[..self.cursor]));
        echo(actions, &b" ".repeat(width));
        back(actions, width);
        self.line.clear();
        self.cursor = 0;
    }

    fn abandon(&mut self, shown: &[u8], action: Action, actions: &mut Vec<Action>) {
        self.line.clear();
        self.cursor = 0;
        self.browse = self.history.len();
        echo(actions, shown);
        actions.push(action);
    }

    fn remember(&mut self, line: &[u8]) {
        if !line.is_empty() && self.history.last().map(Vec::as_slice) != Some(line) {
            if self.history.len() == HISTORY_LIMIT {
                self.history.remove(0);
            }
            self.history.push(line.to_vec());
        }
        self.browse = self.history.len();
    }

    /// Up (-1) or down (+1) through the history, replacing the line.
    fn recall(&mut self, step: isize, actions: &mut Vec<Action>) {
        let Some(target) = self.browse.checked_add_signed(step) else {
            return;
        };
        if target > self.history.len() {
            return;
        }
        if self.browse == self.history.len() {
            self.draft = self.line.clone();
        }
        self.browse = target;
        let next = self.history.get(target).unwrap_or(&self.draft).clone();
        self.erase_line(actions);
        self.insert(&next, actions);
    }
}

/// The longest text every one of `names` starts with.
pub fn common_prefix(names: &[String]) -> String {
    let Some(first) = names.first() else {
        return String::new();
    };
    let mut end = first.len();
    for name in &names[1..] {
        end = first
            .char_indices()
            .zip(name.chars())
            .find(|((_, a), b)| a != b)
            .map_or(end.min(name.len()), |((at, _), _)| at.min(end));
    }
    first[..end].to_string()
}

/// The directory the last OSC 7 in `output` reports (`ESC ] 7 ; path BEL`),
/// as the guest's prompt prints it on every command.
pub fn osc7_path(output: &[u8]) -> Option<String> {
    const START: &[u8] = b"\x1b]7;";
    let at = output.windows(START.len()).rposition(|w| w == START)? + START.len();
    let end = output[at..].iter().position(|&b| b == 0x07)?;
    Some(String::from_utf8_lossy(&output[at..at + end]).into_owned())
}

/// The columns `bytes` take on screen.
fn columns(bytes: &[u8]) -> usize {
    String::from_utf8_lossy(bytes)
        .chars()
        .map(|c| c.width().unwrap_or(1))
        .sum()
}

fn back(actions: &mut Vec<Action>, columns: usize) {
    if columns > 0 {
        echo(actions, &b"\x08".repeat(columns));
    }
}

fn echo(actions: &mut Vec<Action>, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    if let Some(Action::Echo(shown)) = actions.last_mut() {
        shown.extend_from_slice(bytes);
    } else {
        actions.push(Action::Echo(bytes.to_vec()));
    }
}

/// The program's output as the pane should get it: each newline as CR LF,
/// as a pty's ONLCR does.
pub fn translate_output(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 16);
    for &byte in bytes {
        if byte == b'\n' {
            out.push(b'\r');
        }
        out.push(byte);
    }
    out
}

#[cfg(test)]
mod tests;
