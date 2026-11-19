//! Where an escape string (OSC, DCS, APC) ends, as vt100's parser (vte)
//! reads it: the image parser takes a picture out of the stream only up to
//! the byte the terminal would end it at, so the same output reads the same
//! whole or cut into `%output` lines.

/// Where the last end of an escape string in `content` starts: a BEL (an
/// OSC's), a C1 ST (a DCS's), a CAN or SUB (which cancel it), or an ESC with
/// a byte after it (ST, or an escape that aborts the string). Only a last ESC
/// is undecided.
pub(super) fn last_terminator_start(content: &[u8]) -> Option<usize> {
    (0..content.len()).rev().find(|&i| {
        matches!(content[i], 0x07 | C1_ST | CAN | SUB)
            || (content[i] == 0x1B && i + 1 < content.len())
    })
}

/// Whether `next` ends the escape buffered in `pending`, counting an ESC
/// split from the byte after it: ST, or any other escape that cuts it short.
pub(super) fn ends_pending_escape(pending: &[u8], next: &[u8]) -> bool {
    (pending.last() == Some(&0x1B) && !next.is_empty()) || last_terminator_start(next).is_some()
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
