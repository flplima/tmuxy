//! OSC 7501, the program status protocol: a program tells the terminal what it
//! is doing (`idle`, `working`, `blocked`, `done`, `error`) and why, and the
//! terminal keeps one record per id the program reported under.
//!
//! A report is `OSC 7501 ; key=value(:key=value)* ST`. This module reads one
//! ([`Report::parse`]), keeps a pane's records ([`Records`]) and says which of
//! them the pane shows ([`Records::shown`]): the one that wants the user most,
//! in `PaneStateName`'s order. Every limit is the specification's, and a
//! report that breaks one is dropped whole, so a program cannot make a pane's
//! records grow.
//!
//! The feature-detection query (`OSC 7501 ; ?`) is a report without a state,
//! and is dropped like one (docs/RICH-RENDERING.md says why it has no reply).

use super::osc::StatusEvent;
use super::state::Instant;
use crate::PaneStateName;

/// OSC through ST, counting `ESC ] 7501 ;` and a two-byte terminator.
const MAX_SEQUENCE_BYTES: usize = 4096;
const SEQUENCE_FRAMING_BYTES: usize = 9;
const MAX_KEY_BYTES: usize = 16;
const MAX_MSG_ENCODED_BYTES: usize = 2732;
const MAX_MSG_DECODED_BYTES: usize = 2048;
const MAX_TITLE_ENCODED_BYTES: usize = 256;
const MAX_TITLE_DECODED_BYTES: usize = 192;
const MAX_APP_BYTES: usize = 32;
const MAX_ID_BYTES: usize = 128;
const MAX_ID_SEGMENT_BYTES: usize = 32;
const MAX_ID_DEPTH: usize = 8;
/// Past this, the record updated least recently makes room.
const MAX_RECORDS: usize = 256;
/// The least time between two writes of one pane's status to tmux: a program
/// can report as fast as it prints, and each write is a tmux command.
pub(crate) const MIN_WRITE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum State {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
}

impl State {
    fn parse(word: &str) -> Option<Self> {
        Some(match word {
            "idle" => State::Idle,
            "working" => State::Working,
            "done" => State::Done,
            "blocked" => State::Blocked,
            "error" => State::Error,
            _ => return None,
        })
    }

    const fn as_str(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Working => "working",
            State::Done => "done",
            State::Blocked => "blocked",
            State::Error => "error",
        }
    }

    /// The pane state a record in this state reads as: a blocked program
    /// needs the user, and a finished one has a result nobody has seen.
    pub(crate) const fn pane_state(self) -> PaneStateName {
        match self {
            State::Idle => PaneStateName::Idle,
            State::Working => PaneStateName::Working,
            State::Done => PaneStateName::Unread,
            State::Blocked => PaneStateName::NeedsInput,
            State::Error => PaneStateName::Error,
        }
    }

    /// Whether a record in this state ends with the command that wrote it.
    const fn ends_at_a_prompt(self) -> bool {
        matches!(self, State::Working | State::Blocked)
    }
}

/// What one id is doing: exactly the keys of the last report that named it.
/// `title` and `msg` stay base64, as they were sent and checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Record {
    pub state: State,
    pub kind: Option<&'static str>,
    pub progress: Option<u8>,
    pub app: Option<String>,
    pub title: Option<String>,
    pub msg: Option<String>,
}

/// One `OSC 7501` report. The root record's id is the empty string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Report {
    Set {
        id: String,
        record: Record,
    },
    /// Remove `id` and every record beneath it; the root's id removes all.
    Clear {
        id: String,
    },
}

fn is_value_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b',' | b'+' | b'/' | b'=' | b'-')
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-')
}

/// Whether `id` is within the grammar and its limits. A report whose id is
/// not is ignored: falling back to the root would let it overwrite the root.
fn valid_id(id: &str) -> bool {
    id.len() <= MAX_ID_BYTES
        && id.split('/').count() <= MAX_ID_DEPTH
        && id.split('/').all(|segment| {
            (1..=MAX_ID_SEGMENT_BYTES).contains(&segment.len()) && segment.bytes().all(is_name_byte)
        })
}

fn is_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// Whether `encoded` is base64 of one line of UTF-8 text within both limits.
fn valid_text(encoded: &str, max_encoded: usize, max_decoded: usize) -> bool {
    encoded.len() <= max_encoded
        && crate::control_mode::images::base64_decode(encoded)
            .filter(|bytes| bytes.len() <= max_decoded)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .is_some_and(|text| !text.chars().any(is_control))
}

/// The values a report gave the keys this terminal knows, as written.
#[derive(Default)]
struct Pairs<'a> {
    state: Option<&'a str>,
    id: Option<&'a str>,
    kind: Option<&'a str>,
    progress: Option<&'a str>,
    app: Option<&'a str>,
    title: Option<&'a str>,
    msg: Option<&'a str>,
}

