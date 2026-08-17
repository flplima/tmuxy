//! Local action tracing — see `docs/TELEMETRY.md`.
//!
//! Off by default. When enabled, writes a single append-only NDJSON file that
//! **never leaves the machine**, used only to reconstruct cross-layer behaviour
//! when debugging. It captures the *shape* of actions (typed variants, ids,
//! timing) via a `tracing` `Layer`, never terminal content:
//!
//! - a **target allowlist** admits only `tmuxy_core` / `tmuxy_server` /
//!   `tmuxy_tauri` events and explicitly excludes the `tmuxy::debug_log` target
//!   (which drains raw control-mode output to `~/tmuxy-debug.log`);
//! - a **field allowlist** keeps only content-free keys verbatim, **hashes**
//!   name/path-like keys to a stable opaque id, and **scrubs+truncates**
//!   error/message strings; everything else is dropped.
//!
//! The writer runs on a dedicated thread behind a bounded channel and is
//! **lossy under pressure** (drops events rather than block the hot path), so
//! the instrument cannot stall the interactive path it is measuring.

use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{span, Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

/// Bounded queue between the emit sites and the writer thread. When full, new
/// events are dropped (counted) rather than blocking the caller.
const CHANNEL_CAP: usize = 8192;
/// Rotate the file once it exceeds this size; one `.1` backup is kept.
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Cap for scrubbed free-text (error/message) fields.
const MAX_SCRUB: usize = 200;

/// Field keys recorded verbatim — all content-free (typed variants, ids,
/// counts, timing). Numbers and strings under these keys pass through as-is.
const VERBATIM: &[&str] = &[
    "op",
    "argc",
    "session",
    "pane",
    "window",
    "seq",
    "conn_id",
    "cols",
    "rows",
    "count",
    "action_id",
    "kind",
    "variant",
    "lagged",
    "code",
    "attempt",
    "max_retries",
    "finished",
    "port",
    "role",
    "verb",
];

/// Field keys hashed to a stable opaque id — user-chosen names/paths that could
/// carry content (VS Code hashes a folder's git remote rather than its name).
/// Un-hashed at `Labeled`/`Full`.
const HASH_FIELDS: &[&str] = &["name", "new_name", "title", "path", "cwd", "file"];

/// Field keys scrubbed (home-dir redacted) and truncated — free text that may
/// quote a command or output (VS Code scrubs user paths out of stack traces).
/// Kept (bounded) at `Full`.
const SCRUB_FIELDS: &[&str] = &["error", "message", "reason", "detail"];

/// Field keys admitted only at `Full` — raw command strings whose args can carry
/// arbitrary content (e.g. `run-shell`). Dropped at `Shape`/`Labeled`.
const FULL_ONLY: &[&str] = &["command", "args"];

/// Truncation bound for free-text fields kept at `Full`.
const MAX_FULL: usize = 500;

static WRITER: OnceLock<TraceHandle> = OnceLock::new();
static PROCESS_START: OnceLock<Instant> = OnceLock::new();
static LEVEL: OnceLock<TraceLevel> = OnceLock::new();
static SALT: OnceLock<u64> = OnceLock::new();

/// Usefulness↔sensitivity dial (docs/TELEMETRY.md). `Shape` is the safe,
/// shareable default (typed variants, ids, hashed names, no strings). `Labeled`
/// un-hashes names/paths and keeps error text (reveals project/dir names).
/// `Full` additionally keeps command strings — local-debug only, never share.
/// Pane output and keystroke payloads are never captured at any level.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TraceLevel {
    Shape,
    Labeled,
    Full,
}

fn process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

fn level() -> TraceLevel {
    *LEVEL.get().unwrap_or(&TraceLevel::Shape)
}

/// Human name of the active level, for the startup announce.
pub fn level_name() -> &'static str {
    match level() {
        TraceLevel::Shape => "shape",
        TraceLevel::Labeled => "labeled",
        TraceLevel::Full => "full",
    }
}

