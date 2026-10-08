//! `tmuxy trace` — inspect a local NDJSON action-trace file (docs/TELEMETRY.md).
//!
//! Loads the append-only NDJSON written by the trace `Layer` and the `/trace`
//! ingest, and either prints a per-action summary (correlating by `action_id`)
//! or exports a Chrome-trace / Perfetto JSON timeline (`--export`), which opens
//! directly at ui.perfetto.dev for a flame-graph view across all layers.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

#[derive(clap::Args)]
pub struct TraceViewArgs {
    /// Trace file to read. Defaults to the standard state-dir `trace.ndjson`.
    pub file: Option<String>,

    /// Export a Chrome-trace/Perfetto JSON timeline to this path instead of
    /// printing a summary. Open the result at ui.perfetto.dev.
    #[arg(long, value_name = "PATH")]
    pub export: Option<String>,

    /// Append a marker line with this label to the trace, then exit. Use it to
    /// stamp "the bug happened here" so you can find the moment in a long trace.
    #[arg(long, value_name = "LABEL")]
    pub mark: Option<String>,

    /// Run a field health check summarizing reconnects, rejected commands, and anomalies.
    #[arg(long, alias = "check")]
    pub health: bool,

    /// With the health check: print each finding as a GitHub Actions
    /// annotation (`::warning …`) instead of the report, for a CI step to run
    /// on every job, passing or not.
    #[arg(long, requires = "health")]
    pub github: bool,

    /// Read only the events between the marker with this label and the next
    /// marker after it — one test's slice of a whole run's trace.
    #[arg(long, value_name = "MARK")]
    pub window: Option<String>,
}

/// A shell pane younger than this has not had a fair chance to print.
const SILENT_PANE_MIN_MS: u64 = 10_000;

pub fn run(args: TraceViewArgs) {
    if let Some(label) = args.mark {
        let path = args
            .file
            .map(PathBuf::from)
            .unwrap_or_else(default_trace_path);
        match append_marker(&path, &label) {
            Ok(()) => println!("marker added → {}", path.display()),
            Err(e) => {
                eprintln!("tmuxy trace: {e}");
                std::process::exit(1);
            }
        }
        return;
    }

    let path = match resolve_path(args.file) {
        Some(p) => p,
        None => {
            eprintln!("tmuxy trace: no trace file found (pass a path, or run with --trace first)");
            std::process::exit(1);
        }
    };
    let events = match load(&path) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("tmuxy trace: {e}");
            std::process::exit(1);
        }
    };
    let events = match &args.window {
        Some(label) => window(&events, label),
        None => events,
    };
    if events.is_empty() {
        println!("tmuxy trace: {} has no events to read", path.display());
        return;
    }

    match args.export {
        Some(out) => {
            let trace = to_chrome_trace(&events);
            let bytes = serde_json::to_vec_pretty(&trace).unwrap_or_default();
            match std::fs::write(&out, bytes) {
                Ok(()) => println!(
                    "wrote {} events → {} (open at ui.perfetto.dev)",
                    events.len(),
                    out
                ),
                Err(e) => {
                    eprintln!("tmuxy trace: failed to write {out}: {e}");
                    std::process::exit(1);
                }
            }
        }
        None => {
            if args.health && args.github {
                print!("{}", github_annotations(&events));
            } else if args.health {
                print!("{}", health_check(&events));
            } else {
                print!("{}", summarize(&events));
            }
        }
    }
}

/// Resolve the file to read: the explicit arg, else the default state-dir path
/// (mirrors `tmuxy_core::trace`'s default location) if it exists.
fn resolve_path(file: Option<String>) -> Option<PathBuf> {
    if let Some(f) = file {
        return Some(PathBuf::from(f));
    }
    let path = default_trace_path();
    path.exists().then_some(path)
}

/// The default trace path, creating its directory (used by `--mark`, which may
/// need to create the file).
fn default_trace_path() -> PathBuf {
    let dir = dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("tmuxy");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("trace.ndjson")
}

/// Append a content-free marker line. The label is bounded; serde escaping keeps
/// it from breaking the NDJSON framing. O_APPEND makes this safe alongside a
/// running server's writer.
fn append_marker(path: &Path, label: &str) -> Result<(), String> {
    use std::io::Write;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let safe: String = label.chars().take(120).collect();
    let line = serde_json::json!({
        "layer": "marker", "name": "mark", "phase": "event",
        "label": safe, "ts_wall": now
    })
    .to_string();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

fn load(path: &Path) -> Result<Vec<Map<String, Value>>, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(parse_lines(&content))
}

