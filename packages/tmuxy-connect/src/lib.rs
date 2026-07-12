//! `tmuxy connect` — a small form TUI to add a tmux *server* (the local machine
//! or a remote SSH host) to the desktop app's sidebar server picker.
//!
//! The desktop app opens this in a float when the user clicks "Add server". The
//! user picks Localhost or SSH, fills in the SSH fields when relevant, and a
//! tmux socket name (defaulting to the dedicated `tmuxy` socket). On save the
//! entry is appended to `~/.config/tmuxy/servers.json` (via
//! [`tmuxy_core::servers`]) and its id is printed to stdout; the picker shows it
//! next time it opens. Cancelling adds nothing.
//!
//! Keyboard-driven (it renders inside a tmux pane): Tab/↑/↓ move between fields,
//! ←/→/Space toggle Localhost⇄SSH, Enter saves, Esc cancels.

use std::io::{self, Stdout};

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Terminal;

use tmuxy_core::servers::{add_server, Server, ServerKind, SshConfig};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Local,
    Ssh,
}

/// The individual inputs. The visible set depends on [`Kind`].
#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Kind,
    Label,
    Host,
    User,
    Port,
    Options,
    Socket,
}

impl Field {
    fn label(self) -> &'static str {
        match self {
            Field::Kind => "Server",
            Field::Label => "Label",
            Field::Host => "SSH host",
            Field::User => "SSH user",
            Field::Port => "SSH port",
            Field::Options => "SSH options",
            Field::Socket => "tmux socket",
        }
    }

    fn placeholder(self) -> &'static str {
        match self {
            Field::Label => "(optional — defaults to the destination)",
            Field::Host => "hostname or IP (required)",
            Field::User => "(optional)",
            Field::Port => "(optional — 22)",
            Field::Options => "(optional — e.g. -i ~/.ssh/id_ed25519)",
            Field::Socket => "tmuxy",
            Field::Kind => "",
        }
    }
}

struct Form {
    kind: Kind,
    label: String,
    host: String,
    user: String,
    port: String,
    options: String,
    socket: String,
    /// Index into [`Form::visible_fields`].
    focus: usize,
    error: Option<String>,
}

impl Form {
    fn new() -> Self {
        Form {
            kind: Kind::Local,
            label: String::new(),
            host: String::new(),
            user: String::new(),
            port: String::new(),
            options: String::new(),
            socket: String::new(),
            focus: 0,
            error: None,
        }
    }

    /// The fields shown right now — SSH inputs only appear for an SSH server.
    fn visible_fields(&self) -> Vec<Field> {
        let mut v = vec![Field::Kind, Field::Label];
        if self.kind == Kind::Ssh {
            v.extend([Field::Host, Field::User, Field::Port, Field::Options]);
        }
        v.push(Field::Socket);
        v
    }

    fn focused_field(&self) -> Field {
        let fields = self.visible_fields();
        fields[self.focus.min(fields.len() - 1)]
    }

    /// Mutable handle to the focused text field's buffer, if it is a text field
    /// (the Kind toggle has no buffer).
    fn focused_buffer(&mut self) -> Option<&mut String> {
        match self.focused_field() {
            Field::Kind => None,
            Field::Label => Some(&mut self.label),
            Field::Host => Some(&mut self.host),
            Field::User => Some(&mut self.user),
            Field::Port => Some(&mut self.port),
            Field::Options => Some(&mut self.options),
            Field::Socket => Some(&mut self.socket),
        }
    }

    fn move_focus(&mut self, delta: isize) {
        let len = self.visible_fields().len() as isize;
        let next = (self.focus as isize + delta).rem_euclid(len);
        self.focus = next as usize;
    }

    fn toggle_kind(&mut self) {
        self.kind = match self.kind {
            Kind::Local => Kind::Ssh,
            Kind::Ssh => Kind::Local,
        };
        // The visible-field set changed; keep focus in range.
        let len = self.visible_fields().len();
        self.focus = self.focus.min(len - 1);
    }

    fn type_char(&mut self, c: char) {
        let numeric = self.focused_field() == Field::Port;
        if let Some(buf) = self.focused_buffer() {
            if numeric {
                if c.is_ascii_digit() && buf.len() < 5 {
                    buf.push(c);
                }
            } else {
                buf.push(c);
            }
        }
    }

    fn backspace(&mut self) {
        if let Some(buf) = self.focused_buffer() {
            buf.pop();
        }
    }

