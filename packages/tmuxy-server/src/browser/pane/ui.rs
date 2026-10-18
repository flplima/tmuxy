use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::input::{Input, Inputs};
use super::{layout, term, PaneSize, PICTURE_TOP};
use crate::browser::session::Session;
use crate::browser::verbs::{self, Viewport};

/// How to bring this pane back, as the `tmuxy` CLI is told it
/// (`tmuxy pane restore-cmd '<line>' <pane>` → `@tmuxy-pane-restore`, see
/// `tmuxy_core::session_snapshot`).
///
/// The CLI, never tmux directly: a mutating tmux command from inside a pane
/// while control mode is attached crashes tmux 3.5a (docs/TMUX.md), and the
/// CLI is the one place that knows to wrap it in `run-shell`.
///
/// The session is written back only when one was NAMED: the default is the
/// pane's own (`pane-<id>`), and a restored pane has a new id — handing it the
/// old one would make it share a profile with whichever pane has that id now.
pub(super) fn restore_tag_args(
    pane: &str,
    named_session: Option<&str>,
    color_filter: bool,
    viewport: Viewport,
    url: Option<&str>,
) -> Vec<String> {
    let mut line = "tmuxy browser".to_string();
    if let Some(session) = named_session {
        line.push_str(" --session ");
        line.push_str(&shell_quote(session));
    }
    if color_filter {
        line.push_str(" --color-filter");
    }
    if viewport != Viewport::Auto {
        line.push_str(" --viewport ");
        line.push_str(viewport.name());
    }
    if let Some(url) = url {
        line.push(' ');
        line.push_str(&shell_quote(url));
    }
    vec!["pane".into(), "restore-cmd".into(), line, pane.into()]
}

/// Single-quote for a shell, as `_lib`'s `shquote` does.
fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// Record the page this pane is on, if it is running under tmux at all.
///
/// `TMUXY_CLI` is set by the CLI when it starts this program, so the pane
/// reaches the same `tmuxy` that launched it wherever it is installed; a
/// pane started some other way falls back to `tmuxy` on the PATH.
fn announce_restore(
    named_session: Option<&str>,
    color_filter: bool,
    viewport: Viewport,
    url: Option<&str>,
) {
    let Some(pane) = std::env::var_os("TMUX_PANE") else {
        return;
    };
    tmuxy_cli(&restore_tag_args(
        &pane.to_string_lossy(),
        named_session,
        color_filter,
        viewport,
        url,
    ));
}

/// Run the `tmuxy` CLI with these arguments, quietly.
///
/// `TMUXY_CLI` is set by the CLI when it starts this program, so the pane
/// reaches the same `tmuxy` that launched it wherever it is installed; a pane
/// started some other way falls back to `tmuxy` on the PATH.
fn tmuxy_cli(args: &[String]) {
    let cli = std::env::var_os("TMUXY_CLI").unwrap_or_else(|| "tmuxy".into());
    let _ = std::process::Command::new(cli)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// The pane tag that makes the app draw the toolbar over row 1.
pub const LIVE_WIDGET: &str = "browser-live";

/// Tag this pane (or untag it) as a live browser, through the CLI — the same
/// out-of-band authorisation `tmuxy-widget` gives a widget: no output can set
/// it, so no output can put a toolbar over a pane that did not ask for one.
pub(super) fn tag_pane(on: bool) {
    let Some(pane) = std::env::var_os("TMUX_PANE") else {
        return;
    };
    tmuxy_cli(&widget_tag_args(&pane.to_string_lossy(), on));
}

/// Tell the app's address bar where the page is (`@tmuxy-pane-url`), or
/// that it is nowhere. Through the CLI, like the widget tag.
pub(super) fn tag_url(url: Option<&str>) {
    let Some(pane) = std::env::var_os("TMUX_PANE") else {
        return;
    };
    tmuxy_cli(&url_tag_args(&pane.to_string_lossy(), url));
}

pub(super) fn url_tag_args(pane: &str, url: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec!["run".into(), "set-option".into(), "-p".into()];
    if url.is_none() {
        args.push("-u".into());
    }
    args.extend(["-t".into(), pane.into(), "@tmuxy-pane-url".into()]);
    if let Some(url) = url {
        args.push(url.into());
    }
    args
}

pub(super) fn widget_tag_args(pane: &str, on: bool) -> Vec<String> {
    let mut args: Vec<String> = vec!["run".into(), "set-option".into(), "-p".into()];
    if !on {
        args.push("-u".into());
    }
    args.extend(["-t".into(), pane.into(), "@tmuxy-pane-widget".into()]);
    if on {
        args.push(LIVE_WIDGET.into());
    }
    args
}

/// Where the page is and which way history can go: what the toolbar shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Navigation {
    pub(super) url: String,
    pub(super) title: String,
    pub(super) can_go_back: bool,
    pub(super) can_go_forward: bool,
}

