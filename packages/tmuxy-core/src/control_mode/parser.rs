//! Parser for tmux control mode notifications
//!
//! Control mode outputs various notifications prefixed with `%`:
//! - `%output %pane-id value` - Pane output
//! - `%layout-change @window layout visible-layout flags` - Layout changed
//! - `%begin/%end/%error` - Command response blocks
//! - etc.

use super::octal::decode_octal;
use crate::{PaneId, WindowId};

/// Events parsed from control mode output
#[derive(Debug, Clone)]
pub enum ControlModeEvent {
    /// Raw pane output (octal-decoded)
    Output { pane_id: PaneId, content: Vec<u8> },

    /// Extended output with timing info (when flow control is enabled)
    ExtendedOutput {
        pane_id: PaneId,
        age_ms: u64,
        content: Vec<u8>,
    },

    /// Layout change notification
    LayoutChange {
        window_id: WindowId,
        layout: String,
        visible_layout: String,
        flags: String,
    },

    /// Window added
    WindowAdd { window_id: WindowId },

    /// Window closed
    WindowClose { window_id: WindowId },

    /// Window renamed
    WindowRenamed { window_id: WindowId, name: String },

    /// Active pane changed in window
    WindowPaneChanged {
        window_id: WindowId,
        pane_id: PaneId,
    },

    /// Pane mode changed (e.g., entered/exited copy mode)
    PaneModeChanged { pane_id: PaneId },

    /// A `refresh-client -B` subscription's value changed for a pane:
    /// `%subscription-changed <name> $session @window <index> %pane ... : value`.
    SubscriptionChanged { name: String, pane_id: PaneId },

    /// A paste buffer was created or updated (e.g. copy-mode yank, set-buffer).
    /// tmux does not forward OSC 52 to a control-mode client, so this is how
    /// tmuxy learns a copy happened and mirrors the buffer to the web clipboard.
    PasteBufferChanged { buffer_name: String },

    /// Session changed
    SessionChanged {
        session_id: String,
        session_name: String,
    },

    /// A session renamed: any session on the server, not only the attached one
    SessionRenamed { session_id: String, name: String },

    /// Session window changed (active window in session)
    SessionWindowChanged {
        session_id: String,
        window_id: WindowId,
    },

    /// Sessions list changed (session created/destroyed)
    SessionsChanged,

    /// Command response block completed
    CommandResponse {
        timestamp: u64,
        command_num: u32,
        output: String,
        success: bool,
    },

    /// Flow control: pane paused
    Pause { pane_id: PaneId },

    /// Flow control: pane continued
    Continue { pane_id: PaneId },

    /// A `display-message` aimed at this client (tmux 3.4+): `%message text`.
    /// tmux writes the text as it is, unescaped; the parser strips control
    /// characters and caps the length (`MAX_MESSAGE_CHARS`). One this client
    /// ran itself comes inside its command's response block instead (see
    /// `message_line`).
    Message { text: String },

    /// Control mode client exiting
    Exit { reason: Option<String> },

    /// Unlinked window added (window not linked to current session)
    UnlinkedWindowAdd { window_id: WindowId },

    /// Unlinked window closed
    UnlinkedWindowClose { window_id: WindowId },
}

/// Parser for control mode notifications
pub struct Parser {
    /// State for multi-line command responses
    in_response: bool,
    response_buffer: String,
    /// Whether any body line has been accumulated for the current response.
    /// Tracked separately from `response_buffer.is_empty()` because the first
    /// body line may itself be empty — a capture-pane whose top row is blank —
    /// and must still count, or every leading blank row is lost.
    response_has_lines: bool,
    response_timestamp: u64,
    response_command_num: u32,
}

impl Parser {
    pub fn new() -> Self {
        Self {
            in_response: false,
            response_buffer: String::new(),
            response_has_lines: false,
            response_timestamp: 0,
            response_command_num: 0,
        }
    }