    /// Validate and assemble a [`Server`] from the current inputs.
    fn build_server(&self) -> Result<Server, String> {
        let socket = trimmed_or(&self.socket, "tmuxy");
        match self.kind {
            Kind::Local => {
                let default_label = if socket == "tmuxy" {
                    "localhost".to_string()
                } else {
                    socket.clone()
                };
                let id = if socket == "tmuxy" {
                    "localhost".to_string()
                } else {
                    format!("local-{}", slug(&socket))
                };
                Ok(Server {
                    id,
                    label: non_empty(&self.label).unwrap_or(default_label),
                    kind: ServerKind::Local,
                    ssh: None,
                    socket,
                    session: None,
                    extra: serde_json::Map::new(),
                })
            }
            Kind::Ssh => {
                let host = self.host.trim();
                if host.is_empty() {
                    return Err("SSH host is required".to_string());
                }
                let user = non_empty(&self.user);
                let port = match self.port.trim() {
                    "" => None,
                    p => match p.parse::<u16>() {
                        Ok(0) | Err(_) => return Err("Port must be 1–65535".to_string()),
                        Ok(n) => Some(n),
                    },
                };
                let dest = match &user {
                    Some(u) => format!("{u}@{host}"),
                    None => host.to_string(),
                };
                Ok(Server {
                    id: format!("ssh-{}-{}", slug(&dest), slug(&socket)),
                    label: non_empty(&self.label).unwrap_or(dest),
                    kind: ServerKind::Ssh,
                    ssh: Some(SshConfig {
                        host: host.to_string(),
                        user,
                        port,
                        options: non_empty(&self.options),
                    }),
                    socket,
                    session: None,
                    extra: serde_json::Map::new(),
                })
            }
        }
    }

    /// Attempt to save. On success returns the new server's id; on validation
    /// or write failure records the message in `self.error` and returns None.
    fn submit(&mut self) -> Option<String> {
        let server = match self.build_server() {
            Ok(s) => s,
            Err(e) => {
                self.error = Some(e);
                return None;
            }
        };
        let id = server.id.clone();
        match add_server(server) {
            Ok(_) => Some(id),
            Err(e) => {
                self.error = Some(format!("Could not save: {e}"));
                None
            }
        }
    }
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn trimmed_or(s: &str, fallback: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        fallback.to_string()
    } else {
        t.to_string()
    }
}

/// Lowercase alnum, everything else collapsed to `-`, trimmed — for ids.
fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

type ConnectTerminal = Terminal<ratatui::backend::CrosstermBackend<Stdout>>;

/// The event loop. Returns `Some(id)` if a server was saved, `None` if
/// cancelled.
fn run_app(terminal: &mut ConnectTerminal) -> io::Result<Option<String>> {
    let mut form = Form::new();

    loop {
        terminal.draw(|f| draw(f, &form))?;

        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }

        // Any keypress clears a stale error so the user sees their edit land.
        form.error = None;

        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(None),
            KeyCode::Enter => {
                if let Some(id) = form.submit() {
                    return Ok(Some(id));
                }
            }
            KeyCode::Tab | KeyCode::Down => form.move_focus(1),
            KeyCode::BackTab | KeyCode::Up => form.move_focus(-1),
            KeyCode::Left | KeyCode::Right | KeyCode::Char(' ')
                if form.focused_field() == Field::Kind =>
            {
                form.toggle_kind()
            }
            KeyCode::Backspace => form.backspace(),
            KeyCode::Char(c) => form.type_char(c),
            _ => {}
        }
    }
}

fn draw(f: &mut ratatui::Frame, form: &Form) {
    let outer = Block::default()
        .borders(Borders::ALL)
        .title(" tmuxy connect — add a server ");
    let inner = outer.inner(f.area());
    f.render_widget(outer, f.area());

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(4)])
        .split(inner);

    // Fields.
    let fields = form.visible_fields();
    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(""));
    for (i, field) in fields.iter().enumerate() {
        let focused = i == form.focus;
        lines.push(field_line(form, *field, focused));
    }
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), chunks[0]);

    // Footer: the socket note, keybindings, and any error.
    let mut footer: Vec<Line> = Vec::new();
    if let Some(err) = &form.error {
        footer.push(Line::from(Span::styled(
            format!("⚠ {err}"),
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )));
    } else {
        footer.push(Line::from(Span::styled(
            "Note: tmuxy uses its own 'tmuxy' socket; your normal tmux is the 'default' socket.",
            Style::default().fg(Color::DarkGray),
        )));
    }
    footer.push(Line::from(Span::styled(
        "Tab/↑↓ move · ←/→/Space toggle server · Enter save · Esc cancel",
        Style::default().fg(Color::DarkGray),
    )));
    f.render_widget(Paragraph::new(footer).wrap(Wrap { trim: false }), chunks[1]);
}