/// The toolbar row's text. The UI reads it to know this is a live browser and
/// which buttons are live; the address is the pane title (see the module doc).
/// Kept short so it never wraps into the picture.
pub(super) fn header_line(
    nav: &Navigation,
    color_filter: bool,
    viewport: Viewport,
    repl: bool,
) -> String {
    let bit = |b: bool| if b { '1' } else { '0' };
    let size = match viewport {
        Viewport::Auto => 'a',
        Viewport::Desktop => 'd',
        Viewport::Mobile => 'm',
    };
    format!(
        "{HEADER_PREFIX}{}{}{}{size}{}",
        bit(nav.can_go_back),
        bit(nav.can_go_forward),
        bit(color_filter),
        bit(repl)
    )
}

/// What the toolbar row starts with (`header_line`).
const HEADER_PREFIX: &str = "tmuxy:browser ";

/// Write the toolbar row and the title that carries the address.
pub(super) fn header(
    size: &PaneSize,
    nav: &Navigation,
    color_filter: bool,
    viewport: Viewport,
    repl: bool,
) {
    // The pane is named after the page, the way a browser tab is; the address
    // has a tag of its own (`@tmuxy-pane-url`). A page with no `<title>` is
    // called by its address.
    let name = if nav.title.trim().is_empty() {
        &nav.url
    } else {
        &nav.title
    };
    let title: String = name.chars().filter(|c| !c.is_control()).collect();
    write_out(&format!(
        "\x1b]2;{title}\x07\x1b[1;1H\x1b[2K{}\x1b[{};1H",
        header_line(nav, color_filter, viewport, repl),
        size.rows
    ));
}

