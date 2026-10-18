use std::collections::BTreeMap;

use serde_json::{Map, Value};

/// A shell pane younger than this has not had a fair chance to print.
pub(super) const SILENT_PANE_MIN_MS: u64 = 10_000;

#[derive(Default)]
struct SessionHealth {
    actions: usize,
    /// `connect` spans seen; every one after the first is a reconnect.
    connects: usize,
    reconnects: usize,
    rejected: usize,
    errors: usize,
}

/// Field health check: reports reconnects, rejected commands, errors, and session counts
/// across real usage recorded in the trace.
pub(super) fn health_check(events: &[Map<String, Value>]) -> String {
    let mut by_session: BTreeMap<String, SessionHealth> = BTreeMap::new();
    let mut total_reconnects = 0;
    let mut total_rejected = 0;
    let mut total_errors = 0;

    for ev in events {
        let session = ev
            .get("session")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string();
        let entry = by_session.entry(session).or_default();
        entry.actions += 1;

        let name = ev.get("name").and_then(Value::as_str).unwrap_or("");
        let layer = ev.get("layer").and_then(Value::as_str).unwrap_or("");
        let is_fail = name == "fail" || ev.get("failed").and_then(Value::as_bool).unwrap_or(false);
        let is_rejected = is_fail
            || name.contains("rejected")
            || ev.get("rejected").and_then(Value::as_bool).unwrap_or(false)
            || ev
                .get("status")
                .and_then(Value::as_u64)
                .is_some_and(|s| s == 400 || s == 403);

        let is_reconnect = name.contains("reconnect")
            || ev
                .get("reconnected")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            || (layer == "monitor" && name == "connect" && {
                entry.connects += 1;
                entry.connects > 1
            });

        let is_error = ev
            .get("level")
            .and_then(Value::as_str)
            .is_some_and(|l| l.eq_ignore_ascii_case("error"))
            || ev.get("error").is_some();

        if is_rejected {
            entry.rejected += 1;
            total_rejected += 1;
        }
        if is_reconnect {
            entry.reconnects += 1;
            total_reconnects += 1;
        }
        if is_error {
            entry.errors += 1;
            total_errors += 1;
        }
    }

    let mut out = String::new();
    out.push_str("tmuxy field health check\n");
    out.push_str("========================\n");
    out.push_str(&format!("events analyzed: {}\n", events.len()));
    out.push_str(&format!("sessions tracked: {}\n", by_session.len()));
    out.push_str(&format!("reconnects: {}\n", total_reconnects));
    out.push_str(&format!("rejected commands: {}\n", total_rejected));
    out.push_str(&format!("errors: {}\n\n", total_errors));

    out.push_str("sessions:\n");
    for (sess, h) in &by_session {
        let status = if h.reconnects == 0 && h.rejected == 0 && h.errors == 0 {
            "HEALTHY"
        } else if h.reconnects > 2 || h.rejected > 5 || h.errors > 0 {
            "DEGRADED"
        } else {
            "WARNING"
        };
        out.push_str(&format!(
            "  {:<16} {} actions, {} reconnects, {} rejected, {} errors [{}]\n",
            sess, h.actions, h.reconnects, h.rejected, h.errors, status
        ));
    }

    let overall = if total_reconnects == 0 && total_rejected == 0 && total_errors == 0 {
        "HEALTHY — no reconnect flaps or rejected commands"
    } else if total_reconnects > 2 || total_rejected > 5 || total_errors > 0 {
        "DEGRADED — investigate anomalies in trace"
    } else {
        "ATTENTION — minor reconnects or rejections detected"
    };
    out.push_str(&format!("\noverall status: {}\n", overall));

    let silent = silent_panes(events, SILENT_PANE_MIN_MS);
    out.push_str(&format!(
        "\nsilent shell panes (no output for {}s or more): {}\n",
        SILENT_PANE_MIN_MS / 1000,
        silent.len()
    ));
    for pane in &silent {
        out.push_str(&format!("  {}\n", pane.describe()));
    }
    out
}

/// The events between the marker labelled `label` and the marker after it.
/// Empty when no marker has that label.
pub fn window(events: &[Map<String, Value>], label: &str) -> Vec<Map<String, Value>> {
    let is_mark =
        |ev: &Map<String, Value>| ev.get("layer").and_then(Value::as_str) == Some("marker");
    let Some(start) = events
        .iter()
        .position(|ev| is_mark(ev) && ev.get("label").and_then(Value::as_str) == Some(label))
    else {
        return Vec::new();
    };
    events[start..]
        .iter()
        .enumerate()
        .take_while(|(i, ev)| *i == 0 || !is_mark(ev))
        .map(|(_, ev)| ev.clone())
        .collect()
}

/// A shell pane that never showed anything: no `%output`, nothing replayed
/// when it was first listed, and every capture of it empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SilentPane {
    pub session: String,
    pub pane: String,
    /// How long it was alive and silent, in ms.
    pub alive_ms: u64,
    pub captures: u64,
    pub size: Option<(u64, u64)>,
    /// The last marker before it appeared — in an E2E run, the test.
    pub during: Option<String>,
}