fn parse_level() -> TraceLevel {
    match std::env::var("TMUXY_TRACE_LEVEL")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("labeled") => TraceLevel::Labeled,
        Some("full") => TraceLevel::Full,
        _ => TraceLevel::Shape,
    }
}

/// Per-process random salt so a hashed name can't be confirmed by hashing a
/// guessed value, and hashes don't correlate across separate trace files. The
/// tradeoff: ids are NOT stable across runs (a window hashes differently next
/// launch). `RandomState` is seeded from the OS RNG.
fn salt() -> u64 {
    *SALT.get_or_init(|| {
        use std::hash::BuildHasher;
        std::collections::hash_map::RandomState::new().hash_one("tmuxy-trace")
    })
}

// =============================================================================
// Gating & initialisation
// =============================================================================

/// Resolve the gating rules from `docs/TELEMETRY.md` and, if tracing should be
/// on, spawn the writer and install the global handle. Returns the resolved
/// file path when enabled, `None` when off.
///
/// Precedence: the `DO_NOT_TRACK` / `TMUXY_NO_TRACE` kill switches win over
/// everything; then an explicit `--trace` (`flag`) turns it on; otherwise a
/// development build (`debug_assertions`) or `dev_mode` turns it on. Idempotent.
pub fn init(flag: Option<Option<String>>, dev_mode: bool) -> Option<PathBuf> {
    if let Some(existing) = WRITER.get() {
        return Some(existing.path.clone());
    }
    if kill_switch() {
        return None;
    }
    let enabled = flag.is_some() || dev_mode || cfg!(debug_assertions);
    if !enabled {
        return None;
    }
    let _ = LEVEL.set(parse_level());
    let path = match flag.flatten().filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_path()?,
    };
    let handle = TraceHandle::spawn(path)?;
    let path = handle.path.clone();
    let _ = WRITER.set(handle);
    // Anchor the monotonic origin at (or before) the first event.
    let _ = process_start();
    Some(path)
}

/// Whether tracing is currently active. Cheap: a single atomic load.
pub fn is_enabled() -> bool {
    WRITER.get().is_some()
}

fn kill_switch() -> bool {
    is_truthy("DO_NOT_TRACK") || is_truthy("TMUXY_NO_TRACE")
}

fn is_truthy(var: &str) -> bool {
    std::env::var(var)
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false)
}

/// Default trace path under the XDG state dir (`~/.local/state/tmuxy` on Linux,
/// Application Support on macOS) — deliberately outside any directory served by
/// `/api/file`.
fn default_path() -> Option<PathBuf> {
    let dir = dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))?
        .join("tmuxy");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("trace.ndjson"))
}

// =============================================================================
// Public emit surface
// =============================================================================

/// Sanitize + record a client-originated trace event. The browser/Tauri tracer
/// is designed to send only content-free shapes, but the ingest path never
/// trusts it: every field is re-run through the same allowlist/scrub the Rust
/// layer uses, so a field carrying content is dropped or hashed here too. No-op
/// when tracing is disabled. Client-supplied `ts_wall`/`ts_mono` are preserved
/// (they belong to the client's clock); the server fills them only if absent.
pub fn record_client_event(fields: Map<String, Value>) {
    if WRITER.get().is_none() {
        return;
    }
    emit(sanitize_client_fields(fields));
}

/// Re-apply the field allowlist to an arbitrary client-supplied map. Structural
/// keys (`layer`/`component`/`name`/`phase`/`level`) are kept but bounded;
/// content-free ids/counts pass through; name/path keys are hashed; free text is
/// scrubbed; everything else is dropped.
pub fn sanitize_client_fields(input: Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in input {
        if let Some(admitted) = admit_json(&key, value) {
            out.insert(key, admitted);
        }
    }
    out
}

/// Structural keys the client controls; safe but bounded so a hostile client
/// can't smuggle a payload through them.
const STRUCTURAL: &[&str] = &["layer", "component", "name", "phase", "level"];
/// Numeric keys accepted verbatim from a client (timing/correlation).
const CLIENT_NUM: &[&str] = &["ts_wall", "ts_mono", "dur_us"];

