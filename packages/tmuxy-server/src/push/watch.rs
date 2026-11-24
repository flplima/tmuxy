//! Reads every pane on the socket (`tmuxy_core::host::socket_watch`) rather
//! than a session's monitor: the device a notification is for is the one
//! that is not watching, so no monitor would see it.

use std::collections::{HashMap, HashSet};
use tmuxy_core::host::socket_watch::PaneRow;

use tmuxy_core::PaneStateName;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Notice {
    pub title: String,
    pub body: String,
    /// One per pane and state: a newer notice for the same replaces it.
    pub tag: String,
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
        let title = match PaneStateName::parse(&row.state) {
            Some(PaneStateName::Error) => format!("{name} stopped with an error"),
            Some(PaneStateName::Unread) => format!("{name} finished"),
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
        let session = if row.session == tmuxy_core::constants::STASH_SESSION {
            tmuxy_core::DEFAULT_SESSION_NAME
        } else {
            row.session.as_str()
        };
        // Where it is, under what the pane said: the question an agent asks,
        // what a program finished with.
        let place = format!("{place} ({})", row.pane_id);
        let body = match row.message() {
            Some(message) => format!("{}\n{place}", shorten(&message)),
            None => place,
        };
        Self {
            title,
            body,
            tag: format!("tmuxy-{}-{}", row.pane_id, row.state),
            url: format!("/?session={}", urlencode(session)),
            pane_id: row.pane_id.clone(),
        }
    }
}

/// What a notification shows of a pane's text: as much as a banner shows,
/// the protocol allowing 2048 bytes.
const MAX_MESSAGE_CHARS: usize = 240;

fn shorten(message: &str) -> String {
    if message.chars().count() <= MAX_MESSAGE_CHARS {
        return message.to_string();
    }
    let kept: String = message.chars().take(MAX_MESSAGE_CHARS - 1).collect();
    format!("{}\u{2026}", kept.trim_end())
}

/// A session name as a query value: of `SessionName`'s alphabet, `@` and `+`
/// need encoding.
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Default)]
pub(crate) struct Watch {
    /// `None` until the first read: what is already in a state when the
    /// server starts watching is not news.
    states: Option<HashMap<String, String>>,
    /// Panes that had a result at the last read for the first time.
    unseen: HashSet<String>,
}

impl Watch {
    /// The panes that entered a notifying state since the last read, as
    /// notices — none while `@tmuxy-notify` is off.
    ///
    /// `needs-input` and `error` are news at once. An `unread` is news when
    /// it is a result, something a program reported as done
    /// ([`PaneRow::has_result`]), and once it has waited a read: a client that
    /// has the pane in front takes the mark off as soon as it shows, and
    /// what was seen there is not worth a notification.
    pub(crate) fn update(&mut self, rows: &[PaneRow], host: &str) -> Vec<Notice> {
        let now: HashMap<String, String> = rows
            .iter()
            .map(|row| (row.pane_id.clone(), row.state.clone()))
            .collect();
        let previous = self.states.replace(now);
        let mut waited = std::mem::take(&mut self.unseen);
        let Some(previous) = previous else {
            return Vec::new();
        };
        rows.iter()
            .filter(|row| row.notify != "off")
            .filter(|row| {
                let entered = previous.get(&row.pane_id) != Some(&row.state);
                match PaneStateName::parse(&row.state) {
                    Some(PaneStateName::NeedsInput | PaneStateName::Error) => entered,
                    Some(PaneStateName::Unread) if !row.has_result() => false,
                    Some(PaneStateName::Unread) if entered => {
                        self.unseen.insert(row.pane_id.clone());
                        false
                    }
                    Some(PaneStateName::Unread) => waited.remove(&row.pane_id),
                    _ => false,
                }
            })
            .map(|row| Notice::for_row(row, host))
            .collect()
    }
}
