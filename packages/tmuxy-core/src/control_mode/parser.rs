//! Parser for tmux control mode notifications
//!
//! Control mode outputs various notifications prefixed with `%`:
//! - `%output %pane-id value` - Pane output
//! - `%layout-change @window layout visible-layout flags` - Layout changed
//! - `%begin/%end/%error` - Command response blocks
//! - etc.

use super::octal::decode_octal;

/// Events parsed from control mode output
#[derive(Debug, Clone)]
pub enum ControlModeEvent {
    /// Raw pane output (octal-decoded)
    Output {
        pane_id: String,
        content: Vec<u8>,
    },

    /// Extended output with timing info (when flow control is enabled)
    ExtendedOutput {
        pane_id: String,
        age_ms: u64,
        content: Vec<u8>,
    },

    /// Layout change notification
    LayoutChange {
        window_id: String,
        layout: String,
        visible_layout: String,
        flags: String,
    },

    /// Window added
    WindowAdd {
        window_id: String,
    },

    /// Window closed
    WindowClose {
        window_id: String,
    },

    /// Window renamed
    WindowRenamed {
        window_id: String,
        name: String,
    },

    /// Active pane changed in window
    WindowPaneChanged {
        window_id: String,
        pane_id: String,
    },

    /// Pane mode changed (e.g., entered/exited copy mode)
    PaneModeChanged {
        pane_id: String,
    },

    /// Session changed
    SessionChanged {
        session_id: String,
        session_name: String,
    },

    /// Session renamed
    SessionRenamed {
        name: String,
    },

    /// Session window changed (active window in session)
    SessionWindowChanged {
        session_id: String,
        window_id: String,
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
    Pause {
        pane_id: String,
    },

    /// Flow control: pane continued
    Continue {
        pane_id: String,
    },

    /// Client detached
    ClientDetached {
        client: String,
    },

    /// Client session changed
    ClientSessionChanged {
        client: String,
        session_id: String,
        session_name: String,
    },

    /// Control mode client exiting
    Exit {
        reason: Option<String>,
    },

    /// Unlinked window added (window not linked to current session)
    UnlinkedWindowAdd {
        window_id: String,
    },

    /// Unlinked window closed
    UnlinkedWindowClose {
        window_id: String,
    },
}

/// Parser for control mode notifications
pub struct Parser {
    /// State for multi-line command responses
    in_response: bool,
    response_buffer: String,
    response_timestamp: u64,
    response_command_num: u32,
}

impl Parser {
    pub fn new() -> Self {
        Self {
            in_response: false,
            response_buffer: String::new(),
            response_timestamp: 0,
            response_command_num: 0,
        }
    }

    /// Parse a single line from control mode output.
    /// Returns Some(event) if a complete event was parsed, None otherwise.
    pub fn parse_line(&mut self, line: &str) -> Option<ControlModeEvent> {
        // Handle command response blocks
        if line.starts_with("%begin ") {
            return self.handle_begin(line);
        }

        if line.starts_with("%end ") {
            return self.handle_end(line, true);
        }

        if line.starts_with("%error ") {
            return self.handle_end(line, false);
        }

        // If we're in a response block, accumulate the line
        if self.in_response {
            if !self.response_buffer.is_empty() {
                self.response_buffer.push('\n');
            }
            self.response_buffer.push_str(line);
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
        }
        None
    }