/// One field row: `▶ Label:  value` with focus highlight and a cursor caret.
fn field_line<'a>(form: &'a Form, field: Field, focused: bool) -> Line<'a> {
    let marker = if focused { "▶ " } else { "  " };
    let label = format!("{:>12}", field.label());

    let mut spans = vec![
        Span::styled(
            marker,
            Style::default().fg(if focused { Color::Green } else { Color::Reset }),
        ),
        Span::styled(
            format!("{label}: "),
            Style::default().add_modifier(Modifier::BOLD),
        ),
    ];

    if field == Field::Kind {
        let (local_style, ssh_style) = match form.kind {
            Kind::Local => (selected_style(), unselected_style()),
            Kind::Ssh => (unselected_style(), selected_style()),
        };
        spans.push(Span::styled(" Localhost ", local_style));
        spans.push(Span::raw("  "));
        spans.push(Span::styled(" SSH ", ssh_style));
        return Line::from(spans);
    }

    let value = match field {
        Field::Label => &form.label,
        Field::Host => &form.host,
        Field::User => &form.user,
        Field::Port => &form.port,
        Field::Options => &form.options,
        Field::Socket => &form.socket,
        Field::Kind => "",
    };

    if value.is_empty() {
        spans.push(Span::styled(
            field.placeholder().to_string(),
            Style::default().fg(Color::DarkGray),
        ));
    } else {
        spans.push(Span::raw(value));
    }
    if focused {
        spans.push(Span::styled(
            "▏",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::RAPID_BLINK),
        ));
    }
    Line::from(spans)
}

fn selected_style() -> Style {
    Style::default()
        .bg(Color::Green)
        .fg(Color::Black)
        .add_modifier(Modifier::BOLD)
}

fn unselected_style() -> Style {
    Style::default().fg(Color::DarkGray)
}

/// Entry point for `tmuxy connect`. Sets up the terminal, runs the form, and
/// always restores the terminal on exit. Returns the saved server id, or `None`
/// if the user cancelled.
pub fn run_connect_tui() -> io::Result<Option<String>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = ratatui::backend::CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let res = run_app(&mut terminal);

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_form() -> Form {
        Form::new()
    }

    #[test]
    fn local_default_builds_localhost() {
        let server = local_form()
            .build_server()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(server.id, "localhost");
        assert_eq!(server.label, "localhost");
        assert_eq!(server.socket, "tmuxy");
        assert!(matches!(server.kind, ServerKind::Local));
    }

    #[test]
    fn local_custom_socket_ids_and_labels_by_socket() {
        let mut form = local_form();
        form.socket = "default".to_string();
        let server = form.build_server().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(server.id, "local-default");
        assert_eq!(server.label, "default");
    }

    #[test]
    fn ssh_requires_host() {
        let mut form = local_form();
        form.kind = Kind::Ssh;
        assert!(form.build_server().is_err());
    }

    #[test]
    fn ssh_builds_with_user_host_and_default_socket() {
        let mut form = local_form();
        form.kind = Kind::Ssh;
        form.host = "box".to_string();
        form.user = "felipe".to_string();
        let server = form.build_server().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(server.id, "ssh-felipe-box-tmuxy");
        assert_eq!(server.label, "felipe@box");
        assert_eq!(server.socket, "tmuxy");
        let (_, ssh) = server.connect_env();
        assert_eq!(ssh.as_deref(), Some("felipe@box"));
    }

    #[test]
    fn ssh_rejects_bad_port() {
        let mut form = local_form();
        form.kind = Kind::Ssh;
        form.host = "box".to_string();
        form.port = "0".to_string();
        assert!(form.build_server().is_err());
    }

    #[test]
    fn port_field_accepts_digits_only() {
        let mut form = local_form();
        form.kind = Kind::Ssh;
        // focus the Port field
        let fields = form.visible_fields();
        form.focus = fields.iter().position(|f| *f == Field::Port).unwrap_or(0);
        form.type_char('2');
        form.type_char('a');
        form.type_char('2');
        assert_eq!(form.port, "22");
    }

    #[test]
    fn toggling_kind_keeps_focus_in_range() {
        let mut form = local_form();
        form.kind = Kind::Ssh;
        form.focus = form.visible_fields().len() - 1; // Socket, the last SSH-form field
        form.toggle_kind(); // back to Local — fewer fields
        assert!(form.focus < form.visible_fields().len());
    }
}
