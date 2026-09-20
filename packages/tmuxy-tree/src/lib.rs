//! `tmuxy tree` — a standalone tab/pane tree-view TUI (run in any terminal pane).
//!
//! Renders every tmuxy tab with its panes as children. Navigate with j/k or the
//! arrow keys; Enter or a left-click activates the selected tab/pane (which
//! propagates to the web UI through normal control-mode state sync). The tree
//! auto-refreshes as tabs/panes change.
//!
//! This is what `tmuxy tree`
//! launches standalone in any terminal pane. It shells out to the `tmuxy` CLI
//! (`tab list --json` / `pane list --json --all`) so it always reflects the
//! same "tabs" the rest of tmuxy sees (hidden windows already filtered out).

use std::io::{self, Stdout};
use std::process::Command;
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
    MouseButton, MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState};
use ratatui::{Terminal, TerminalOptions, Viewport};
use serde::Deserialize;

const REFRESH_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Deserialize)]
struct TabJson {
    id: String,
    index: u32,
    name: String,
    active: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct PaneJson {
    id: String,
    tab: String,
    command: String,
    /// App-set pane title (OSC 0/2); empty when the app never set one.
    #[serde(default)]
    title: String,
    active: bool,
}

/// One visible line in the flattened tree (a tab header or one of its panes).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Row {
    Tab {
        window_id: String,
        label: String,
        active: bool,
    },
    Pane {
        window_id: String,
        pane_id: String,
        label: String,
        active: bool,
    },
}

impl Row {
    /// Stable identity used to preserve the cursor across refreshes.
    fn key(&self) -> &str {
        match self {
            Row::Tab { window_id, .. } => window_id,
            Row::Pane { pane_id, .. } => pane_id,
        }
    }
}

/// Run the CLI and return stdout, or an empty string on any failure (degraded
/// but non-fatal — the next refresh tick retries).
fn cli_json(args: &[&str]) -> String {
    match Command::new("tmuxy").args(args).output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    }
}

/// Build the flattened tree from the CLI JSON. Tabs in index order, each
/// immediately followed by its panes.
fn fetch_rows() -> Vec<Row> {
    let tabs: Vec<TabJson> =
        serde_json::from_str(&cli_json(&["tab", "list", "--json"])).unwrap_or_default();
    let panes: Vec<PaneJson> =
        serde_json::from_str(&cli_json(&["pane", "list", "--json", "--all"])).unwrap_or_default();
    build_rows(tabs, panes)
}

/// Flatten tabs and panes into the rendered row order. Split out from
/// `fetch_rows` so the ordering and labelling rules can be tested without
/// shelling out to the `tmuxy` CLI — which, run from a test, would read and
/// drive the user's live tmux server.
fn build_rows(mut tabs: Vec<TabJson>, panes: Vec<PaneJson>) -> Vec<Row> {
    tabs.sort_by_key(|t| t.index);

    let mut rows = Vec::new();
    for tab in &tabs {
        let name = if tab.name.is_empty() {
            tab.id.clone()
        } else {
            tab.name.clone()
        };
        rows.push(Row::Tab {
            window_id: tab.id.clone(),
            label: format!("{}: {}", tab.index, name),
            active: tab.active,
        });
        for pane in panes.iter().filter(|p| p.tab == tab.id) {
            rows.push(Row::Pane {
                window_id: tab.id.clone(),
                pane_id: pane.id.clone(),
                // The app's own title wins over the executable's file name,
                // which can be meaningless on its own (a version-pinned
                // launcher symlink reports e.g. `2.1.251`).
                label: format!(
                    "{} {}",
                    pane.id,
                    if pane.title.is_empty() {
                        &pane.command
                    } else {
                        &pane.title
                    }
                ),
                active: pane.active,
            });
        }
    }
    rows
}

