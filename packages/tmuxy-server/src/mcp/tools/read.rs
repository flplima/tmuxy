use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tmuxy_core::{CommandError, PaneId};
use tokio::time::Instant;

use super::super::tmux::Tmux;
use super::super::Caller;
use super::timeout;

pub(in crate::mcp) async fn status(tmux: &Tmux, caller: &Caller) -> Result<Value, CommandError> {
    let version = tmux
        .read(&format!(
            "display-message -p -t {} '#{{version}}'",
            tmux.session_target()
        ))
        .await?;
    let panes = tmux.panes().await?;
    let tabs = tmux.tabs().await?;
    let active_pane = panes.iter().find(|p| p.active);
    Ok(json!({
        "session": tmux.session().as_str(),
        "tmuxVersion": version.trim(),
        "tmuxyVersion": env!("CARGO_PKG_VERSION"),
        "activeTab": tabs.iter().find(|t| t.active).map(|t| &t.id),
        "activePane": active_pane.map(|p| &p.id),
        "tabs": tabs.len(),
        "panes": panes.len(),
        "viewers": tmux.viewers().await,
        "readOnly": caller.read_only,
    }))
}

#[derive(Deserialize)]
pub(in crate::mcp) struct PaneListArgs {
    tab: Option<String>,
}

pub(in crate::mcp) async fn pane_list(
    tmux: &Tmux,
    args: PaneListArgs,
) -> Result<Value, CommandError> {
    let panes: Vec<_> = tmux
        .panes()
        .await?
        .into_iter()
        .filter(|p| args.tab.as_deref().is_none_or(|tab| p.tab == tab))
        .collect();
    Ok(json!({ "panes": panes }))
}

pub(in crate::mcp) const MAX_SCROLLBACK: u32 = 10_000;

#[derive(Deserialize)]
pub(in crate::mcp) struct CaptureArgs {
    pane: Option<String>,
    #[serde(default)]
    scrollback: u32,
}

struct Screen {
    text: String,
    cursor: (u32, u32),
    size: (u32, u32),
}

async fn capture(tmux: &Tmux, pane: &PaneId, scrollback: u32) -> Result<Screen, CommandError> {
    let scrollback = scrollback.min(MAX_SCROLLBACK);
    let start = if scrollback > 0 {
        format!(" -S -{scrollback}")
    } else {
        String::new()
    };
    let output = tmux
        .read(&format!(
            "display-message -p -t {pane} '#{{cursor_x}} #{{cursor_y}} #{{pane_width}} #{{pane_height}}' ; \
             capture-pane -p -J -t {pane}{start}"
        ))
        .await?;
    let (geometry, text) = output.split_once('\n').unwrap_or((output.as_str(), ""));
    let numbers: Vec<u32> = geometry
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    let [x, y, width, height] = numbers[..] else {
        return Err(CommandError::tmux(format!(
            "unexpected pane geometry from tmux: {geometry:?}"
        )));
    };
    Ok(Screen {
        text: trim_screen(text),
        cursor: (x, y),
        size: (width, height),
    })
}

pub(in crate::mcp) fn trim_screen(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let end = lines
        .iter()
        .rposition(|line| !line.is_empty())
        .map_or(0, |i| i + 1);
    lines[..end].join("\n")
}

pub(in crate::mcp) async fn pane_capture(
    tmux: &Tmux,
    args: CaptureArgs,
) -> Result<Value, CommandError> {
    let pane = tmux.pane(args.pane.as_deref()).await?;
    let screen = capture(tmux, &pane.id, args.scrollback).await?;
    Ok(json!({
        "paneId": pane.id,
        "text": screen.text,
        "cursor": { "x": screen.cursor.0, "y": screen.cursor.1 },
        "width": screen.size.0,
        "height": screen.size.1,
    }))
}

#[derive(Deserialize)]
pub(in crate::mcp) struct WaitArgs {
    pane: Option<String>,
    pattern: String,
    timeout_seconds: Option<u64>,
    #[serde(default)]
    scrollback: u32,
}

const WAIT_DEFAULT: Duration = Duration::from_secs(30);
pub(in crate::mcp) const WAIT_MAX: Duration = Duration::from_secs(600);
const WAIT_POLL: Duration = Duration::from_millis(250);

/// `pattern` as `pane_wait_for` reads it: a screen is lines, so `^` and `$`
/// match at each one, the way an agent writes `^done$`.
pub(in crate::mcp) fn screen_pattern(pattern: &str) -> Result<regex::Regex, CommandError> {
    regex::RegexBuilder::new(pattern)
        .multi_line(true)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| CommandError::invalid(format!("not a regular expression: {e}")))
}

/// The first match on a screen, and the whole line it starts on.
pub(in crate::mcp) fn find_on_screen<'a>(
    pattern: &regex::Regex,
    text: &'a str,
) -> Option<(&'a str, &'a str)> {
    let found = pattern.find(text)?;
    let start = text[..found.start()].rfind('\n').map_or(0, |i| i + 1);
    let end = text[found.start()..]
        .find('\n')
        .map_or(text.len(), |i| found.start() + i);
    Some((found.as_str(), &text[start..end]))
}

pub(in crate::mcp) async fn pane_wait_for(
    tmux: &Tmux,
    args: WaitArgs,
) -> Result<Value, CommandError> {
    let pattern = screen_pattern(&args.pattern)?;
    let pane = tmux.pane(args.pane.as_deref()).await?;
    let timeout = timeout(args.timeout_seconds, WAIT_DEFAULT, WAIT_MAX);
    let deadline = Instant::now() + timeout;
    loop {
        let screen = capture(tmux, &pane.id, args.scrollback).await?;
        if let Some((matched, line)) = find_on_screen(&pattern, &screen.text) {
            return Ok(json!({ "paneId": pane.id, "matched": matched, "line": line }));
        }
        if Instant::now() >= deadline {
            let tail: Vec<&str> = screen.text.lines().rev().take(20).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            return Err(CommandError::unavailable(format!(
                "nothing matched /{}/ in {} after {}s. Its screen ends:\n{}",
                args.pattern,
                pane.id,
                timeout.as_secs(),
                tail.join("\n")
            )));
        }
        tmux.keep_alive().await;
        tokio::time::sleep(WAIT_POLL).await;
    }
}