/// One write to the terminal, whole: the frame drawer, the toolbar and the
/// status row write from different tasks, and an escape torn in half by
/// another's would land text in the picture.
pub(super) fn write_out(text: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

/// How often the toolbar asks the page where it is. A link followed inside the
/// page moves it without telling anyone, and the address bar should follow.
const NAVIGATION_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// Where the page is now, from the engine's own history.
async fn navigation(page: &chromiumoxide::page::Page) -> Option<Navigation> {
    use chromiumoxide::cdp::browser_protocol::page::GetNavigationHistoryParams;
    let history = page
        .execute(GetNavigationHistoryParams::default())
        .await
        .ok()?
        .result
        .clone();
    let index = usize::try_from(history.current_index).ok()?;
    let entry = history.entries.get(index)?;
    Some(Navigation {
        url: entry.url.clone(),
        title: entry.title.clone(),
        can_go_back: history.entries[..index].iter().any(|e| is_page(&e.url)),
        can_go_forward: index + 1 < history.entries.len(),
    })
}

/// A history entry worth going back to. Every tab starts on `about:blank`, so
/// the first page a pane opens would otherwise offer "back" to nothing.
pub(super) fn is_page(url: &str) -> bool {
    !url.is_empty() && url != "about:blank"
}

/// Keep the toolbar row and the address current: on a navigation, and after a
/// resize (which clears nothing, but tmux reflows the row).
pub(super) async fn header_loop(
    page: chromiumoxide::page::Page,
    mut size: tokio::sync::watch::Receiver<PaneSize>,
    mut viewport: tokio::sync::watch::Receiver<Viewport>,
    mut repl: tokio::sync::watch::Receiver<bool>,
    color_filter: bool,
    named_session: Option<String>,
    done: Arc<AtomicBool>,
) {
    let mut shown: Option<Navigation> = None;
    loop {
        if done.load(Ordering::Relaxed) {
            return;
        }
        let resized = size.has_changed().unwrap_or(false);
        let resized_page = viewport.has_changed().unwrap_or(false);
        let view_flipped = repl.has_changed().unwrap_or(false);
        let current = *size.borrow_and_update();
        let current_viewport = *viewport.borrow_and_update();
        let current_repl = *repl.borrow_and_update();
        if let Some(nav) = navigation(&page).await {
            let moved = shown.as_ref().map(|n| &n.url) != Some(&nav.url);
            if resized || resized_page || view_flipped || shown.as_ref() != Some(&nav) {
                header(&current, &nav, color_filter, current_viewport, current_repl);
            }
            if moved || resized_page {
                // The page moved, by a verb or by a link inside it, or changed
                // size; the address bar and the restore tag follow it.
                let url = is_page(&nav.url).then_some(nav.url.as_str());
                if moved {
                    tag_url(url);
                }
                announce_restore(
                    named_session.as_deref(),
                    color_filter,
                    current_viewport,
                    url,
                );
            }
            shown = Some(nav);
        }
        tokio::time::sleep(NAVIGATION_POLL).await;
    }
}

/// What the pane shows besides the picture: the page's size, whether the
/// REPL view is up, and the log it shows.
pub(super) struct View {
    pub(super) viewport: tokio::sync::watch::Sender<Viewport>,
    pub(super) repl: tokio::sync::watch::Sender<bool>,
    pub(super) log: ReplLog,
}

impl View {
    pub(super) fn showing_repl(&self) -> bool {
        *self.repl.borrow()
    }

    /// Show the REPL view or the picture. Showing the log clears the screen,
    /// which is what retires the picture (docs/RICH-RENDERING.md); the frame
    /// drawer paints the picture again as soon as the view goes.
    fn set_repl(&mut self, size: &PaneSize, on: bool) {
        if self.showing_repl() == on {
            return;
        }
        self.repl.send_replace(on);
        if on {
            write_out(term::CLEAR);
            self.redraw(size);
        }
    }

    /// Draw the log between the toolbar row and the status row.
    pub(super) fn redraw(&self, size: &PaneSize) {
        write_out(&self.log.render(size));
    }
}

/// The REPL view's log: what was typed at the prompt and what came back,
/// newest last. Kept whether or not the view is up, so flipping it shows what
/// an agent has been doing in the pane.
#[derive(Clone, Default)]
pub(super) struct ReplLog(Arc<std::sync::Mutex<std::collections::VecDeque<String>>>);

const REPL_LOG_LINES: usize = 500;

impl ReplLog {
    pub(super) fn push(&self, text: &str) {
        let Ok(mut lines) = self.0.lock() else {
            return;
        };
        for line in text.lines() {
            lines.push_back(line.to_string());
        }
        while lines.len() > REPL_LOG_LINES {
            lines.pop_front();
        }
    }

    /// The escape that paints the log's tail into rows 2..rows-1, leaving the
    /// toolbar row and the status row alone.
    fn render(&self, size: &PaneSize) -> String {
        let width = usize::from(size.cols.max(1));
        let body_rows = usize::from(size.rows.saturating_sub(2));
        let lines = self.0.lock().map(|l| l.clone()).unwrap_or_default();
        let shown: Vec<String> = lines
            .iter()
            .rev()
            .take(body_rows)
            .map(|line| line.chars().take(width).collect::<String>())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let mut out = String::new();
        for row in 0..body_rows {
            let text = shown.get(row).map(String::as_str).unwrap_or("");
            out.push_str(&format!(
                "\x1b[{};1H\x1b[2K{text}",
                row + usize::from(PICTURE_TOP)
            ));
        }
        out
    }
}

pub(super) enum CommandOutcome {
    Continue,
    Quit,
}

/// Read a verb line on the status row and run it.
///
/// A line editor rather than a key-at-a-time forward: this is the one place the
/// user is typing AT tmuxy rather than at the page, so it behaves like a prompt.
pub(super) async fn command_mode(
    session: &mut Session,
    size: PaneSize,
    view: &mut View,
    inputs: &mut Inputs,
    first: Option<Vec<u8>>,
) -> CommandOutcome {
    let mut line = String::new();
    let mut pending = first;
    loop {
        // Only redraw the prompt when nothing is already waiting: a whole line
        // pasted or typed fast would otherwise repaint the status row once per
        // character.
        if pending.is_none() && !inputs.has_ready() {
            status(&size, &format!(":{line}"));
        }
        let key = match pending.take() {
            Some(key) => key,
            None => {
                let Some(input) = inputs.next().await else {
                    return CommandOutcome::Quit;
                };
                let Input::Key(key) = input else { continue };
                key
            }
        };
        match key.as_slice() {
            b"\x03" => return CommandOutcome::Quit,
            b"\x1b" => {
                status(&size, "");
                return CommandOutcome::Continue;
            }
            b"\r" | b"\n" => return run_line(session, size, view, &line).await,
            b"\x7f" | b"\x08" => {
                line.pop();
            }
            other => {
                if let Ok(text) = std::str::from_utf8(other) {
                    if !text.chars().any(char::is_control) {
                        line.push_str(text);
                    }
                }
            }
        }
    }
}

/// Run one verb line and show what it said.
async fn run_line(
    session: &mut Session,
    size: PaneSize,
    view: &mut View,
    line: &str,
) -> CommandOutcome {
    if matches!(line.trim(), "q" | "quit" | "exit") {
        return CommandOutcome::Quit;
    }
    view.log.push(&format!(":{line}"));
    // The status row is one line, and an agent reading it back with
    // `capture-pane` wants the answer, not a paragraph; the log keeps it whole.
    let answer: String = match verbs::parse(line) {
        // The pane's own verbs: where the picture sits, and whether it is the
        // picture or the log that is shown, are this program's call.
        Ok(verbs::Verb::Viewport { viewport: next }) => {
            // No clear: the new picture covers the old one, and the image
            // parser retires a picture another is drawn over.
            view.viewport.send_replace(next);
            let page = layout(size, next);
            match session
                .set_viewport(page.page_w, page.page_h, next == Viewport::Mobile)
                .await
            {
                Ok(()) => next.name().to_string(),
                Err(error) => format!("error: {error}"),
            }
        }
        Ok(verbs::Verb::Repl { on }) => {
            let on = on.unwrap_or(!view.showing_repl());
            view.set_repl(&size, on);
            if on {
                "repl on".to_string()
            } else {
                "repl off".to_string()
            }
        }
        Ok(verb) => match session.run(verb).await {
            Ok(output) => output.to_string(),
            Err(error) => format!("error: {error}"),
        },
        Err(verbs::ParseError::Empty) => String::new(),
        Err(error) => format!("error: {error}"),
    };
    view.log.push(&answer);
    if view.showing_repl() {
        view.redraw(&size);
    }
    status(&size, answer.lines().next().unwrap_or(""));
    CommandOutcome::Continue
}

/// Write the status row, leaving the picture alone.
pub(super) fn status(size: &PaneSize, text: &str) {
    let width = usize::from(size.cols);
    let shown: String = text.chars().take(width).collect();
    // Move to the status row, clear it, write, and leave the cursor there.
    write_out(&format!("\x1b[{};1H\x1b[2K{}", size.rows, shown));
}
