/// A parser for terminal output which produces an in-memory representation of
/// the terminal contents.
pub struct Parser<CB: crate::callbacks::Callbacks = ()> {
    parser: vte::Parser,
    screen: crate::perform::WrappedScreen<CB>,
    /// The incomplete UTF-8 character the last write ended with, held for
    /// the next (see [`Parser::process`]).
    held: Vec<u8>,
}

impl Parser {
    /// Creates a new terminal parser of the given size and with the given
    /// amount of scrollback.
    #[must_use]
    pub fn new(rows: u16, cols: u16, scrollback_len: usize) -> Self {
        Self {
            parser: vte::Parser::new(),
            held: Vec::new(),
            screen: crate::perform::WrappedScreen::new(
                rows,
                cols,
                scrollback_len,
            ),
        }
    }
}

impl<CB: crate::callbacks::Callbacks> Parser<CB> {
    /// Creates a new terminal parser of the given size and with the given
    /// amount of scrollback. Terminal events will be reported via method
    /// calls on the provided [`Callbacks`](crate::callbacks::Callbacks)
    /// implementation.
    pub fn new_with_callbacks(
        rows: u16,
        cols: u16,
        scrollback_len: usize,
        callbacks: CB,
    ) -> Self {
        Self {
            parser: vte::Parser::new(),
            held: Vec::new(),
            screen: crate::perform::WrappedScreen::new_with_callbacks(
                rows,
                cols,
                scrollback_len,
                callbacks,
            ),
        }
    }

    /// Processes the contents of the given byte string, and updates the
    /// in-memory terminal state.
    ///
    /// A character split across writes is held back whole: vte decodes one
    /// on a separate path that, with an invalid byte soon after, dropped
    /// the valid characters in between (vte 0.15 `advance_partial_utf8`), so
    /// the screen depended on where the writes happened to end.
    pub fn process(&mut self, bytes: &[u8]) {
        let joined;
        let bytes = if self.held.is_empty() {
            bytes
        } else {
            joined = [std::mem::take(&mut self.held).as_slice(), bytes].concat();
            joined.as_slice()
        };
        let whole = bytes.len() - incomplete_utf8_tail(bytes);
        self.parser.advance(&mut self.screen, &bytes[..whole]);
        self.held = bytes[whole..].to_vec();
    }

    /// Returns a reference to a [`Screen`](crate::Screen) object containing
    /// the terminal state.
    #[must_use]
    pub fn screen(&self) -> &crate::Screen {
        &self.screen.screen
    }

    /// Returns a mutable reference to a [`Screen`](crate::Screen) object
    /// containing the terminal state.
    #[must_use]
    pub fn screen_mut(&mut self) -> &mut crate::Screen {
        &mut self.screen.screen
    }

    /// Returns a reference to the [`Callbacks`](crate::callbacks::Callbacks)
    /// state object passed into the constructor.
    pub fn callbacks(&self) -> &CB {
        &self.screen.callbacks
    }

    /// Returns a mutable reference to the
    /// [`Callbacks`](crate::callbacks::Callbacks) state object passed into
    /// the constructor.
    pub fn callbacks_mut(&mut self) -> &mut CB {
        &mut self.screen.callbacks
    }
}

impl Default for Parser {
    /// Returns a parser with dimensions 80x24 and no scrollback.
    fn default() -> Self {
        Self::new(24, 80, 0)
    }
}

impl std::io::Write for Parser {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.process(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// How many bytes at the end of `bytes` start a UTF-8 character that is not
/// complete yet: a lead byte and fewer continuation bytes than it needs.
fn incomplete_utf8_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let needs = match byte {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xFF => 4,
            _ => return 0,
        };
        return if back < needs { back } else { 0 };
    }
    0
}
