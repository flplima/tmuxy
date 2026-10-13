//! OSC 7501 — the Program Status Protocol.
//!
//! A program says what it is doing over its own pty — `idle`, `working`,
//! `done`, `blocked` (on a permission, a question or a login) or `error` — so
//! a terminal can show it without scraping the screen. The specification:
//! <https://www.superlogical.com/rex/docs/build/program-status>.
//!
//! ```text
//! OSC 7501 ; state=blocked:kind=permission:app=terraform:msg=<base64> ST
//! ```
//!
//! Each report replaces one RECORD, addressed by a slash-separated `id`; no id
//! is the root. `clear` removes a record and its children (no id: all of
//! them). `working` and `blocked` records end with the program — when a new
//! prompt starts (OSC 133 `A`) or the pane's foreground process changes —
//! while `done` and `error` stay until cleared, since the user has not seen
//! them yet.
//!
//! What a pane shows is one record: the most urgent of them (`shown`). The
//! spec leaves that choice to the terminal.
//!
//! Feature detection (`OSC 7501 ; ? ST`) is not answered. Under tmux the
//! follow-up device-attributes query (`CSI c`) is answered by tmux itself,
//! synchronously, long before a reply from here could cross control mode, so
//! a program would read any answer as "unsupported" anyway. Programs that
//! report unconditionally — the common case — are shown.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The longest whole sequence honoured (`OSC 7501 ;` and its body).
const MAX_SEQUENCE_BYTES: usize = 4096;
/// Decoded byte limits for the free-text fields, and the `app` identifier.
const MAX_MSG_BYTES: usize = 2048;
const MAX_TITLE_BYTES: usize = 192;
const MAX_APP_BYTES: usize = 32;
/// `id` limits: total bytes, bytes per segment, segments.
const MAX_ID_BYTES: usize = 128;
const MAX_SEGMENT_BYTES: usize = 32;
const MAX_ID_DEPTH: usize = 8;
/// Records kept per pane; the least recently updated goes first.
const MAX_RECORDS: usize = 256;

/// What a program says it is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
}

impl StatusState {
    /// How much this state wants the user's attention: the record shown is the
    /// most urgent one.
    fn urgency(self) -> u8 {
        match self {
            Self::Blocked => 5,
            Self::Error => 4,
            Self::Working => 3,
            Self::Done => 2,
            Self::Idle => 1,
        }
    }

    /// Ended by the program itself ending (or a new prompt).
    fn is_transient(self) -> bool {
        matches!(self, Self::Working | Self::Blocked)
    }
}

/// What a `blocked` program is waiting on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockedKind {
    Permission,
    Question,
    Auth,
}

/// One record, as a pane shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgramStatus {
    pub state: StatusState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<BlockedKind>,
    /// The program's stable identifier (`claude-code`, `cargo`), inherited
    /// from the nearest ancestor record when the report leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// 0–100; absent means indeterminate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

#[derive(Debug, Clone)]
struct Record {
    status: ProgramStatus,
    /// When it was last updated, in reports: eviction and tie-breaking.
    seq: u64,
}

/// A pane's records.
#[derive(Debug, Default, Clone)]
pub struct ProgramStatusRecords {
    /// By id; the root is the empty id.
    records: BTreeMap<String, Record>,
    seq: u64,
}

/// What one report asked for.
enum Report {
    Set { id: String, status: ProgramStatus },
    Clear { id: Option<String> },
}

impl ProgramStatusRecords {
    /// Apply the body of one `OSC 7501 ; <body>`. Returns whether the records
    /// changed. A report that breaks the grammar or a limit changes nothing.
    pub fn apply(&mut self, body: &str) -> bool {
        // "7501;" plus the body is the sequence the limit is stated for.
        if body.len() + 5 > MAX_SEQUENCE_BYTES || body == "?" {
            return false;
        }
        match parse_report(body) {
            Some(Report::Set { id, status }) => self.set(id, status),
            Some(Report::Clear { id }) => self.clear(id.as_deref()),
            None => false,
        }
    }

    fn set(&mut self, id: String, mut status: ProgramStatus) -> bool {
        if status.app.is_none() {
            status.app = self.inherited_app(&id);
        }
        if self.records.get(&id).map(|r| &r.status) == Some(&status) {
            return false;
        }
        self.seq += 1;
        let seq = self.seq;
        self.records.insert(id, Record { status, seq });
        while self.records.len() > MAX_RECORDS {
            let Some(oldest) = self
                .records
                .iter()
                .min_by_key(|(_, r)| r.seq)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            self.records.remove(&oldest);
        }
        true
    }