impl SilentPane {
    pub fn describe(&self) -> String {
        let size = self
            .size
            .map(|(c, r)| format!("{c}x{r}"))
            .unwrap_or_else(|| "size unknown".to_string());
        let during = self
            .during
            .as_deref()
            .map(|d| format!(" during \"{d}\""))
            .unwrap_or_default();
        format!(
            "{} in {}: a shell pane silent for {}s, {} capture(s) all empty, {}{}",
            self.pane,
            self.session,
            self.alive_ms / 1000,
            self.captures,
            size,
            during
        )
    }
}

/// Shell panes that lived at least `min_alive_ms` without ever showing a byte.
///
/// A shell prints a prompt within milliseconds of starting; one that has shown
/// nothing for seconds is either a shell that never started talking or output
/// that never reached the aggregator — the start-up fault the E2E suite hit as
/// "a pane that never shows a prompt". Built from the aggregator's pane
/// lifecycle events (`pane appeared`, `pane first output`, `pane captured`,
/// `pane resized`, `pane gone`).
pub(super) fn silent_panes(events: &[Map<String, Value>], min_alive_ms: u64) -> Vec<SilentPane> {
    struct Live {
        shell: bool,
        spoke: bool,
        since: u64,
        captures: u64,
        size: Option<(u64, u64)>,
        during: Option<String>,
    }
    let ts = |ev: &Map<String, Value>| ev.get("ts_wall").and_then(Value::as_u64).unwrap_or(0);
    let str_of = |ev: &Map<String, Value>, k: &str| {
        ev.get(k).and_then(Value::as_str).unwrap_or("").to_string()
    };
    let num = |ev: &Map<String, Value>, k: &str| ev.get(k).and_then(Value::as_u64);

    let mut live: BTreeMap<(String, String), Live> = BTreeMap::new();
    let mut out = Vec::new();
    let mut last_mark: Option<String> = None;
    let mut end = 0u64;
    let finish = |key: &(String, String), p: &Live, at: u64, out: &mut Vec<SilentPane>| {
        let alive = at.saturating_sub(p.since);
        if p.shell && !p.spoke && alive >= min_alive_ms {
            out.push(SilentPane {
                session: key.0.clone(),
                pane: key.1.clone(),
                alive_ms: alive,
                captures: p.captures,
                size: p.size,
                during: p.during.clone(),
            });
        }
    };

    for ev in events {
        end = end.max(ts(ev));
        if ev.get("layer").and_then(Value::as_str) == Some("marker") {
            last_mark = ev.get("label").and_then(Value::as_str).map(str::to_string);
            continue;
        }
        let name = ev.get("name").and_then(Value::as_str).unwrap_or("");
        if !name.starts_with("pane ") {
            continue;
        }
        let key = (str_of(ev, "session"), str_of(ev, "pane"));
        match name {
            "pane appeared" => {
                // A pane id reused by a new tmux server is a new pane.
                if let Some(old) = live.remove(&key) {
                    finish(&key, &old, ts(ev), &mut out);
                }
                live.insert(
                    key,
                    Live {
                        shell: ev.get("shell").and_then(Value::as_bool).unwrap_or(false),
                        spoke: num(ev, "bytes").unwrap_or(0) > 0,
                        since: ts(ev),
                        captures: 0,
                        size: num(ev, "cols").zip(num(ev, "rows")),
                        during: last_mark.clone(),
                    },
                );
            }
            "pane first output" => {
                if let Some(p) = live.get_mut(&key) {
                    p.spoke = true;
                }
            }
            "pane captured" => {
                if let Some(p) = live.get_mut(&key) {
                    p.captures += 1;
                    if num(ev, "lines").unwrap_or(0) > 0 {
                        p.spoke = true;
                    }
                }
            }
            "pane resized" => {
                if let Some(p) = live.get_mut(&key) {
                    p.size = num(ev, "cols").zip(num(ev, "rows"));
                }
            }
            "pane gone" => {
                if let Some(p) = live.remove(&key) {
                    finish(&key, &p, ts(ev), &mut out);
                }
            }
            _ => {}
        }
    }
    for (key, p) in &live {
        finish(key, p, end, &mut out);
    }
    out
}

/// The health check's findings as GitHub Actions annotations, then one plain
/// line saying what was read — so a clean check is told apart from a missing
/// or empty trace in the job log.
pub(super) fn github_annotations(events: &[Map<String, Value>]) -> String {
    let mut out = String::new();
    let silent = silent_panes(events, SILENT_PANE_MIN_MS);
    let marks = events
        .iter()
        .filter(|ev| ev.get("layer").and_then(Value::as_str) == Some("marker"))
        .count();
    for pane in &silent {
        // Annotation text is one line; `%` must be escaped as `%25`.
        out.push_str(&format!(
            "::warning title=Silent shell pane::{}\n",
            pane.describe().replace('%', "%25")
        ));
    }
    out.push_str(&format!(
        "trace health: {} events, {} markers, {} silent shell pane(s)\n",
        events.len(),
        marks,
        silent.len()
    ));
    out
}