impl<'a> Pairs<'a> {
    /// `None` when the report is to be discarded whole: a key past its limit,
    /// or an id that cannot be read.
    fn read(body: &'a str) -> Option<Self> {
        let mut pairs = Pairs::default();
        for pair in body.split(':') {
            // A malformed pair is skipped and the rest still read.
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let (key, value) = (key.trim(), value.trim());
            if key.len() > MAX_KEY_BYTES {
                return None;
            }
            if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase()) {
                continue;
            }
            if !value.bytes().all(is_value_byte) {
                // Skipped like any malformed pair, except the id: without it
                // the report would land on the root record.
                if key == "id" {
                    return None;
                }
                continue;
            }
            // A key that repeats keeps its last value.
            let slot = match key {
                "state" => &mut pairs.state,
                "id" => &mut pairs.id,
                "kind" => &mut pairs.kind,
                "progress" => &mut pairs.progress,
                "app" => &mut pairs.app,
                "title" => &mut pairs.title,
                "msg" => &mut pairs.msg,
                _ => continue,
            };
            *slot = Some(value);
        }
        Some(pairs)
    }
}

impl Report {
    /// The report in the body of an `OSC 7501` (everything after `7501;`).
    /// `None` for the feature-detection query and for a report the
    /// specification says to ignore or discard whole.
    pub(crate) fn parse(body: &[u8]) -> Option<Self> {
        if body.len() + SEQUENCE_FRAMING_BYTES > MAX_SEQUENCE_BYTES {
            return None;
        }
        let pairs = Pairs::read(std::str::from_utf8(body).ok()?)?;
        let id = pairs.id.unwrap_or("");
        if !id.is_empty() && !valid_id(id) {
            return None;
        }
        if pairs.app.is_some_and(|app| app.len() > MAX_APP_BYTES) {
            return None;
        }
        let title = pairs.title.filter(|t| !t.is_empty());
        let msg = pairs.msg.filter(|m| !m.is_empty());
        if title.is_some_and(|t| !valid_text(t, MAX_TITLE_ENCODED_BYTES, MAX_TITLE_DECODED_BYTES))
            || msg.is_some_and(|m| !valid_text(m, MAX_MSG_ENCODED_BYTES, MAX_MSG_DECODED_BYTES))
        {
            return None;
        }

        let state = pairs.state?;
        if state == "clear" {
            return Some(Report::Clear { id: id.to_string() });
        }
        let state = State::parse(state)?;
        let busy = matches!(state, State::Working | State::Blocked);
        Some(Report::Set {
            id: id.to_string(),
            record: Record {
                state,
                kind: pairs
                    .kind
                    .filter(|_| state == State::Blocked)
                    .and_then(|kind| match kind {
                        "permission" => Some("permission"),
                        "question" => Some("question"),
                        "auth" => Some("auth"),
                        _ => None,
                    }),
                progress: pairs
                    .progress
                    .filter(|p| busy && p.bytes().all(|b| b.is_ascii_digit()))
                    .and_then(|p| p.parse::<u8>().ok())
                    .filter(|p| *p <= 100),
                app: pairs
                    .app
                    .filter(|app| !app.is_empty() && app.bytes().all(is_name_byte))
                    .map(str::to_string),
                title: title.map(str::to_string),
                msg: msg.map(str::to_string),
            },
        })
    }
}

/// What a pane shows of its records: the state, and the record behind it as
/// a canonical report body (`state=…:kind=…:app=…`), free text still base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Shown {
    pub state: PaneStateName,
    pub status: String,
}

/// A pane's records, the one updated least recently first.
#[derive(Debug, Default)]
pub(crate) struct Records {
    entries: Vec<(String, Record)>,
}

impl Records {
    pub(crate) fn apply(&mut self, report: Report) {
        match report {
            Report::Clear { id } if id.is_empty() => self.entries.clear(),
            Report::Clear { id } => {
                let beneath = format!("{id}/");
                self.entries
                    .retain(|(other, _)| *other != id && !other.starts_with(&beneath));
            }
            Report::Set { id, record } => {
                self.entries.retain(|(other, _)| *other != id);
                self.entries.push((id, record));
                if self.entries.len() > MAX_RECORDS {
                    self.entries.remove(0);
                }
            }
        }
    }

    /// A new shell prompt (`OSC 133 ; A`): the command that was working or
    /// blocked is over. What it finished or failed at stays to be seen.
    pub(crate) fn prompt_began(&mut self) {
        self.entries
            .retain(|(_, record)| !record.state.ends_at_a_prompt());
    }

    /// `app` of the nearest record at or above `id` that names one.
    fn app_for(&self, id: &str) -> Option<&str> {
        let mut at = id;
        loop {
            let found = self
                .entries
                .iter()
                .find(|(other, _)| other == at)
                .and_then(|(_, record)| record.app.as_deref());
            if found.is_some() || at.is_empty() {
                return found;
            }
            at = at.rsplit_once('/').map_or("", |(parent, _)| parent);
        }
    }