/// Parse NDJSON leniently: one object per line, blank and malformed lines
/// skipped (a torn final line after a crash must not abort the whole load).
fn parse_lines(content: &str) -> Vec<Map<String, Value>> {
    content
        .lines()
        .filter_map(|line| match serde_json::from_str::<Value>(line.trim()) {
            Ok(Value::Object(m)) => Some(m),
            _ => None,
        })
        .collect()
}

/// Build a Chrome Trace Event Format document. Each layer becomes a thread;
/// spans (`phase == "span"`) become complete (`X`) events with a duration,
/// point events become instant (`i`) events. Timestamps are microseconds.
fn to_chrome_trace(events: &[Map<String, Value>]) -> Value {
    let mut tids: BTreeMap<String, u64> = BTreeMap::new();
    let mut next_tid = 1u64;
    let mut out: Vec<Value> = Vec::with_capacity(events.len());

    for ev in events {
        let layer = ev
            .get("layer")
            .and_then(Value::as_str)
            .unwrap_or("core")
            .to_string();
        let tid = *tids.entry(layer.clone()).or_insert_with(|| {
            let t = next_tid;
            next_tid += 1;
            t
        });

        let mut args = Map::new();
        for (k, v) in ev {
            if matches!(
                k.as_str(),
                "layer" | "name" | "phase" | "ts_wall" | "ts_mono" | "dur_us"
            ) {
                continue;
            }
            args.insert(k.clone(), v.clone());
        }

        let mut te = Map::new();
        te.insert(
            "name".into(),
            Value::from(ev.get("name").and_then(Value::as_str).unwrap_or("event")),
        );
        te.insert("cat".into(), Value::from(layer));
        te.insert("pid".into(), Value::from(1));
        te.insert("tid".into(), Value::from(tid));
        te.insert("ts".into(), Value::from(event_ts_us(ev)));
        te.insert("args".into(), Value::Object(args));

        if ev.get("phase").and_then(Value::as_str) == Some("span") {
            te.insert("ph".into(), Value::from("X"));
            te.insert(
                "dur".into(),
                Value::from(ev.get("dur_us").and_then(Value::as_u64).unwrap_or(0)),
            );
        } else {
            te.insert("ph".into(), Value::from("i"));
            te.insert("s".into(), Value::from("g"));
        }
        out.push(Value::Object(te));
    }

    // Name each thread after its layer so the Perfetto tracks are readable.
    for (layer, tid) in &tids {
        out.push(serde_json::json!({
            "name": "thread_name", "ph": "M", "pid": 1, "tid": tid,
            "args": { "name": layer }
        }));
    }

    serde_json::json!({ "traceEvents": out, "displayTimeUnit": "ms" })
}

fn event_ts_us(ev: &Map<String, Value>) -> f64 {
    if let Some(ms) = ev.get("ts_wall").and_then(Value::as_u64) {
        return ms as f64 * 1000.0;
    }
    ev.get("ts_mono").and_then(Value::as_u64).unwrap_or(0) as f64
}