/// Best-effort activation of the selected row. Routes through the `tmuxy` CLI so
/// the mutating commands go through run-shell (safe with control mode).
fn activate(row: &Row) {
    let window_id = match row {
        Row::Tab { window_id, .. } | Row::Pane { window_id, .. } => window_id,
    };
    let _ = Command::new("tmuxy")
        .args(["tab", "select", window_id])
        .status();
    if let Row::Pane { pane_id, .. } = row {
        let _ = Command::new("tmuxy")
            .args(["pane", "select", pane_id])
            .status();
    }
}

struct App {
    rows: Vec<Row>,
    state: ListState,
    /// Inner content rect of the list from the last draw (for mouse hit-testing).
    list_area: Rect,
}

impl App {
    fn new() -> Self {
        Self::from_rows(fetch_rows())
    }

    fn from_rows(rows: Vec<Row>) -> Self {
        let mut state = ListState::default();
        if !rows.is_empty() {
            state.select(Some(0));
        }
        App {
            rows,
            state,
            list_area: Rect::default(),
        }
    }

    fn move_down(&mut self) {
        if self.rows.is_empty() {
            return;
        }
        let next = match self.state.selected() {
            Some(i) if i + 1 < self.rows.len() => i + 1,
            Some(i) => i,
            None => 0,
        };
        self.state.select(Some(next));
    }

    fn move_up(&mut self) {
        if self.rows.is_empty() {
            return;
        }
        let prev = match self.state.selected() {
            Some(i) if i > 0 => i - 1,
            _ => 0,
        };
        self.state.select(Some(prev));
    }

    fn activate_selected(&self) {
        if let Some(i) = self.state.selected() {
            if let Some(row) = self.rows.get(i) {
                activate(row);
            }
        }
    }

    /// Re-fetch rows, preserving the cursor on the same node when possible.
    fn refresh(&mut self) {
        self.adopt(fetch_rows());
    }

    /// Replace the rows, keeping the cursor on the same node when it survived.
    fn adopt(&mut self, new_rows: Vec<Row>) {
        let selected_key = self
            .state
            .selected()
            .and_then(|i| self.rows.get(i))
            .map(|r| r.key().to_string());
        if new_rows == self.rows {
            return;
        }
        self.rows = new_rows;
        if self.rows.is_empty() {
            self.state.select(None);
            return;
        }
        let new_index = selected_key
            .and_then(|key| self.rows.iter().position(|r| r.key() == key))
            .unwrap_or(0)
            .min(self.rows.len() - 1);
        self.state.select(Some(new_index));
    }

    /// Map a click at `mouse_row` to a row index, using the last-drawn area and
    /// the list's scroll offset.
    fn row_at(&self, mouse_row: u16) -> Option<usize> {
        if mouse_row < self.list_area.y {
            return None;
        }
        let rel = (mouse_row - self.list_area.y) as usize;
        let idx = self.state.offset() + rel;
        if idx < self.rows.len() {
            Some(idx)
        } else {
            None
        }
    }
}

type TreeTerminal = Terminal<ratatui::backend::CrosstermBackend<Stdout>>;

fn run_app(terminal: &mut TreeTerminal) -> io::Result<()> {
    let mut app = App::new();
    let mut last_refresh = Instant::now();

    loop {
        terminal.draw(|f| draw(f, &mut app))?;

        let timeout = REFRESH_INTERVAL.saturating_sub(last_refresh.elapsed());
        if event::poll(timeout)? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                    KeyCode::Char('q') => return Ok(()),
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        return Ok(())
                    }
                    KeyCode::Char('j') | KeyCode::Down => app.move_down(),
                    KeyCode::Char('k') | KeyCode::Up => app.move_up(),
                    KeyCode::Enter => app.activate_selected(),
                    _ => {}
                },
                Event::Mouse(m) => match m.kind {
                    MouseEventKind::Down(MouseButton::Left) => {
                        if let Some(idx) = app.row_at(m.row) {
                            app.state.select(Some(idx));
                            app.activate_selected();
                        }
                    }
                    MouseEventKind::ScrollDown => app.move_down(),
                    MouseEventKind::ScrollUp => app.move_up(),
                    _ => {}
                },
                _ => {}
            }
        }

        if last_refresh.elapsed() >= REFRESH_INTERVAL {
            app.refresh();
            last_refresh = Instant::now();
        }
    }
}