    /// The record that wants the user most; of several, the newest. `None`
    /// when the pane has no record.
    pub(crate) fn shown(&self) -> Option<Shown> {
        let rank = |record: &Record| {
            PaneStateName::ALL
                .iter()
                .position(|s| *s == record.state.pane_state())
        };
        let (id, record) = self
            .entries
            .iter()
            .rev()
            .min_by_key(|(_, record)| rank(record))?;
        let mut pairs = vec![format!("state={}", record.state.as_str())];
        if !id.is_empty() {
            pairs.push(format!("id={id}"));
        }
        if let Some(kind) = record.kind {
            pairs.push(format!("kind={kind}"));
        }
        if let Some(progress) = record.progress {
            pairs.push(format!("progress={progress}"));
        }
        if let Some(app) = self.app_for(id) {
            pairs.push(format!("app={app}"));
        }
        if let Some(title) = &record.title {
            pairs.push(format!("title={title}"));
        }
        if let Some(msg) = &record.msg {
            pairs.push(format!("msg={msg}"));
        }
        Some(Shown {
            state: record.state.pane_state(),
            status: pairs.join(":"),
        })
    }
}

/// Whether `status`, a report body as [`Shown::status`] writes one, is behind
/// `pane_state`: a hook or the client that changed the pane's state since
/// left the text of the old one in tmux, and it is not the new state's.
pub(crate) fn status_is_for(status: &str, pane_state: Option<&str>) -> bool {
    status
        .split(':')
        .find_map(|pair| pair.strip_prefix("state="))
        .and_then(State::parse)
        .is_some_and(|state| pane_state == Some(state.pane_state().as_str()))
}

/// A change in what a pane shows of its records, and which of the two
/// options tmux holds it in is to be written.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Due {
    /// The state the pane shows now; `None` takes it off the pane.
    pub state: Option<PaneStateName>,
    /// The record behind it, as a report body; `None` when there is none.
    pub status: Option<String>,
    pub write_state: bool,
    pub write_status: bool,
}

/// One pane's records and what tmux has been told of them. tmux holds the
/// state and the text everything else reads (`@tmuxy-pane-state`,
/// `@tmuxy-pane-status`), so what the program reports is written there, and
/// only when it changes what the pane shows.
#[derive(Debug, Default)]
pub(crate) struct Tracker {
    records: Records,
    /// Events came whose outcome tmux has not been told.
    unsettled: bool,
    /// One of them was a report: the program said what it is doing, which
    /// counts again even when it says the same as before.
    reported: bool,
    written: Option<Shown>,
    written_at: Option<Instant>,
    row_stale: bool,
}

impl Tracker {
    pub(crate) fn read(&mut self, events: Vec<StatusEvent>) {
        for event in events {
            self.unsettled = true;
            match event {
                StatusEvent::Report(report) => {
                    self.reported |= matches!(report, Report::Set { .. });
                    self.records.apply(report);
                }
                StatusEvent::PromptBegan => self.records.prompt_began(),
            }
        }
    }

    /// What the pane shows from `now` on, when that changed: `None` when
    /// nothing did, or it changed too soon after the last time (the next call
    /// says it). `current` is the state tmux last reported for the pane,
    /// which a hook or the client may have changed since the last write: a
    /// program that reports again is written again.
    pub(crate) fn due(&mut self, current: Option<&str>, now: Instant) -> Option<Due> {
        if !self.unsettled {
            return None;
        }
        let shown = self.records.shown();
        let restated = self.reported
            && shown
                .as_ref()
                .is_some_and(|shown| current != Some(shown.state.as_str()));
        if shown == self.written && !restated {
            self.unsettled = false;
            self.reported = false;
            return None;
        }
        if self
            .written_at
            .is_some_and(|at| now.duration_since(at) < MIN_WRITE_INTERVAL)
        {
            return None;
        }
        let state = shown.as_ref().map(|shown| shown.state);
        let status = shown.as_ref().map(|shown| shown.status.clone());
        let written = self.written.as_ref();
        let due = Due {
            write_state: restated || state != written.map(|shown| shown.state),
            write_status: status.as_deref() != written.map(|shown| shown.status.as_str()),
            state,
            status,
        };
        self.unsettled = false;
        self.reported = false;
        self.written_at = Some(now);
        self.written = shown;
        self.row_stale = true;
        Some(due)
    }

    /// Whether the next `list-panes` row may predate the last write: tmux
    /// runs commands in order, so a listing asked for before the write
    /// answers with what the write replaced. Asked once per write.
    pub(crate) fn take_row_stale(&mut self) -> bool {
        std::mem::take(&mut self.row_stale)
    }
}

#[cfg(test)]
mod tests;