fn admit_json(key: &str, value: Value) -> Option<Value> {
    admit_json_at(key, value, level())
}

fn admit_json_at(key: &str, value: Value, lvl: TraceLevel) -> Option<Value> {
    if STRUCTURAL.contains(&key) || VERBATIM.contains(&key) {
        return Some(bound_string(value));
    }
    if HASH_FIELDS.contains(&key) {
        return match value {
            Value::String(s) => Some(Value::from(if lvl == TraceLevel::Shape {
                hash_str(&s)
            } else {
                bound(&s, MAX_FULL)
            })),
            _ => None,
        };
    }
    if SCRUB_FIELDS.contains(&key) {
        return match value {
            Value::String(s) => Some(Value::from(if lvl == TraceLevel::Full {
                bound(&s, MAX_FULL)
            } else {
                scrub(&s)
            })),
            _ => None,
        };
    }
    if FULL_ONLY.contains(&key) && lvl == TraceLevel::Full {
        return match value {
            Value::String(s) => Some(Value::from(bound(&s, MAX_FULL))),
            _ => None,
        };
    }
    if CLIENT_NUM.contains(&key) && value.is_number() {
        return Some(value);
    }
    None
}

/// Numbers/bools pass; strings are scrubbed (which also bounds length).
fn bound_string(value: Value) -> Value {
    match value {
        Value::String(s) => Value::from(scrub(&s)),
        other => other,
    }
}

fn emit(mut obj: Map<String, Value>) {
    let Some(handle) = WRITER.get() else {
        return;
    };
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    obj.entry("ts_wall".to_string())
        .or_insert_with(|| Value::from(wall));
    obj.entry("ts_mono".to_string())
        .or_insert_with(|| Value::from(process_start().elapsed().as_micros() as u64));
    let line = Value::Object(obj).to_string();
    if let Err(TrySendError::Full(_)) = handle.tx.try_send(line) {
        handle.dropped.fetch_add(1, Ordering::Relaxed);
    }
}

// =============================================================================
// Writer thread
// =============================================================================

struct TraceHandle {
    tx: SyncSender<String>,
    path: PathBuf,
    dropped: Arc<AtomicU64>,
}

impl TraceHandle {
    fn spawn(path: PathBuf) -> Option<Self> {
        let (tx, rx) = sync_channel::<String>(CHANNEL_CAP);
        let dropped = Arc::new(AtomicU64::new(0));
        let writer_dropped = dropped.clone();
        let writer_path = path.clone();
        std::thread::Builder::new()
            .name("tmuxy-trace".to_string())
            .spawn(move || writer_loop(rx, writer_path, writer_dropped))
            .ok()?;
        Some(Self { tx, path, dropped })
    }
}

fn writer_loop(rx: Receiver<String>, path: PathBuf, dropped: Arc<AtomicU64>) {
    let mut file = match open_append(&path) {
        Some(f) => f,
        None => return,
    };
    let mut size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut reported_dropped = 0u64;

    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(line) => {
                write_line(&mut file, &mut size, &path, &line);
                // Drain everything queued, then flush once — one fsync-free
                // flush per burst rather than per line.
                while let Ok(next) = rx.try_recv() {
                    write_line(&mut file, &mut size, &path, &next);
                }
                let _ = file.flush();
            }
            Err(RecvTimeoutError::Timeout) => {
                let d = dropped.load(Ordering::Relaxed);
                if d != reported_dropped {
                    reported_dropped = d;
                    let meta =
                        format!("{{\"layer\":\"trace\",\"name\":\"overflow\",\"dropped\":{d}}}");
                    write_line(&mut file, &mut size, &path, &meta);
                    let _ = file.flush();
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = file.flush();
                break;
            }
        }
    }
}

fn write_line(file: &mut File, size: &mut u64, path: &Path, line: &str) {
    let needed = line.len() as u64 + 1;
    if *size + needed > MAX_BYTES {
        if let Some((f, s)) = rotate(path) {
            *file = f;
            *size = s;
        }
    }
    if file.write_all(line.as_bytes()).is_ok() && file.write_all(b"\n").is_ok() {
        *size += needed;
    }
}