    fn handle_end(&mut self, _line: &str, success: bool) -> Option<ControlModeEvent> {
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
        // %output %pane-id value
        if line.starts_with("%output ") {
            return self.parse_output(line);
        }

        // %extended-output %pane-id age ... : value
        if line.starts_with("%extended-output ") {
            return self.parse_extended_output(line);
        }

        // %layout-change @window layout visible-layout flags
        if line.starts_with("%layout-change ") {
            return self.parse_layout_change(line);
        }

        // %window-add @window
        if line.starts_with("%window-add ") {
            let rest = &line["%window-add ".len()..];
            return Some(ControlModeEvent::WindowAdd {
                window_id: rest.trim().to_string(),
            });
        }

        // %window-close @window
        if line.starts_with("%window-close ") {
            let rest = &line["%window-close ".len()..];
            return Some(ControlModeEvent::WindowClose {
                window_id: rest.trim().to_string(),
            });
        }

        // %window-renamed @window name
        if line.starts_with("%window-renamed ") {
            return self.parse_window_renamed(line);
        }

        // %window-pane-changed @window %pane
        if line.starts_with("%window-pane-changed ") {
            return self.parse_window_pane_changed(line);
        }

        // %pane-mode-changed %pane
        if line.starts_with("%pane-mode-changed ") {
            let rest = &line["%pane-mode-changed ".len()..];
            return Some(ControlModeEvent::PaneModeChanged {
                pane_id: rest.trim().to_string(),
            });
        }

        // %session-changed $session name
        if line.starts_with("%session-changed ") {
            return self.parse_session_changed(line);
        }

        // %session-renamed name
        if line.starts_with("%session-renamed ") {
            let rest = &line["%session-renamed ".len()..];
            return Some(ControlModeEvent::SessionRenamed {
                name: rest.trim().to_string(),
            });
        }

        // %session-window-changed $session @window
        if line.starts_with("%session-window-changed ") {
            return self.parse_session_window_changed(line);
        }

        // %sessions-changed
        if line == "%sessions-changed" {
            return Some(ControlModeEvent::SessionsChanged);
        }

        // %pause %pane
        if line.starts_with("%pause ") {
            let rest = &line["%pause ".len()..];
            return Some(ControlModeEvent::Pause {
                pane_id: rest.trim().to_string(),
            });
        }

        // %continue %pane
        if line.starts_with("%continue ") {
            let rest = &line["%continue ".len()..];
            return Some(ControlModeEvent::Continue {
                pane_id: rest.trim().to_string(),
            });
        }

        // %client-detached client
        if line.starts_with("%client-detached ") {
            let rest = &line["%client-detached ".len()..];
            return Some(ControlModeEvent::ClientDetached {
                client: rest.trim().to_string(),
            });
        }

        // %client-session-changed client session-id name
        if line.starts_with("%client-session-changed ") {
            return self.parse_client_session_changed(line);
        }

        // %exit [reason]
        if line.starts_with("%exit") {
            let rest = line["%exit".len()..].trim();
            return Some(ControlModeEvent::Exit {
                reason: if rest.is_empty() {
                    None
                } else {
                    Some(rest.to_string())
                },
            });
        }

        // %unlinked-window-add @window
        if line.starts_with("%unlinked-window-add ") {
            let rest = &line["%unlinked-window-add ".len()..];
            return Some(ControlModeEvent::UnlinkedWindowAdd {
                window_id: rest.trim().to_string(),
            });
        }

        // %unlinked-window-close @window
        if line.starts_with("%unlinked-window-close ") {
            let rest = &line["%unlinked-window-close ".len()..];
            return Some(ControlModeEvent::UnlinkedWindowClose {
                window_id: rest.trim().to_string(),
            });
        }

        None
    }

    fn parse_output(&self, line: &str) -> Option<ControlModeEvent> {
        // %output %pane-id value
        let rest = &line["%output ".len()..];

        // Find the space after pane-id
        if let Some(space_idx) = rest.find(' ') {
            let pane_id = rest[..space_idx].to_string();
            let value = &rest[space_idx + 1..];
            let content = decode_octal(value);
            return Some(ControlModeEvent::Output { pane_id, content });
        }

        // No content (empty output)
        Some(ControlModeEvent::Output {
            pane_id: rest.trim().to_string(),
            content: Vec::new(),
        })
    }

    fn parse_extended_output(&self, line: &str) -> Option<ControlModeEvent> {
        // %extended-output %pane-id age ... : value
        let rest = &line["%extended-output ".len()..];
        let parts: Vec<&str> = rest.splitn(2, " : ").collect();

        if parts.len() < 2 {
            return None;
        }

        let header_parts: Vec<&str> = parts[0].split_whitespace().collect();
        if header_parts.is_empty() {
            return None;
        }

        let pane_id = header_parts[0].to_string();
        let age_ms = header_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let content = decode_octal(parts[1]);

        Some(ControlModeEvent::ExtendedOutput {
            pane_id,
            age_ms,
            content,
        })
    }

    fn parse_layout_change(&self, line: &str) -> Option<ControlModeEvent> {
        // %layout-change @window layout visible-layout flags
        let rest = &line["%layout-change ".len()..];
        let parts: Vec<&str> = rest.split_whitespace().collect();

        if parts.len() >= 3 {
            Some(ControlModeEvent::LayoutChange {
                window_id: parts[0].to_string(),
                layout: parts[1].to_string(),
                visible_layout: parts[2].to_string(),
                flags: parts.get(3).unwrap_or(&"").to_string(),
            })
        } else {
            None
        }
    }

    fn parse_window_renamed(&self, line: &str) -> Option<ControlModeEvent> {
        // %window-renamed @window name
        let rest = &line["%window-renamed ".len()..];
        if let Some(space_idx) = rest.find(' ') {
            Some(ControlModeEvent::WindowRenamed {
                window_id: rest[..space_idx].to_string(),
                name: rest[space_idx + 1..].to_string(),
            })
        } else {
            None
        }
    }

    fn parse_window_pane_changed(&self, line: &str) -> Option<ControlModeEvent> {
        // %window-pane-changed @window %pane
        let rest = &line["%window-pane-changed ".len()..];
        let parts: Vec<&str> = rest.split_whitespace().collect();

        if parts.len() >= 2 {
            Some(ControlModeEvent::WindowPaneChanged {
                window_id: parts[0].to_string(),
                pane_id: parts[1].to_string(),
            })
        } else {
            None
        }
    }

    fn parse_session_changed(&self, line: &str) -> Option<ControlModeEvent> {
        // %session-changed $session name
        let rest = &line["%session-changed ".len()..];
        if let Some(space_idx) = rest.find(' ') {
            Some(ControlModeEvent::SessionChanged {
                session_id: rest[..space_idx].to_string(),
                session_name: rest[space_idx + 1..].to_string(),
            })
        } else {
            None
        }
    }

