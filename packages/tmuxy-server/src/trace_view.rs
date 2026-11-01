//! `tmuxy trace` — inspect a local NDJSON action-trace file (docs/TRACING.md).
//!
//! Loads the append-only NDJSON written by the trace `Layer` and the `/trace`
//! ingest, and either prints a per-action summary (correlating by `action_id`)
//! or exports a Chrome-trace / Perfetto JSON timeline (`--export`), which opens
//! directly at ui.perfetto.dev for a flame-graph view across all layers.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

mod health;
pub use health::window;
use health::{github_annotations, health_check};
#[cfg(test)]
use health::{silent_panes, SilentPane, SILENT_PANE_MIN_MS};

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

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
            match tmuxy_core::private_files::write(Path::new(&out), bytes) {
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

/// Resolve the file to read: the explicit arg, else the file the server
/// writes by default (`tmuxy_core::paths::trace_file`) if it exists.
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
    let path = tmuxy_core::paths::trace_file();
    if let Some(dir) = path.parent() {
        let _ = tmuxy_core::private_files::create_dir_all(dir);
    }
    path
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
    let mut file = tmuxy_core::private_files::open_append(path)
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