/// Rename the current file to `<path>.1` (overwriting any previous backup) and
/// reopen a fresh empty file. Best-effort: on failure the caller keeps writing
/// to the existing handle.
fn rotate(path: &Path) -> Option<(File, u64)> {
    let backup = PathBuf::from(format!("{}.1", path.display()));
    std::fs::rename(path, &backup).ok()?;
    let file = open_append(path)?;
    Some((file, 0))
}

fn open_append(path: &Path) -> Option<File> {
    use std::fs::OpenOptions;
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path).ok()?;
    // Tighten perms even if the file pre-existed with a looser mode — the trace
    // is sensitive activity metadata even though it carries no content.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Some(file)
}

// =============================================================================
// Redaction helpers
// =============================================================================

/// Stable, non-cryptographic hash for de-identifying a name/path. `DefaultHasher`
/// uses fixed keys, so the id is stable within and across runs — enough to
/// correlate "same window" without recording the window's name.
fn hash_str(s: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    salt().hash(&mut h);
    s.hash(&mut h);
    format!("h:{:016x}", h.finish())
}

/// Redact the home directory to `~` and truncate. serde escaping already keeps
/// newlines from breaking the NDJSON framing; this bounds size and strips the
/// most common absolute-path leak.
fn scrub(s: &str) -> String {
    let replaced = match dirs::home_dir().and_then(|h| h.to_str().map(String::from)) {
        Some(home) if !home.is_empty() => s.replace(&home, "~"),
        _ => s.to_string(),
    };
    replaced.chars().take(MAX_SCRUB).collect()
}

/// Truncate to `n` chars without any redaction (used for values already deemed
/// safe, or at `Full` where content is explicitly opted in).
fn bound(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// =============================================================================
// tracing Layer
// =============================================================================

/// The `tracing_subscriber` layer that turns admitted spans/events into NDJSON
/// lines. Registered once by `tmuxy_server::init_logging`; a no-op until
/// [`init`] installs the writer.
pub struct TraceLayer;

impl<S> Layer<S> for TraceLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        if WRITER.get().is_none() {
            return;
        }
        let meta = event.metadata();
        let target = meta.target();
        if !target_allowed(target) {
            return;
        }
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let mut obj = visitor.fields;
        obj.insert("layer".to_string(), Value::from(layer_for(target)));
        obj.insert("component".to_string(), Value::from(target.to_string()));
        obj.insert(
            "name".to_string(),
            Value::from(visitor.message.unwrap_or_else(|| meta.name().to_string())),
        );
        obj.insert("phase".to_string(), Value::from("event"));
        obj.insert("level".to_string(), Value::from(meta.level().as_str()));
        emit(obj);
    }

    fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, ctx: Context<'_, S>) {
        if WRITER.get().is_none() {
            return;
        }
        let meta = attrs.metadata();
        if !target_allowed(meta.target()) {
            return;
        }
        let mut visitor = FieldVisitor::default();
        attrs.record(&mut visitor);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(SpanState {
                start: Instant::now(),
                fields: visitor.fields,
                name: meta.name().to_string(),
                target: meta.target().to_string(),
            });
        }
    }

    fn on_close(&self, id: span::Id, ctx: Context<'_, S>) {
        if WRITER.get().is_none() {
            return;
        }
        let Some(span) = ctx.span(&id) else {
            return;
        };
        let ext = span.extensions();
        let Some(state) = ext.get::<SpanState>() else {
            return;
        };
        let mut obj = state.fields.clone();
        obj.insert("layer".to_string(), Value::from(layer_for(&state.target)));
        obj.insert("component".to_string(), Value::from(state.target.clone()));
        obj.insert("name".to_string(), Value::from(state.name.clone()));
        obj.insert("phase".to_string(), Value::from("span"));
        obj.insert(
            "dur_us".to_string(),
            Value::from(state.start.elapsed().as_micros() as u64),
        );
        emit(obj);
    }
}

