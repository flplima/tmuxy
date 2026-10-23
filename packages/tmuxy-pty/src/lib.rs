//! The terminal a CheerpX guest pane runs on. CheerpX gives every process the
//! same pseudo-terminal, so the guest's tmux runs each pane on a socket pair
//! and execs the pane's program under `tmuxy-pty`, which does the part of a
//! pty the program relies on: the line discipline here (echo, line editing,
//! history, Ctrl+C, Ctrl+D) and output newline translation.

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
}

const HISTORY_LIMIT: usize = 500;
const ERASE: &[u8] = b"\x08 \x08";

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

/// A canonical-mode line discipline with echo: input is held and edited until
/// Enter, as a pty does it for a program that has not asked for raw mode.
#[derive(Default)]
pub struct LineDiscipline {
    line: Vec<u8>,
    history: Vec<Vec<u8>>,
    /// The history entry the arrows are on; `history.len()` is the line
    /// being typed, kept in `draft` while browsing.
    browse: usize,
    draft: Vec<u8>,
    escape: Escape,
}

impl LineDiscipline {
    pub fn new() -> Self {
        Self::default()
    }

    /// What has been typed of the line so far, not yet sent.
    pub fn line(&self) -> &[u8] {
        &self.line
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
                    match byte {
                        b'A' => self.recall(-1, actions),
                        b'B' => self.recall(1, actions),
                        _ => {}
                    }
                }
                return;
            }
            Escape::None => {}
        }
        match byte {
            b'\r' | b'\n' => {
                echo(actions, b"\r\n");
                let mut line = std::mem::take(&mut self.line);
                self.remember(&line);
                line.push(b'\n');
                actions.push(Action::Send(line));
            }
            0x7f | 0x08 => {
                if self.pop_char() {
                    echo(actions, ERASE);
                }
            }
            0x15 => self.erase_line(actions),
            0x17 => {
                while self.line.last() == Some(&b' ') && self.pop_char() {
                    echo(actions, ERASE);
                }
                while self.line.last().is_some_and(|&b| b != b' ') && self.pop_char() {
                    echo(actions, ERASE);
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
                    actions.push(Action::Send(std::mem::take(&mut self.line)));
                }
            }
            0x0c => actions.push(Action::ClearScreen),
            0x1b => self.escape = Escape::Esc,
            b'\t' => self.insert(byte, actions),
            0x00..=0x1f => {}
            _ => self.insert(byte, actions),
        }
    }

    fn insert(&mut self, byte: u8, actions: &mut Vec<Action>) {
        self.line.push(byte);
        echo(actions, &[byte]);
    }

    /// Drop the last character (all of a UTF-8 sequence); false when empty.
    fn pop_char(&mut self) -> bool {
        while let Some(byte) = self.line.pop() {
            if byte & 0xc0 != 0x80 {
                return true;
            }
        }
        false
    }

    fn erase_line(&mut self, actions: &mut Vec<Action>) {
        while self.pop_char() {
            echo(actions, ERASE);
        }
    }

    fn abandon(&mut self, shown: &[u8], action: Action, actions: &mut Vec<Action>) {
        self.line.clear();
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
        echo(actions, &next);
        self.line = next;
    }
}

fn echo(actions: &mut Vec<Action>, bytes: &[u8]) {
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
mod tests {
    use super::*;

    fn typed(keys: &[u8]) -> (Vec<u8>, Vec<Action>) {
        let mut ld = LineDiscipline::new();
        let mut shown = Vec::new();
        let mut rest = Vec::new();
        for action in ld.input(keys) {
            match action {
                Action::Echo(bytes) => shown.extend(bytes),
                other => rest.push(other),
            }
        }
        (shown, rest)
    }

    #[test]
    fn a_line_is_echoed_and_sent_on_enter() {
        let (shown, rest) = typed(b"ls -l\r");
        assert_eq!(shown, b"ls -l\r\n");
        assert_eq!(rest, vec![Action::Send(b"ls -l\n".to_vec())]);
    }

    #[test]
    fn nothing_is_sent_before_enter() {
        assert_eq!(typed(b"echo hi").1, vec![]);
    }

    #[test]
    fn backspace_erases_a_whole_utf8_character() {
        let (shown, rest) = typed("ação\x7f\x7fx\r".as_bytes());
        assert_eq!(rest, vec![Action::Send("açx\n".as_bytes().to_vec())]);
        assert!(shown.ends_with(b"\x08 \x08\x08 \x08x\r\n"));
    }

    #[test]
    fn backspace_on_an_empty_line_shows_nothing() {
        assert_eq!(typed(b"\x7f"), (vec![], vec![]));
    }

    #[test]
    fn ctrl_u_and_ctrl_w_erase_the_line_and_the_last_word() {
        assert_eq!(typed(b"abc\x15x\r").1, vec![Action::Send(b"x\n".to_vec())]);
        assert_eq!(
            typed(b"git commit  \x17push\r").1,
            vec![Action::Send(b"git push\n".to_vec())]
        );
    }

    #[test]
    fn ctrl_c_drops_the_line_and_interrupts() {
        let (shown, rest) = typed(b"sleep 9\x03");
        assert!(shown.ends_with(b"^C"));
        assert_eq!(rest, vec![Action::Interrupt]);
    }

    #[test]
    fn ctrl_d_ends_input_only_on_an_empty_line() {
        assert_eq!(typed(b"\x04").1, vec![Action::EndOfInput]);
        assert_eq!(typed(b"ab\x04").1, vec![Action::Send(b"ab".to_vec())]);
    }

    #[test]
    fn ctrl_l_asks_for_a_clear_screen_and_keeps_the_line() {
        let mut ld = LineDiscipline::new();
        assert_eq!(
            ld.input(b"ls\x0c"),
            vec![Action::Echo(b"ls".to_vec()), Action::ClearScreen]
        );
        assert_eq!(ld.line(), b"ls");
    }

    #[test]
    fn arrows_recall_history_and_return_to_the_draft() {
        let mut ld = LineDiscipline::new();
        ld.input(b"one\rtwo\rdra");
        ld.input(b"\x1b[A\x1b[A");
        assert_eq!(ld.line, b"one");
        ld.input(b"\x1bOB\x1b[B");
        assert_eq!(ld.line, b"dra");
        assert_eq!(ld.input(b"\x1b[B"), vec![]);
        let sent = ld.input(b"\x1b[A\r");
        assert_eq!(sent.last(), Some(&Action::Send(b"two\n".to_vec())));
    }

    #[test]
    fn other_escape_sequences_and_control_keys_are_dropped() {
        let (shown, rest) = typed(b"a\x1b[1;5C\x1b[3~\x01\x1bxb\r");
        assert_eq!(shown, b"ab\r\n");
        assert_eq!(rest, vec![Action::Send(b"ab\n".to_vec())]);
    }

    #[test]
    fn output_newlines_become_crlf() {
        assert_eq!(translate_output(b"a\nb\n"), b"a\r\nb\r\n");
    }
}
