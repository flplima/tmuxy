//! Where an escape string (OSC, DCS, APC) ends, as vt100's parser (vte)
//! reads it: the image parser takes a picture out of the stream only up to
//! the byte the terminal would end it at, so the same output reads the same
//! whole or cut into `%output` lines.

/// Where the last end of an escape string in `content` starts: a BEL (an
/// OSC's: with `bel` false, for a DCS or an APC, which run on past one), a
/// C1 ST (a DCS's), a CAN or SUB (which cancel it), or an ESC with a byte
/// after it (ST, or an escape that aborts the string). Only a last ESC is
/// undecided.
fn last_terminator_start(content: &[u8], bel: bool) -> Option<usize> {
    (0..content.len()).rev().find(|&i| {
        matches!(content[i], C1_ST | CAN | SUB)
            || (bel && content[i] == 0x07)
            || (content[i] == 0x1B && i + 1 < content.len())
    })
}

/// Where a chunk's escape strings can end, scanned once: an escape at `i`
/// has an end after it exactly when the last one starts at or past `i + 2`.
/// Asking each escape to scan the rest of the chunk made a run of
/// unterminated ones quadratic.
pub(super) struct Ends {
    /// Counting a BEL, which ends an OSC.
    osc: Option<usize>,
    /// Not counting one: a DCS or an APC runs on past it, so a Sixel cut
    /// after a BEL is held, and read whole once the rest arrives.
    other: Option<usize>,
}

impl Ends {
    pub(super) fn of(content: &[u8]) -> Self {
        Self {
            osc: last_terminator_start(content, true),
            other: last_terminator_start(content, false),
        }
    }

    /// Whether a string of `kind` whose body starts at `from` can end in
    /// the chunk.
    pub(super) fn after(&self, from: usize, kind: StringKind) -> bool {
        let last = match kind {
            StringKind::Osc => self.osc,
            StringKind::Dcs | StringKind::Apc => self.other,
        };
        last.is_some_and(|at| at >= from)
    }
}

/// Whether `next` ends the escape buffered in `pending`, counting an ESC
/// split from the byte after it: ST, or any other escape that cuts it short.
pub(super) fn ends_pending_escape(pending: &[u8], next: &[u8]) -> bool {
    (pending.last() == Some(&0x1B) && !next.is_empty())
        || last_terminator_start(next, true).is_some()
}

/// Which escape string runs from `from`: what ends it besides ST (`ESC \`),
/// CAN and SUB, as vt100's parser (vte) reads it.
#[derive(Clone, Copy)]
pub(super) enum StringKind {
    /// OSC (iTerm2): a BEL ends it too.
    Osc,
    /// DCS (Sixel, tmux's wrapper): a C1 ST byte ends it too, once the
    /// introducer's final byte (Sixel's `q`) has opened its data.
    Dcs,
    /// APC (Kitty): nothing else.
    Apc,
}

impl StringKind {
    /// The string an escape opens, by the byte after its ESC: `]`, `_` or `P`.
    pub(super) fn of(introducer: u8) -> Self {
        match introducer {
            b']' => Self::Osc,
            b'_' => Self::Apc,
            _ => Self::Dcs,
        }
    }
}

/// How an escape string (OSC, DCS, APC) that runs from `from` in `data`
/// ends, as a terminal reads it.
pub(super) enum StringEnd {
    /// At ST (`ESC \`), or at BEL for an OSC: the body is `data[from..at]`,
    /// and the string ends before `after`.
    Terminated { at: usize, after: usize },
    /// Cut short by another escape, which aborts it: no picture, and the
    /// bytes go on to the terminal, which reads the escape that cut it.
    Aborted,
}

/// Cancel and substitute: in a terminal either one aborts an escape string.
const CAN: u8 = 0x18;
const SUB: u8 = 0x1A;

/// ST as one 8-bit byte. Raw, not as UTF-8: inside a DCS's data vte reads
/// bytes one by one, so the last byte of a `“` ends it too.
const C1_ST: u8 = 0x9C;

/// Where a DCS is in its introducer, as vte tracks it: only `Data` (vte's
/// passthrough) is ended by a C1 ST.
#[derive(Clone, Copy)]
enum Dcs {
    Entry,
    Param,
    Intermediate,
    /// A malformed introducer: ignored up to its end, and never opens data.
    Ignore,
    Data,
}

impl Dcs {
    fn next(self, byte: u8) -> Self {
        match (self, byte) {
            (Self::Data | Self::Ignore, _) => self,
            (_, 0x40..=0x7E) => Self::Data,
            (Self::Entry | Self::Param, 0x20..=0x2F) => Self::Intermediate,
            (Self::Entry, 0x30..=0x3F) => Self::Param,
            (Self::Param, 0x3C..=0x3F) | (Self::Intermediate, 0x30..=0x3F) => Self::Ignore,
            _ => self,
        }
    }
}

/// Where the escape string of `kind` from `from` ends; `None` while it has
/// not ended yet (no ESC, or an ESC as the last byte, which could still
/// become ST).
pub(super) fn string_end(data: &[u8], from: usize, kind: StringKind) -> Option<StringEnd> {
    let mut dcs = Dcs::Entry;
    for (i, &byte) in data.iter().enumerate().skip(from) {
        let ends = match kind {
            StringKind::Osc => byte == 0x07,
            StringKind::Dcs => byte == C1_ST && matches!(dcs, Dcs::Data),
            StringKind::Apc => false,
        };
        if ends {
            return Some(StringEnd::Terminated {
                at: i,
                after: i + 1,
            });
        }
        dcs = dcs.next(byte);
        if byte == CAN || byte == SUB {
            return Some(StringEnd::Aborted);
        }
        if byte == 0x1B {
            return match data.get(i + 1) {
                Some(b'\\') => Some(StringEnd::Terminated {
                    at: i,
                    after: i + 2,
                }),
                Some(_) => Some(StringEnd::Aborted),
                None => None,
            };
        }
    }
    None
}

/// Find the terminator of an OSC body (BEL or ESC \\). `content` starts
/// AFTER the `ESC ]` prefix; returns (bytes consumed from `content`,
/// terminator included, and the body).
pub(super) fn find_osc_end(content: &[u8]) -> Option<(usize, &[u8])> {
    match string_end(content, 0, StringKind::Osc)? {
        StringEnd::Terminated { at, after } => Some((after, &content[..at])),
        StringEnd::Aborted => None,
    }
}