/// Per-span state kept in the registry's extensions between open and close.
struct SpanState {
    start: Instant,
    fields: Map<String, Value>,
    name: String,
    target: String,
}

fn target_allowed(target: &str) -> bool {
    if target.starts_with("tmuxy::debug_log") {
        return false;
    }
    target.starts_with("tmuxy_core")
        || target.starts_with("tmuxy_server")
        || target.starts_with("tmuxy_tauri")
}

fn layer_for(target: &str) -> &'static str {
    if target.contains("control_mode") {
        "monitor"
    } else if target.contains("tmux_service") {
        "tmux"
    } else if target.contains("emit") {
        "emitter"
    } else if target.contains("state") {
        "aggregator"
    } else if target.starts_with("tmuxy_server") || target.starts_with("tmuxy_tauri") {
        "server"
    } else {
        "core"
    }
}

/// Field visitor implementing the allowlist + scrub policy. Anything not
/// explicitly admitted is silently dropped.
#[derive(Default)]
struct FieldVisitor {
    fields: Map<String, Value>,
    message: Option<String>,
}

impl FieldVisitor {
    fn put_str(&mut self, key: &str, value: &str) {
        let lvl = level();
        if key == "message" {
            self.message = Some(if lvl == TraceLevel::Full {
                bound(value, MAX_FULL)
            } else {
                scrub(value)
            });
        } else if VERBATIM.contains(&key) {
            self.fields
                .insert(key.to_string(), Value::from(bound(value, MAX_FULL)));
        } else if HASH_FIELDS.contains(&key) {
            // Shape hashes user-chosen names; Labeled/Full keep them plaintext.
            let v = if lvl == TraceLevel::Shape {
                hash_str(value)
            } else {
                bound(value, MAX_FULL)
            };
            self.fields.insert(key.to_string(), Value::from(v));
        } else if SCRUB_FIELDS.contains(&key) {
            let v = if lvl == TraceLevel::Full {
                bound(value, MAX_FULL)
            } else {
                scrub(value)
            };
            self.fields.insert(key.to_string(), Value::from(v));
        } else if FULL_ONLY.contains(&key) && lvl == TraceLevel::Full {
            self.fields
                .insert(key.to_string(), Value::from(bound(value, MAX_FULL)));
        }
    }

