//! What a pane's program asks of the terminal beyond drawing: a title
//! (OSC 0 / OSC 2), a clipboard write (OSC 52), its own status (OSC 7501,
//! with the shell's prompt mark, OSC 133 ; A, that ends a command's) and the
//! size of a cell in pixels (`CSI 16 t`, `CSI 14 t`). vt100
//! reads the sequences (with the rest of the pane's output: hyperlinks and
//! text sizes are cell attributes there) and calls these; the pane drains
//! them after each write.

use super::cell_size::{SizeQuery, MAX_REPLIES};
use super::program_status::Report;

/// Upper bound on an OSC 0 / OSC 2 pane title accepted from terminal output.
const MAX_TITLE_BYTES: usize = 1024;
/// Upper bound on raw base64 bytes decoded for a single OSC 52 clipboard write.
const MAX_CLIPBOARD_BASE64_BYTES: usize = 2 * 1024 * 1024;
/// How many `;`-separated pieces of an OSC vte keeps: one that has this many
/// may have lost its tail.
const OSC_PIECES_KEPT: usize = 16;

/// What the output said about the status of the pane's program, in order.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StatusEvent {
    Report(Report),
    /// A new shell prompt began (OSC 133 ; A).
    PromptBegan,
}

/// The requests one pane's output made since they were last taken.
#[derive(Debug, Default)]
pub(crate) struct OscRequests {
    title: Option<String>,
    clipboard: Option<String>,
    status: Vec<StatusEvent>,
    /// Size queries since the last take, no more than a pane may be answered
    /// in a second: what is past that would be dropped anyway.
    size_queries: Vec<SizeQuery>,
}

impl vt100::Callbacks for OscRequests {
    // OSC 1, the icon name, is not what a window is called: only the title is
    // kept.
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        let title = String::from_utf8_lossy(title);
        let mut end = title.len().min(MAX_TITLE_BYTES);
        while !title.is_char_boundary(end) {
            end -= 1;
        }
        self.title = Some(title[..end].to_string());
    }

    fn copy_to_clipboard(&mut self, _: &mut vt100::Screen, _ty: &[u8], data: &[u8]) {
        if data.len() > MAX_CLIPBOARD_BASE64_BYTES {
            return;
        }
        let decoded = std::str::from_utf8(data)
            .ok()
            .and_then(crate::control_mode::images::base64_decode)
            .and_then(|bytes| String::from_utf8(bytes).ok());
        if let Some(text) = decoded {
            self.clipboard = Some(text);
        }
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        match params {
            // A report holds no `;`, but one that does is still read past its
            // malformed pair, so the pieces are put back together.
            [b"7501", body @ ..] if !body.is_empty() && params.len() < OSC_PIECES_KEPT => {
                if let Some(report) = Report::parse(&body.join(&b';')) {
                    self.status.push(StatusEvent::Report(report));
                }
            }
            [b"133", b"A", ..] => self.status.push(StatusEvent::PromptBegan),
            _ => {}
        }
    }

    fn unhandled_csi(
        &mut self,
        _: &mut vt100::Screen,
        i1: Option<u8>,
        _i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        if c != 't' || i1.is_some() || self.size_queries.len() >= usize::from(MAX_REPLIES) {
            return;
        }
        if let Some(query) = SizeQuery::from_params(params) {
            self.size_queries.push(query);
        }
    }
}

impl OscRequests {
    /// The last OSC 52 clipboard write, if one came since the last call.
    pub(crate) fn take_clipboard(&mut self) -> Option<String> {
        self.clipboard.take()
    }

    /// The last OSC 0 / OSC 2 title, if one came since the last call.
    pub(crate) fn take_title(&mut self) -> Option<String> {
        self.title.take()
    }

    /// The program status reports and prompt marks since the last call.
    pub(crate) fn take_status(&mut self) -> Vec<StatusEvent> {
        std::mem::take(&mut self.status)
    }

    /// The cell size queries since the last call, in order.
    pub(crate) fn take_size_queries(&mut self) -> Vec<SizeQuery> {
        std::mem::take(&mut self.size_queries)
    }
}

#[cfg(test)]
mod tests;