    /// The `app` of the nearest ancestor that has one.
    fn inherited_app(&self, id: &str) -> Option<String> {
        let mut path = id;
        loop {
            path = match path.rfind('/') {
                Some(at) => &path[..at],
                None if !path.is_empty() => "",
                None => return None,
            };
            if let Some(app) = self.records.get(path).and_then(|r| r.status.app.clone()) {
                return Some(app);
            }
        }
    }

    fn clear(&mut self, id: Option<&str>) -> bool {
        let before = self.records.len();
        match id {
            None => self.records.clear(),
            Some(id) => {
                let below = format!("{id}/");
                self.records
                    .retain(|key, _| key != id && !key.starts_with(&below));
            }
        }
        self.records.len() != before
    }

    /// The program ended, or a new prompt began: what it was doing is over.
    pub fn end_transient(&mut self) -> bool {
        let before = self.records.len();
        self.records.retain(|_, r| !r.status.state.is_transient());
        self.records.len() != before
    }

    /// A full terminal reset (RIS) forgets everything.
    pub fn reset(&mut self) -> bool {
        let had = !self.records.is_empty();
        self.records.clear();
        had
    }

    /// The record a pane shows: the most urgent, the root before its children
    /// at equal urgency, then the most recently updated.
    pub fn shown(&self) -> Option<ProgramStatus> {
        self.records
            .iter()
            .max_by_key(|(id, r)| (r.status.state.urgency(), id.is_empty(), r.seq))
            .map(|(_, r)| r.status.clone())
    }
}

fn parse_report(body: &str) -> Option<Report> {
    let mut pairs: BTreeMap<&str, &str> = BTreeMap::new();
    for pair in body.split(':') {
        // A malformed pair is skipped; a repeated key keeps its last value.
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_lowercase())
            || !value.bytes().all(is_value_byte)
        {
            continue;
        }
        pairs.insert(key, value);
    }

    let id = match pairs.get("id") {
        Some(id) => Some(valid_id(id)?.to_string()),
        None => None,
    };
    let state = match *pairs.get("state")? {
        "clear" => return Some(Report::Clear { id }),
        "idle" => StatusState::Idle,
        "working" => StatusState::Working,
        "done" => StatusState::Done,
        "blocked" => StatusState::Blocked,
        "error" => StatusState::Error,
        // An unrecognised state: the report is ignored.
        _ => return None,
    };

    let kind = match (state, pairs.get("kind")) {
        (StatusState::Blocked, Some(&"permission")) => Some(BlockedKind::Permission),
        (StatusState::Blocked, Some(&"question")) => Some(BlockedKind::Question),
        (StatusState::Blocked, Some(&"auth")) => Some(BlockedKind::Auth),
        _ => None,
    };
    let progress = match (state, pairs.get("progress")) {
        (StatusState::Working | StatusState::Blocked, Some(value)) => {
            let progress: u8 = value.parse().ok()?;
            if progress > 100 {
                return None;
            }
            Some(progress)
        }
        _ => None,
    };
    let app = match pairs.get("app") {
        Some(app) => {
            if app.is_empty() || app.len() > MAX_APP_BYTES || !app.bytes().all(is_name_byte) {
                return None;
            }
            Some((*app).to_string())
        }
        None => None,
    };
    let title = text_field(pairs.get("title"), MAX_TITLE_BYTES)?;
    let msg = text_field(pairs.get("msg"), MAX_MSG_BYTES)?;

    Some(Report::Set {
        id: id.unwrap_or_default(),
        status: ProgramStatus {
            state,
            kind,
            app,
            progress,
            title,
            msg,
        },
    })
}

/// A base64 UTF-8 field: `Some(None)` when absent, `None` when it is invalid
/// (which discards the whole report).
fn text_field(value: Option<&&str>, limit: usize) -> Option<Option<String>> {
    let Some(value) = value else {
        return Some(None);
    };
    let bytes = base64_decode(value)?;
    if bytes.len() > limit {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    if text.chars().any(char::is_control) {
        return None;
    }
    Some(Some(text))
}

fn valid_id(id: &str) -> Option<&str> {
    let segments: Vec<&str> = id.split('/').collect();
    let ok = !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && segments.len() <= MAX_ID_DEPTH
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment.len() <= MAX_SEGMENT_BYTES
                && segment.bytes().all(is_name_byte)
        });
    ok.then_some(id)
}