    fn parse_session_window_changed(&self, line: &str) -> Option<ControlModeEvent> {
        // %session-window-changed $session @window
        let rest = &line["%session-window-changed ".len()..];
        let parts: Vec<&str> = rest.split_whitespace().collect();

        if parts.len() >= 2 {
            Some(ControlModeEvent::SessionWindowChanged {
                session_id: parts[0].to_string(),
                window_id: parts[1].to_string(),
            })
        } else {
            None
        }
    }

    fn parse_client_session_changed(&self, line: &str) -> Option<ControlModeEvent> {
        // %client-session-changed client session-id name
        let rest = &line["%client-session-changed ".len()..];
        let parts: Vec<&str> = rest.splitn(3, ' ').collect();

        if parts.len() >= 3 {
            Some(ControlModeEvent::ClientSessionChanged {
                client: parts[0].to_string(),
                session_id: parts[1].to_string(),
                session_name: parts[2].to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_output() {
        let mut parser = Parser::new();
        let event = parser.parse_line("%output %1 Hello World");

        match event {
            Some(ControlModeEvent::Output { pane_id, content }) => {
                assert_eq!(pane_id, "%1");
                assert_eq!(content, b"Hello World");
            }
            _ => panic!("Expected Output event"),
        }
    }

    #[test]
    fn test_parse_output_with_escapes() {
        let mut parser = Parser::new();
        let event = parser.parse_line(r"%output %1 \033[0mHello");

        match event {
            Some(ControlModeEvent::Output { pane_id, content }) => {
                assert_eq!(pane_id, "%1");
                assert_eq!(content, b"\x1b[0mHello");
            }
            _ => panic!("Expected Output event"),
        }
    }

    #[test]
    fn test_parse_layout_change() {
        let mut parser = Parser::new();
        let event = parser.parse_line("%layout-change @0 abc123,80x24,0,0 abc123,80x24,0,0 *");

        match event {
            Some(ControlModeEvent::LayoutChange {
                window_id,
                layout,
                visible_layout,
                flags,
            }) => {
                assert_eq!(window_id, "@0");
                assert_eq!(layout, "abc123,80x24,0,0");
                assert_eq!(visible_layout, "abc123,80x24,0,0");
                assert_eq!(flags, "*");
            }
            _ => panic!("Expected LayoutChange event"),
        }
    }

    #[test]
    fn test_parse_window_add() {
        let mut parser = Parser::new();
        let event = parser.parse_line("%window-add @5");

        match event {
            Some(ControlModeEvent::WindowAdd { window_id }) => {
                assert_eq!(window_id, "@5");
            }
            _ => panic!("Expected WindowAdd event"),
        }
    }

    #[test]
    fn test_parse_command_response() {
        let mut parser = Parser::new();

        // Begin
        assert!(parser.parse_line("%begin 1234567890 0 0").is_none());

        // Response content
        assert!(parser.parse_line("line 1").is_none());
        assert!(parser.parse_line("line 2").is_none());

        // End
        let event = parser.parse_line("%end 1234567890 0 0");

        match event {
            Some(ControlModeEvent::CommandResponse {
                timestamp,
                command_num,
                output,
                success,
            }) => {
                assert_eq!(timestamp, 1234567890);
                assert_eq!(command_num, 0);
                assert_eq!(output, "line 1\nline 2");
                assert!(success);
            }
            _ => panic!("Expected CommandResponse event"),
        }
    }

    #[test]
    fn test_parse_command_error() {
        let mut parser = Parser::new();

        parser.parse_line("%begin 1234567890 1 0");
        parser.parse_line("error message");
        let event = parser.parse_line("%error 1234567890 1 0");

        match event {
            Some(ControlModeEvent::CommandResponse { success, .. }) => {
                assert!(!success);
            }
            _ => panic!("Expected CommandResponse event"),
        }
    }

    #[test]
    fn test_parse_exit() {
        let mut parser = Parser::new();

        let event = parser.parse_line("%exit");
        match event {
            Some(ControlModeEvent::Exit { reason }) => {
                assert!(reason.is_none());
            }
            _ => panic!("Expected Exit event"),
        }

        let event = parser.parse_line("%exit detached");
        match event {
            Some(ControlModeEvent::Exit { reason }) => {
                assert_eq!(reason, Some("detached".to_string()));
            }
            _ => panic!("Expected Exit event"),
        }
    }

    #[test]
    fn test_parse_session_changed() {
        let mut parser = Parser::new();
        let event = parser.parse_line("%session-changed $0 main");

        match event {
            Some(ControlModeEvent::SessionChanged {
                session_id,
                session_name,
            }) => {
                assert_eq!(session_id, "$0");
                assert_eq!(session_name, "main");
            }
            _ => panic!("Expected SessionChanged event"),
        }
    }

    #[test]
    fn test_parse_pane_mode_changed() {
        let mut parser = Parser::new();
        let event = parser.parse_line("%pane-mode-changed %0");

        match event {
            Some(ControlModeEvent::PaneModeChanged { pane_id }) => {
                assert_eq!(pane_id, "%0");
            }
            _ => panic!("Expected PaneModeChanged event"),
        }
    }
}