fn draw(f: &mut ratatui::Frame, app: &mut App) {
    let area = f.area();
    let block = Block::default().borders(Borders::NONE);
    let inner = block.inner(area);
    app.list_area = inner;

    if app.rows.is_empty() {
        let items = [ListItem::new(Line::from(Span::styled(
            "no tabs",
            Style::default().fg(Color::DarkGray),
        )))];
        f.render_widget(List::new(items).block(block), area);
        return;
    }

    let items: Vec<ListItem> = app
        .rows
        .iter()
        .map(|row| {
            let (text, active) = match row {
                Row::Tab { label, active, .. } => (format!("▸ {label}"), *active),
                Row::Pane { label, active, .. } => (format!("   {label}"), *active),
            };
            let mut style = Style::default();
            if matches!(row, Row::Tab { .. }) {
                style = style.add_modifier(Modifier::BOLD);
            }
            if active {
                style = style.fg(Color::Green);
            }
            ListItem::new(Line::from(Span::styled(text, style)))
        })
        .collect();

    let list = List::new(items).block(block).highlight_style(
        Style::default()
            .bg(Color::Blue)
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    );
    f.render_stateful_widget(list, area, &mut app.state);
}

/// Entry point for `tmuxy tree`. Sets up the terminal,
/// runs the event loop, and always restores the terminal on exit.
pub fn run_tree_tui() -> io::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = ratatui::backend::CrosstermBackend::new(stdout);
    let mut terminal = Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Fullscreen,
        },
    )?;

    let res = run_app(&mut terminal);

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    res
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn tab(id: &str, index: u32, name: &str, active: bool) -> TabJson {
        TabJson {
            id: id.to_string(),
            index,
            name: name.to_string(),
            active,
        }
    }

    fn pane(id: &str, tab: &str, command: &str, title: &str, active: bool) -> PaneJson {
        PaneJson {
            id: id.to_string(),
            tab: tab.to_string(),
            command: command.to_string(),
            title: title.to_string(),
            active,
        }
    }

    #[test]
    fn the_tree_reads_top_to_bottom_in_tab_order_with_each_tabs_panes_under_it() {
        // The CLI answers in whatever order tmux listed the windows; the tree
        // is ordered by the index the user sees on the tab strip.
        let rows = build_rows(
            vec![tab("@2", 1, "second", false), tab("@1", 0, "first", true)],
            vec![
                pane("%3", "@2", "nvim", "", false),
                pane("%1", "@1", "zsh", "", true),
                pane("%2", "@1", "less", "", false),
            ],
        );
        let labels: Vec<&str> = rows
            .iter()
            .map(|r| match r {
                Row::Tab { label, .. } | Row::Pane { label, .. } => label.as_str(),
            })
            .collect();
        assert_eq!(
            labels,
            vec!["0: first", "%1 zsh", "%2 less", "1: second", "%3 nvim"]
        );
        // A pane row carries its tab's id too, so activating it selects the
        // right window first.
        match &rows[1] {
            Row::Pane { window_id, .. } => assert_eq!(window_id, "@1"),
            other => panic!("expected a pane row, got {other:?}"),
        }
    }

    #[test]
    fn a_pane_that_set_its_own_title_shows_that_instead_of_its_command() {
        // A version-pinned launcher symlink reports a command like `2.1.251`,
        // which tells the user nothing.
        let rows = build_rows(
            vec![tab("@1", 0, "main", true)],
            vec![
                pane("%1", "@1", "2.1.251", "claude", false),
                pane("%2", "@1", "zsh", "", false),
            ],
        );
        let labels: Vec<&str> = rows
            .iter()
            .skip(1)
            .map(|r| match r {
                Row::Pane { label, .. } => label.as_str(),
                other => panic!("expected a pane row, got {other:?}"),
            })
            .collect();
        assert_eq!(labels, vec!["%1 claude", "%2 zsh"]);
    }

    #[test]
    fn an_unnamed_tab_falls_back_to_its_window_id() {
        let rows = build_rows(vec![tab("@7", 3, "", false)], vec![]);
        match &rows[0] {
            Row::Tab { label, .. } => assert_eq!(label, "3: @7"),
            other => panic!("expected a tab row, got {other:?}"),
        }
    }

    #[test]
    fn a_pane_belonging_to_no_listed_tab_is_left_out() {
        // `pane list --all` includes stash panes whose window is not a tab.
        let rows = build_rows(
            vec![tab("@1", 0, "main", true)],
            vec![pane("%9", "@99", "zsh", "", false)],
        );
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn the_cursor_stays_on_the_same_pane_when_a_tab_is_added_above_it() {
        let mut app = App::from_rows(build_rows(
            vec![tab("@2", 1, "second", false)],
            vec![pane("%3", "@2", "nvim", "", false)],
        ));
        app.move_down();
        assert_eq!(app.state.selected(), Some(1));

        // A tab appears at index 0, pushing everything down a row.
        app.adopt(build_rows(
            vec![tab("@1", 0, "first", true), tab("@2", 1, "second", false)],
            vec![
                pane("%1", "@1", "zsh", "", true),
                pane("%3", "@2", "nvim", "", false),
            ],
        ));
        match &app.rows[app.state.selected().unwrap()] {
            Row::Pane { pane_id, .. } => assert_eq!(pane_id, "%3"),
            other => panic!("the cursor moved to {other:?} instead of staying on %3"),
        }
    }

    #[test]
    fn the_cursor_falls_back_to_the_top_when_its_row_is_gone() {
        let mut app = App::from_rows(build_rows(
            vec![tab("@1", 0, "main", true)],
            vec![
                pane("%1", "@1", "zsh", "", true),
                pane("%2", "@1", "less", "", false),
            ],
        ));
        app.move_down();
        app.move_down();
        assert_eq!(app.state.selected(), Some(2));

        app.adopt(build_rows(
            vec![tab("@1", 0, "main", true)],
            vec![pane("%1", "@1", "zsh", "", true)],
        ));
        assert_eq!(app.state.selected(), Some(0));

        // An empty tree has nothing to select, and must not index past the end.
        app.adopt(Vec::new());
        assert_eq!(app.state.selected(), None);
        app.move_down();
        app.move_up();
        assert_eq!(app.state.selected(), None);
    }

    #[test]
    fn the_cursor_stops_at_both_ends_of_the_tree() {
        let mut app = App::from_rows(build_rows(
            vec![tab("@1", 0, "main", true)],
            vec![pane("%1", "@1", "zsh", "", true)],
        ));
        app.move_up();
        assert_eq!(app.state.selected(), Some(0));
        app.move_down();
        app.move_down();
        assert_eq!(app.state.selected(), Some(1), "walked off the end");
    }

    #[test]
    fn a_click_lands_on_the_row_drawn_under_the_pointer() {
        let mut app = App::from_rows(build_rows(
            vec![tab("@1", 0, "main", true)],
            vec![
                pane("%1", "@1", "zsh", "", true),
                pane("%2", "@1", "less", "", false),
            ],
        ));
        app.list_area = Rect::new(0, 2, 30, 10);

        assert_eq!(app.row_at(2), Some(0));
        assert_eq!(app.row_at(4), Some(2));
        // Above the list, and below the last row: nothing to select.
        assert_eq!(app.row_at(1), None);
        assert_eq!(app.row_at(9), None);
    }
}
