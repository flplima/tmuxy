//! Which panes have just come to need the user: every pane on the socket,
//! read every couple of seconds while some device wants to hear of it.
//!
//! A pane's `@tmuxy-pane-state` is written by whatever runs in it (an
//! agent's hooks, `tmuxy pane state`, a send's question) and tmux announces
//! no option change. The monitors would see it, but there is one only while
//! a client watches its session, and the device a notification is for is
//! the one that is not watching. So the server reads it itself, with one
//! read-only `list-panes -a` across every session — a read, which tmux runs
//! safely beside an attached control-mode client (docs/TMUX.md) — and only
//! while there is a subscription to push to.

use std::collections::HashMap;

/// The states a notification is sent for.
const NOTIFY_STATES: [&str; 2] = ["needs-input", "error"];

/// One `list-panes -a` row: every pane's id, where it is, and what it says.
/// Tab-separated, free text last.
pub(crate) const PANES_FORMAT: &str = "#{pane_id}\t#{session_name}\t#{@tmuxy-notify}\t\
     #{@tmuxy-pane-state}\t#{pane_current_command}\t#{@tmuxy-label}\t#{window_name}";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PaneRow {
    pub pane_id: String,
    pub session: String,
    /// `@tmuxy-notify` as the pane resolves it (the global option).
    pub notify: String,
    pub state: String,
    pub command: String,
    pub label: String,
    pub window: String,
}

pub(crate) fn parse_rows(listing: &str) -> Vec<PaneRow> {
    listing
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(7, '\t').collect();
            let [pane_id, session, notify, state, command, label, window] = f[..] else {
                return None;
            };
            Some(PaneRow {
                pane_id: pane_id.to_string(),
                session: session.to_string(),
                notify: notify.to_string(),
                state: state.to_string(),
                command: command.to_string(),
                label: label.to_string(),
                window: window.to_string(),
            })
        })
        .collect()
}

/// What a notification says, and where a tap on it goes.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Notice {
    pub title: String,
    pub body: String,
    /// One per pane and state: a newer notice for the same replaces it.
    pub tag: String,
    /// The app, on the pane's session.
    pub url: String,
    pub pane_id: String,
}

impl Notice {
    fn for_row(row: &PaneRow, host: &str) -> Self {
        let name = if !row.label.is_empty() {
            row.label.clone()
        } else if is_version(&row.command) {
            // Claude Code runs as `…/claude/versions/<version>`.
            "claude".to_string()
        } else {
            row.command.clone()
        };
        let title = match row.state.as_str() {
            "error" => format!("{name} stopped with an error"),
            _ => format!("{name} needs you"),
        };
        let place = [host, row.session.as_str(), row.window.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" · ");
        // Hidden pane-group members are parked in a session of their own;
        // the app opens on the default one for them.
        let session = if row.session.starts_with("__") {
            tmuxy_core::DEFAULT_SESSION_NAME
        } else {
            row.session.as_str()
        };
        Self {
            title,
            body: format!("{place} ({})", row.pane_id),
            tag: format!("tmuxy-{}-{}", row.pane_id, row.state),
            url: format!("/?session={}", urlencode(session)),
            pane_id: row.pane_id.clone(),
        }
    }
}

pub(crate) fn is_version(command: &str) -> bool {
    command.contains('.')
        && command
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// A session name as a query value; names are held to a URL-safe alphabet
/// already (`SessionName`), so this only guards the stash's.
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Every pane's last state, and what changed since.
#[derive(Default)]
pub(crate) struct Watch {
    /// `None` until the first read: what is already in a state when the
    /// server starts watching is not news.
    states: Option<HashMap<String, String>>,
}

impl Watch {
    /// The panes that entered a notifying state since the last read, as
    /// notices — none while `@tmuxy-notify` is off.
    pub(crate) fn update(&mut self, rows: &[PaneRow], host: &str) -> Vec<Notice> {
        let now: HashMap<String, String> = rows
            .iter()
            .map(|row| (row.pane_id.clone(), row.state.clone()))
            .collect();
        let previous = self.states.replace(now);
        let Some(previous) = previous else {
            return Vec::new();
        };
        rows.iter()
            .filter(|row| row.notify != "off")
            .filter(|row| NOTIFY_STATES.contains(&row.state.as_str()))
            .filter(|row| previous.get(&row.pane_id) != Some(&row.state))
            .map(|row| Notice::for_row(row, host))
            .collect()
    }
}

/// Every pane on the socket, read with one read-only `list-panes -a`;
/// `None` when there is no tmux server to ask.
pub(crate) async fn read_panes() -> Option<Vec<PaneRow>> {
    let output = tokio::task::spawn_blocking(|| {
        tmuxy_core::session::tmux_command()
            .args(["list-panes", "-a", "-F", PANES_FORMAT])
            .output()
    })
    .await
    .ok()?
    .ok()?;
    output
        .status
        .success()
        .then(|| parse_rows(&String::from_utf8_lossy(&output.stdout)))
}