/// `[A-Za-z0-9_.+-]`: an `app` and an `id` segment.
fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-')
}

/// `[A-Za-z0-9_.,+/=-]`: any value.
fn is_value_byte(b: u8) -> bool {
    is_name_byte(b) || matches!(b, b',' | b'/' | b'=')
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(input).ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    #[test]
    fn a_report_sets_the_root_record() {
        let mut records = ProgramStatusRecords::default();
        let body = format!(
            "state=blocked:kind=permission:app=terraform:msg={}",
            b64("Apply 3 to add?")
        );
        assert!(records.apply(&body));
        let shown = records.shown().unwrap();
        assert_eq!(shown.state, StatusState::Blocked);
        assert_eq!(shown.kind, Some(BlockedKind::Permission));
        assert_eq!(shown.app.as_deref(), Some("terraform"));
        assert_eq!(shown.msg.as_deref(), Some("Apply 3 to add?"));
    }

    #[test]
    fn the_most_urgent_record_is_shown_and_children_inherit_the_app() {
        let mut records = ProgramStatusRecords::default();
        records.apply("state=working:app=deploy");
        records.apply("state=working:id=us-east:progress=40");
        assert_eq!(records.shown().unwrap().app.as_deref(), Some("deploy"));
        assert_eq!(
            records.shown().unwrap().progress,
            None,
            "the root wins a tie"
        );
        records.apply("state=blocked:kind=permission:id=eu-west");
        let shown = records.shown().unwrap();
        assert_eq!(shown.state, StatusState::Blocked);
        assert_eq!(
            shown.app.as_deref(),
            Some("deploy"),
            "inherited from the root"
        );
    }

    #[test]
    fn clear_removes_a_record_and_its_children_or_everything() {
        let mut records = ProgramStatusRecords::default();
        records.apply("state=working");
        records.apply("state=blocked:id=a");
        records.apply("state=blocked:id=a/b");
        assert!(records.apply("state=clear:id=a"));
        assert_eq!(records.shown().unwrap().state, StatusState::Working);
        assert!(records.apply("state=clear"));
        assert_eq!(records.shown(), None);
    }

    #[test]
    fn working_and_blocked_end_with_the_program_done_and_error_stay() {
        let mut records = ProgramStatusRecords::default();
        records.apply("state=working");
        records.apply("state=error:id=x");
        assert!(records.end_transient());
        assert_eq!(records.shown().unwrap().state, StatusState::Error);
    }

    #[test]
    fn a_malformed_or_oversized_report_changes_nothing() {
        let mut records = ProgramStatusRecords::default();
        assert!(!records.apply("state=sleeping"), "unknown state");
        assert!(!records.apply("kind=permission"), "no state");
        assert!(
            !records.apply("state=working:progress=101"),
            "progress past 100"
        );
        assert!(!records.apply("state=working:id=a//b"), "empty id segment");
        assert!(!records.apply("state=working:msg=abc"), "msg is not base64");
        assert!(
            !records.apply(&format!("state=working:msg={}", b64("a\u{7}b"))),
            "control char"
        );
        assert!(!records.apply(&format!("state=working:title={}", b64(&"t".repeat(193)))));
        assert!(!records.apply(&format!("state=working:app={}", "a".repeat(33))));
        assert!(!records.apply(&format!("state=working:x={}", "a".repeat(4100))));
        assert!(!records.apply("?"), "feature detection is not a report");
        assert_eq!(records.shown(), None);
    }

    #[test]
    fn a_bad_pair_is_skipped_and_the_last_key_wins() {
        let mut records = ProgramStatusRecords::default();
        assert!(records.apply("junk:state=idle:state=done:Bad=1"));
        assert_eq!(records.shown().unwrap().state, StatusState::Done);
    }

    #[test]
    fn kind_and_progress_only_mean_something_where_the_spec_allows_them() {
        let mut records = ProgramStatusRecords::default();
        records.apply("state=done:kind=auth:progress=50");
        let shown = records.shown().unwrap();
        assert_eq!(shown.kind, None);
        assert_eq!(shown.progress, None);
    }

    #[test]
    fn records_are_capped_by_evicting_the_least_recently_updated() {
        let mut records = ProgramStatusRecords::default();
        for n in 0..(MAX_RECORDS + 10) {
            records.apply(&format!("state=done:id=t{n}"));
        }
        assert_eq!(records.records.len(), MAX_RECORDS);
        assert!(!records.records.contains_key("t0"));
    }
}