    fn put_num(&mut self, key: &str, value: Value) {
        if VERBATIM.contains(&key) {
            self.fields.insert(key.to_string(), value);
        }
    }
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put_str(field.name(), value);
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        // `%x` (Display) and `?x` (Debug) fields, and the event message, all
        // arrive here. Debug adds surrounding quotes for strings — trim them so
        // classification and scrubbing see the underlying value.
        let rendered = format!("{value:?}");
        self.put_str(field.name(), rendered.trim_matches('"'));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put_num(field.name(), Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put_num(field.name(), Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put_num(field.name(), Value::from(value));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_admits_only_tmuxy_targets_and_excludes_debug_log() {
        assert!(target_allowed("tmuxy_core::control_mode::monitor"));
        assert!(target_allowed("tmuxy_server::sse"));
        assert!(!target_allowed("tmuxy::debug_log"));
        assert!(!target_allowed("hyper::proto"));
        assert!(!target_allowed("tower::buffer"));
    }

    #[test]
    fn verbatim_keys_pass_through_but_unknown_keys_drop() {
        let mut v = FieldVisitor::default();
        v.put_str("op", "split-window");
        v.put_str("session", "work");
        v.put_str("command", "send-keys -l secret-password");
        v.put_num("seq", Value::from(42u64));
        v.put_num("secret_count", Value::from(9u64));

        assert_eq!(v.fields.get("op").unwrap(), "split-window");
        assert_eq!(v.fields.get("session").unwrap(), "work");
        assert_eq!(v.fields.get("seq").unwrap(), 42);
        // Not on any list → dropped entirely.
        assert!(!v.fields.contains_key("command"));
        assert!(!v.fields.contains_key("secret_count"));
    }

    #[test]
    fn name_and_path_fields_are_hashed_not_stored_raw() {
        let mut v = FieldVisitor::default();
        v.put_str("name", "my-secret-window-title");
        v.put_str("path", "/home/alice/projects/acme/secret.txt");

        let name = v.fields.get("name").unwrap().as_str().unwrap();
        let path = v.fields.get("path").unwrap().as_str().unwrap();
        assert!(name.starts_with("h:"));
        assert!(path.starts_with("h:"));
        assert!(!name.contains("secret"));
        assert!(!path.contains("secret"));
        // Stable: same input → same id.
        assert_eq!(name, hash_str("my-secret-window-title"));
    }

    #[test]
    fn error_and_message_are_scrubbed_and_truncated() {
        let mut v = FieldVisitor::default();
        let long = "x".repeat(500);
        v.put_str("error", &long);
        assert_eq!(
            v.fields.get("error").unwrap().as_str().unwrap().len(),
            MAX_SCRUB
        );

        // message is captured separately as the event name, still scrubbed.
        let mut v2 = FieldVisitor::default();
        v2.put_str("message", &"y".repeat(500));
        assert_eq!(v2.message.as_ref().unwrap().len(), MAX_SCRUB);
    }

    #[test]
    fn sanitize_client_fields_drops_content_and_hashes_names() {
        let mut input = Map::new();
        input.insert("layer".into(), Value::from("xstate"));
        input.insert("name".into(), Value::from("SEND_TMUX_COMMAND"));
        input.insert("phase".into(), Value::from("event"));
        input.insert("op".into(), Value::from("split-window"));
        input.insert("pane".into(), Value::from("%3"));
        input.insert("ts_wall".into(), Value::from(1_700_000_000_000u64));
        // A hostile/careless client trying to smuggle terminal content:
        input.insert("command".into(), Value::from("send-keys -l my-password"));
        input.insert("keys".into(), Value::from("password123"));
        input.insert("title".into(), Value::from("secret-project"));

        let out = super::sanitize_client_fields(input);

        assert_eq!(out.get("layer").unwrap(), "xstate");
        assert_eq!(out.get("op").unwrap(), "split-window");
        assert_eq!(out.get("pane").unwrap(), "%3");
        assert_eq!(out.get("ts_wall").unwrap(), 1_700_000_000_000u64);
        // Content-bearing keys not on any list are dropped.
        assert!(!out.contains_key("command"));
        assert!(!out.contains_key("keys"));
        // A name/path key is admitted only as an opaque hash.
        let title = out.get("title").unwrap().as_str().unwrap();
        assert!(title.starts_with("h:"));
        assert!(!title.contains("secret"));
    }

    #[test]
    fn levels_trade_hashing_and_command_strings() {
        // Shape: names hashed, command dropped (safe/shareable default).
        assert!(
            super::admit_json_at("title", Value::from("secret-proj"), TraceLevel::Shape)
                .unwrap()
                .as_str()
                .unwrap()
                .starts_with("h:")
        );
        assert!(
            super::admit_json_at("command", Value::from("split-window -h"), TraceLevel::Shape)
                .is_none()
        );

        // Labeled: names in the clear, command still dropped.
        assert_eq!(
            super::admit_json_at("title", Value::from("secret-proj"), TraceLevel::Labeled).unwrap(),
            "secret-proj"
        );
        assert!(super::admit_json_at(
            "command",
            Value::from("split-window -h"),
            TraceLevel::Labeled
        )
        .is_none());

        // Full: command string admitted (local-debug only).
        assert_eq!(
            super::admit_json_at("command", Value::from("split-window -h"), TraceLevel::Full)
                .unwrap(),
            "split-window -h"
        );
    }

    #[test]
    fn kill_switch_env_disables() {
        std::env::set_var("TMUXY_NO_TRACE", "1");
        assert!(kill_switch());
        std::env::remove_var("TMUXY_NO_TRACE");
        std::env::set_var("DO_NOT_TRACK", "1");
        assert!(kill_switch());
        std::env::remove_var("DO_NOT_TRACK");
        assert!(!kill_switch());
    }
}