/// Human-readable summary: event counts by layer, and the actions correlated by
/// `action_id` with the layer chain each one touched.
fn summarize(events: &[Map<String, Value>]) -> String {
    let mut by_layer: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_action: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let (mut min_ts, mut max_ts) = (u64::MAX, 0u64);

    for ev in events {
        let layer = ev.get("layer").and_then(Value::as_str).unwrap_or("?");
        *by_layer.entry(layer.to_string()).or_default() += 1;
        if let Some(aid) = ev.get("action_id").and_then(Value::as_str) {
            by_action
                .entry(aid.to_string())
                .or_default()
                .push(layer.to_string());
        }
        if let Some(ts) = ev.get("ts_wall").and_then(Value::as_u64) {
            min_ts = min_ts.min(ts);
            max_ts = max_ts.max(ts);
        }
    }

    let span = if min_ts != u64::MAX && max_ts >= min_ts {
        max_ts - min_ts
    } else {
        0
    };

    let mut out = String::new();
    out.push_str(&format!("{} events over {} ms\n\n", events.len(), span));
    out.push_str("events by layer:\n");
    for (layer, count) in &by_layer {
        out.push_str(&format!("  {layer:<12} {count}\n"));
    }
    out.push_str(&format!(
        "\ncorrelated actions (by action_id): {}\n",
        by_action.len()
    ));
    for (aid, layers) in by_action.iter().take(20) {
        out.push_str(&format!("  {:<18} {}\n", aid, layers.join(" → ")));
    }
    out.push_str(
        "\nexport a timeline with:  tmuxy trace --export trace.json   (open at ui.perfetto.dev)\n",
    );
    out
}

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
fn health_check(events: &[Map<String, Value>]) -> String {
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
struct SilentPane {
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
fn silent_panes(events: &[Map<String, Value>], min_alive_ms: u64) -> Vec<SilentPane> {
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
fn github_annotations(events: &[Map<String, Value>]) -> String {
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn ev(json: Value) -> Map<String, Value> {
        match json {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }

    fn lifecycle(name: &str, pane: &str, ts: u64, extra: Value) -> Map<String, Value> {
        let mut m = ev(serde_json::json!({
            "layer": "monitor", "name": name, "phase": "event",
            "session": "s", "pane": pane, "ts_wall": ts
        }));
        if let Value::Object(x) = extra {
            m.extend(x);
        }
        m
    }

    /// A shell pane that never shows a byte is found, with the test it
    /// appeared in; one that spoke — live, replayed, or only through a
    /// capture — is not, nor is a non-shell, nor one that was not alive long.
    #[test]
    fn a_shell_pane_that_never_spoke_is_reported_with_its_test() {
        let mark = ev(serde_json::json!({
            "layer": "marker", "name": "mark", "label": "suite › first test start", "ts_wall": 0
        }));
        let events = vec![
            mark,
            lifecycle(
                "pane appeared",
                "%1",
                1_000,
                serde_json::json!({"shell": true, "bytes": 0, "cols": 80, "rows": 24}),
            ),
            lifecycle(
                "pane captured",
                "%1",
                1_100,
                serde_json::json!({"lines": 0}),
            ),
            lifecycle(
                "pane appeared",
                "%2",
                1_000,
                serde_json::json!({"shell": true, "bytes": 0}),
            ),
            lifecycle(
                "pane captured",
                "%2",
                1_100,
                serde_json::json!({"lines": 2}),
            ),
            lifecycle(
                "pane appeared",
                "%3",
                1_000,
                serde_json::json!({"shell": true, "bytes": 90}),
            ),
            lifecycle(
                "pane appeared",
                "%4",
                1_000,
                serde_json::json!({"shell": false, "bytes": 0}),
            ),
            lifecycle(
                "pane appeared",
                "%5",
                1_000,
                serde_json::json!({"shell": true, "bytes": 0}),
            ),
            lifecycle(
                "pane first output",
                "%5",
                1_200,
                serde_json::json!({"bytes": 40}),
            ),
            lifecycle(
                "pane appeared",
                "%6",
                40_000,
                serde_json::json!({"shell": true, "bytes": 0}),
            ),
            lifecycle("pane gone", "%6", 41_000, serde_json::json!({})),
            lifecycle(
                "pane resized",
                "%1",
                2_000,
                serde_json::json!({"cols": 139, "rows": 27}),
            ),
            lifecycle("pane gone", "%1", 46_000, serde_json::json!({})),
        ];
        let silent = silent_panes(&events, SILENT_PANE_MIN_MS);
        assert_eq!(
            silent,
            vec![SilentPane {
                session: "s".into(),
                pane: "%1".into(),
                alive_ms: 45_000,
                captures: 1,
                size: Some((139, 27)),
                during: Some("suite › first test start".into()),
            }]
        );
        let annotation = github_annotations(&events);
        assert!(
            annotation.starts_with("::warning title=Silent shell pane::%251 in s"),
            "{annotation}"
        );
    }

    /// A session's first `connect` is not a reconnect, however many of its
    /// events came first (a span is written when it closes, after the events
    /// it contained); its second is.
    #[test]
    fn only_a_second_connect_is_a_reconnect() {
        let e = |name: &str, phase: &str| {
            ev(
                serde_json::json!({"layer": "monitor", "name": name, "phase": phase, "session": "s"}),
            )
        };
        let once = vec![
            e("pane appeared", "event"),
            e("pane captured", "event"),
            e("connect", "span"),
        ];
        assert!(
            health_check(&once).contains("reconnects: 0"),
            "{}",
            health_check(&once)
        );
        let twice = vec![
            e("connect", "span"),
            e("pane appeared", "event"),
            e("connect", "span"),
        ];
        assert!(
            health_check(&twice).contains("reconnects: 1"),
            "{}",
            health_check(&twice)
        );
    }

    /// One test's slice: from its marker up to the next marker.
    #[test]
    fn a_window_is_the_events_between_a_marker_and_the_next() {
        let m = |label: &str| {
            ev(serde_json::json!({"layer": "marker", "name": "mark", "label": label}))
        };
        let e = |n: &str| ev(serde_json::json!({"layer": "monitor", "name": n}));
        let events = vec![
            e("before"),
            m("a"),
            e("in-a"),
            e("also-in-a"),
            m("b"),
            e("in-b"),
        ];
        let names: Vec<_> = window(&events, "a")
            .iter()
            .map(|x| x.get("name").unwrap().as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["mark", "in-a", "also-in-a"]);
        assert!(window(&events, "missing").is_empty());
    }

    #[test]
    fn parse_lines_skips_blank_and_malformed() {
        let content = "{\"layer\":\"server\",\"name\":\"a\"}\n\nnot json\n{\"layer\":\"monitor\",\"name\":\"b\"}\n";
        let parsed = parse_lines(content);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].get("name").unwrap(), "a");
        assert_eq!(parsed[1].get("name").unwrap(), "b");
    }

    #[test]
    fn spans_export_as_complete_events_with_duration() {
        let events = vec![ev(serde_json::json!({
            "layer": "monitor", "name": "connect", "phase": "span",
            "dur_us": 45976, "ts_wall": 1_700_000_000_000u64, "session": "work"
        }))];
        let trace = to_chrome_trace(&events);
        let arr = trace.get("traceEvents").unwrap().as_array().unwrap();
        // one span event + one thread_name metadata
        let span = &arr[0];
        assert_eq!(span.get("ph").unwrap(), "X");
        assert_eq!(span.get("dur").unwrap(), 45976);
        assert_eq!(span.get("name").unwrap(), "connect");
        // ts is microseconds = ms * 1000
        assert_eq!(span.get("ts").unwrap().as_f64().unwrap(), 1.7e15);
        // moved fields land in args, structural keys stripped
        assert_eq!(span.get("args").unwrap().get("session").unwrap(), "work");
        assert!(span.get("args").unwrap().get("dur_us").is_none());
    }

    #[test]
    fn point_events_export_as_instant() {
        let events = vec![ev(serde_json::json!({
            "layer": "xstate", "name": "SEND_TMUX_COMMAND", "phase": "event",
            "ts_wall": 1_700_000_000_000u64, "action_id": "a-1-2"
        }))];
        let arr = to_chrome_trace(&events);
        let first = &arr.get("traceEvents").unwrap().as_array().unwrap()[0];
        assert_eq!(first.get("ph").unwrap(), "i");
        assert_eq!(
            first.get("args").unwrap().get("action_id").unwrap(),
            "a-1-2"
        );
    }

    #[test]
    fn summarize_correlates_by_action_id() {
        let events = vec![
            ev(
                serde_json::json!({"layer":"xstate","name":"SEND","action_id":"a-1-1","ts_wall":1000u64}),
            ),
            ev(
                serde_json::json!({"layer":"adapter","name":"send","action_id":"a-1-1","ts_wall":1002u64}),
            ),
            ev(
                serde_json::json!({"layer":"server","name":"client command","action_id":"a-1-1","ts_wall":1005u64}),
            ),
            ev(serde_json::json!({"layer":"monitor","name":"run","ts_wall":1010u64})),
        ];
        let s = summarize(&events);
        assert!(s.contains("4 events over 10 ms"));
        assert!(s.contains("correlated actions (by action_id): 1"));
        // the action's layer chain is shown
        assert!(s.contains("xstate → adapter → server"));
    }

    #[test]
    fn health_check_detects_reconnects_and_rejections() {
        let events = vec![
            ev(serde_json::json!({
                "layer": "server", "name": "client connect", "session": "main", "ts_wall": 1000u64
            })),
            ev(serde_json::json!({
                "layer": "server", "name": "client reconnect", "session": "main", "ts_wall": 2000u64
            })),
            ev(serde_json::json!({
                "layer": "effect", "name": "fail", "session": "main", "code": "REJECTED", "ts_wall": 3000u64
            })),
            ev(serde_json::json!({
                "layer": "adapter", "name": "send", "session": "test_sess", "ts_wall": 4000u64
            })),
        ];
        let h = health_check(&events);
        assert!(h.contains("events analyzed: 4"));
        assert!(h.contains("sessions tracked: 2"));
        assert!(h.contains("reconnects: 1"));
        assert!(h.contains("rejected commands: 1"));
        assert!(h.contains("main"));
        assert!(h.contains("test_sess"));
    }
}