    /// Parse a single line from control mode output, as the bytes tmux wrote.
    /// Returns Some(event) if a complete event was parsed, None otherwise.
    ///
    /// Pane output is parsed from the bytes themselves. tmux passes a pane's
    /// non-ASCII bytes through raw and cuts `%output` wherever its read ended,
    /// so one line can carry part of a character — a program repainting its
    /// line byte by byte (zsh-autosuggestions) sends `語` as three lines of one
    /// byte each. Read as text first, each fragment became U+FFFD and the
    /// character never reached the emulator, whose UTF-8 decoder joins a
    /// character split across writes; its cursor then sat a glyph short of
    /// tmux's, and the next relative move redrew the line in the wrong place.
    pub fn parse_line(&mut self, line: impl AsRef<[u8]>) -> Option<ControlModeEvent> {
        use crate::constants::control_events as ev;

        let bytes = line.as_ref();
        if !self.in_response {
            if let Some(rest) = bytes.strip_prefix(ev::OUTPUT.as_bytes()) {
                return Self::parse_output(rest);
            }
            if let Some(rest) = bytes.strip_prefix(ev::EXTENDED_OUTPUT.as_bytes()) {
                return Self::parse_extended_output(rest);
            }
        }
        self.parse_text(&String::from_utf8_lossy(bytes))
    }

    /// Every line but pane output: tmux's own text.
    fn parse_text(&mut self, line: &str) -> Option<ControlModeEvent> {
        use crate::constants::control_events as ev;

        // Handle command response blocks
        if line.starts_with(ev::BEGIN) {
            return self.handle_begin(line);
        }

        if line.starts_with(ev::END) {
            return self.handle_end(line, true);
        }

        if line.starts_with(ev::ERROR) {
            return self.handle_end(line, false);
        }

        // If we're in a response block, accumulate the line
        if self.in_response {
            if self.response_has_lines {
                self.response_buffer.push('\n');
            }
            self.response_buffer.push_str(line);
            self.response_has_lines = true;
            return None;
        }

        // Parse notifications (all start with %)
        if !line.starts_with('%') {
            return None;
        }

        self.parse_notification(line)
    }

