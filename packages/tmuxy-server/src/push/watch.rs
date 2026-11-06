//! Which panes have just come to need the user, from the host's read of
//! every pane on the socket (`tmuxy_core::host::socket_watch`): the device a
//! notification is for is the one that is not watching, so no monitor would
//! see it.

use std::collections::HashMap;
use tmuxy_core::host::socket_watch::PaneRow;

/// The states a notification is sent for.
const NOTIFY_STATES: [&str; 2] = ["needs-input", "error"];

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
        } else {
            tmuxy_core::program::program_name(&row.command).to_string()
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