    fn handle_begin(&mut self, line: &str) -> Option<ControlModeEvent> {
        // Format: %begin timestamp command-number flags
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            self.in_response = true;
            self.response_timestamp = parts[1].parse().unwrap_or(0);
            self.response_command_num = parts[2].parse().unwrap_or(0);
            self.response_buffer.clear();
            self.response_has_lines = false;
        }
        None
    }

    fn handle_end(&mut self, _line: &str, success: bool) -> Option<ControlModeEvent> {
        // A stray %end/%error with no matching %begin would otherwise emit a
        // CommandResponse carrying the previous block's stale timestamp/
        // command_num and an empty body, which downstream treats as a real
        // (state-changing) response.
        if !self.in_response {
            return None;
        }
        let event = ControlModeEvent::CommandResponse {
            timestamp: self.response_timestamp,
            command_num: self.response_command_num,
            output: std::mem::take(&mut self.response_buffer),
            success,
        };
        self.in_response = false;
        Some(event)
    }

    fn parse_notification(&self, line: &str) -> Option<ControlModeEvent> {
        use crate::constants::control_events as ev;

        // %layout-change @window layout visible-layout flags
        if line.starts_with(ev::LAYOUT_CHANGE) {
            return self.parse_layout_change(line);
        }

        // %window-add @window
        if let Some(rest) = line.strip_prefix(ev::WINDOW_ADD) {
            return Some(ControlModeEvent::WindowAdd {
                window_id: rest.trim().parse().ok()?,
            });
        }

        // %window-close @window
        if let Some(rest) = line.strip_prefix(ev::WINDOW_CLOSE) {
            return Some(ControlModeEvent::WindowClose {
                window_id: rest.trim().parse().ok()?,
            });
        }

        // %window-renamed @window name
        if line.starts_with(ev::WINDOW_RENAMED) {
            return self.parse_window_renamed(line);
        }

        // %window-pane-changed @window %pane
        if line.starts_with(ev::WINDOW_PANE_CHANGED) {
            return self.parse_window_pane_changed(line);
        }

        // %pane-mode-changed %pane
        if let Some(rest) = line.strip_prefix(ev::PANE_MODE_CHANGED) {
            return Some(ControlModeEvent::PaneModeChanged {
                pane_id: rest.trim().parse().ok()?,
            });
        }

        // %subscription-changed name $session @window index %pane ... : value
        if let Some(rest) = line.strip_prefix(ev::SUBSCRIPTION_CHANGED) {
            let head = rest.split(" : ").next().unwrap_or(rest);
            let mut words = head.split_whitespace();
            let name = words.next()?.to_string();
            let pane_id = words.find_map(|w| PaneId::parse(w).ok())?;
            return Some(ControlModeEvent::SubscriptionChanged { name, pane_id });
        }

        // %paste-buffer-changed buffer-name
        if let Some(rest) = line.strip_prefix(ev::PASTE_BUFFER_CHANGED) {
            return Some(ControlModeEvent::PasteBufferChanged {
                buffer_name: rest.trim().to_string(),
            });
        }

        // %session-changed $session name
        if line.starts_with(ev::SESSION_CHANGED) {
            return self.parse_session_changed(line);
        }

        // %session-renamed $session name
        if let Some(rest) = line.strip_prefix(ev::SESSION_RENAMED) {
            let (session_id, name) = rest.split_once(' ')?;
            return Some(ControlModeEvent::SessionRenamed {
                session_id: session_id.to_string(),
                name: name.to_string(),
            });
        }

        // %session-window-changed $session @window
        if line.starts_with(ev::SESSION_WINDOW_CHANGED) {
            return self.parse_session_window_changed(line);
        }

        // %sessions-changed
        if line == ev::SESSIONS_CHANGED {
            return Some(ControlModeEvent::SessionsChanged);
        }

        // %pause %pane
        if let Some(rest) = line.strip_prefix(ev::PAUSE) {
            return Some(ControlModeEvent::Pause {
                pane_id: rest.trim().parse().ok()?,
            });
        }

        // %continue %pane
        if let Some(rest) = line.strip_prefix(ev::CONTINUE) {
            return Some(ControlModeEvent::Continue {
                pane_id: rest.trim().parse().ok()?,
            });
        }

        // %message text
        if let Some(text) = message_line(line) {
            return Some(ControlModeEvent::Message { text });
        }

        // %client-detached / %client-session-changed are intentionally
        // ignored: they describe OTHER clients on the same server, and no
        // consumer (aggregator, monitor, wasm) has ever acted on them. They
        // fall through to the unknown-line None below.

        // %exit [reason]
        if let Some(rest) = line.strip_prefix(ev::EXIT) {
            let rest = rest.trim();
            return Some(ControlModeEvent::Exit {
                reason: if rest.is_empty() {
                    None
                } else {
                    Some(rest.to_string())
                },
            });
        }

        // %unlinked-window-add @window
        if let Some(rest) = line.strip_prefix(ev::UNLINKED_WINDOW_ADD) {
            return Some(ControlModeEvent::UnlinkedWindowAdd {
                window_id: rest.trim().parse().ok()?,
            });
        }

        // %unlinked-window-close @window
        if let Some(rest) = line.strip_prefix(ev::UNLINKED_WINDOW_CLOSE) {
            return Some(ControlModeEvent::UnlinkedWindowClose {
                window_id: rest.trim().parse().ok()?,
            });
        }

        None
    }

    /// `%output %pane-id value`, after the `%output ` prefix. The pane id is
    /// tmux's ASCII; the value is the pane's bytes, kept exactly.
    fn parse_output(rest: &[u8]) -> Option<ControlModeEvent> {
        let Some(space_idx) = rest.iter().position(|&b| b == b' ') else {
            // No content (empty output)
            return Some(ControlModeEvent::Output {
                pane_id: std::str::from_utf8(rest).ok()?.trim().parse().ok()?,
                content: Vec::new(),
            });
        };
        let pane_id = PaneId::parse(std::str::from_utf8(&rest[..space_idx]).ok()?).ok()?;
        let content = decode_octal(&rest[space_idx + 1..]);
        Some(ControlModeEvent::Output { pane_id, content })
    }

    /// `%extended-output %pane-id age ... : value`, after the prefix.
    fn parse_extended_output(rest: &[u8]) -> Option<ControlModeEvent> {
        const SEPARATOR: &[u8] = b" : ";
        let sep_idx = rest.windows(SEPARATOR.len()).position(|w| w == SEPARATOR)?;
        let header = std::str::from_utf8(&rest[..sep_idx]).ok()?;
        let mut header_parts = header.split_whitespace();

        let pane_id = PaneId::parse(header_parts.next()?).ok()?;
        let age_ms = header_parts
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let content = decode_octal(&rest[sep_idx + SEPARATOR.len()..]);

        Some(ControlModeEvent::ExtendedOutput {
            pane_id,
            age_ms,
            content,
        })
    }

    fn parse_layout_change(&self, line: &str) -> Option<ControlModeEvent> {
        use crate::constants::control_events as ev;
        // %layout-change @window layout visible-layout flags
        let rest = line.strip_prefix(ev::LAYOUT_CHANGE)?;
        let parts: Vec<&str> = rest.split_whitespace().collect();

        if parts.len() >= 3 {
            Some(ControlModeEvent::LayoutChange {
                window_id: parts[0].parse().ok()?,
                layout: parts[1].to_string(),
                visible_layout: parts[2].to_string(),
                flags: parts.get(3).unwrap_or(&"").to_string(),
            })
        } else {
            None
        }
    }

    fn parse_window_renamed(&self, line: &str) -> Option<ControlModeEvent> {
        use crate::constants::control_events as ev;
        // %window-renamed @window name
        let rest = line.strip_prefix(ev::WINDOW_RENAMED)?;
        let (window_id, name) = rest.split_once(' ')?;
        Some(ControlModeEvent::WindowRenamed {
            window_id: WindowId::parse(window_id).ok()?,
            name: name.to_string(),
        })
    }

    fn parse_window_pane_changed(&self, line: &str) -> Option<ControlModeEvent> {
        use crate::constants::control_events as ev;
        // %window-pane-changed @window %pane
        let rest = line.strip_prefix(ev::WINDOW_PANE_CHANGED)?;
        let parts: Vec<&str> = rest.split_whitespace().collect();

        if parts.len() >= 2 {
            Some(ControlModeEvent::WindowPaneChanged {
                window_id: parts[0].parse().ok()?,
                pane_id: parts[1].parse().ok()?,
            })
        } else {
            None
        }
    }

    fn parse_session_changed(&self, line: &str) -> Option<ControlModeEvent> {
        use crate::constants::control_events as ev;
        // %session-changed $session name
        let rest = line.strip_prefix(ev::SESSION_CHANGED)?;
        let (session_id, session_name) = rest.split_once(' ')?;
        Some(ControlModeEvent::SessionChanged {
            session_id: session_id.to_string(),
            session_name: session_name.to_string(),
        })
    }

    fn parse_session_window_changed(&self, line: &str) -> Option<ControlModeEvent> {
        use crate::constants::control_events as ev;
        // %session-window-changed $session @window
        let rest = line.strip_prefix(ev::SESSION_WINDOW_CHANGED)?;
        let parts: Vec<&str> = rest.split_whitespace().collect();

        if parts.len() >= 2 {
            Some(ControlModeEvent::SessionWindowChanged {
                session_id: parts[0].to_string(),
                window_id: parts[1].parse().ok()?,
            })
        } else {
            None
        }
    }
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

/// The longest `%message` text kept, in characters; the rest is cut and an
/// ellipsis marks the cut. A message is a line on the screen, not a document.
pub const MAX_MESSAGE_CHARS: usize = 500;

/// The text of a `%message` line, cleaned (`clean_message`); `None` for any
/// other line.
///
/// A message from a `display-message` this client ran itself arrives INSIDE
/// that command's `%begin`/`%end` block, where the parser takes every line as
/// response text — so the monitor also looks for it in the output of the
/// commands it sent.
pub fn message_line(line: &str) -> Option<String> {
    line.strip_prefix(crate::constants::control_events::MESSAGE)
        .map(clean_message)
}

/// A `%message` body as it can be shown: a tab becomes a space, every other
/// control character is dropped, and the text is capped at
/// `MAX_MESSAGE_CHARS`. tmux writes the text unescaped, so there is nothing
/// to decode.
fn clean_message(raw: &str) -> String {
    let mut chars = raw
        .chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control());
    let mut text: String = chars.by_ref().take(MAX_MESSAGE_CHARS).collect();
    if chars.next().is_some() {
        text.push('…');
    }
    text
}

#[cfg(test)]
mod tests;
