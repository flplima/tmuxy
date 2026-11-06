//! Local action tracing — see `docs/TRACING.md`.
//!
//! Off by default. When enabled, writes a single append-only NDJSON file that
//! **never leaves the machine**, used only to reconstruct cross-layer behaviour
//! when debugging. It captures the *shape* of actions (typed variants, ids,
//! timing) via a `tracing` `Layer`, never terminal content:
//!
//! - a **target allowlist** admits only `tmuxy_core` / `tmuxy_server` /
//!   `tmuxy_tauri` events, and the layer's floor is `debug`: raw control-mode
//!   output is logged at `trace`, which never reaches it;
//! - a **field allowlist** keeps only content-free keys verbatim, **hashes**
//!   name/path-like keys to a stable opaque id, and **scrubs+truncates**
//!   error/message strings; everything else is dropped.
//!
//! The writer runs on a dedicated thread behind a bounded channel and is
//! **lossy under pressure** (drops events rather than block the hot path), so
//! the instrument cannot stall the interactive path it is measuring.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::TrySendError;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

mod layer;
use layer::TraceHandle;
pub use layer::TraceLayer;
mod redact;
pub mod schema;
#[cfg(test)]
use layer::{target_allowed, FieldVisitor};
pub use redact::redact_command;
use redact::{bound, full_only, hash_str, scrub};

/// Bounded queue between the emit sites and the writer thread. When full, new
/// events are dropped (counted) rather than blocking the caller.
const CHANNEL_CAP: usize = 8192;
/// Rotate the file once it exceeds this size; one `.1` backup is kept.
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Cap for scrubbed free-text (error/message) fields.
const MAX_SCRUB: usize = 200;

/// Truncation bound for free-text fields kept at `Full`.
const MAX_FULL: usize = 500;

/// The writer thread + its file. Created at most once per process: turning
/// tracing off parks it rather than tearing it down, so a user flipping the
/// menu switch back on resumes writing to the same file instantly.
static WRITER: OnceLock<TraceHandle> = OnceLock::new();
/// Whether events are currently being recorded. Separate from `WRITER` because
/// the switch is runtime-controllable (the app's Debug menu) while the writer
/// is not re-creatable — every hot-path guard reads this.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// The file tracing will use, resolved at init even when tracing is off, so a
/// later switch-on lands on the `--trace <path>` the operator named rather than
/// silently reverting to the default.
static RESOLVED_PATH: OnceLock<PathBuf> = OnceLock::new();
static PROCESS_START: OnceLock<Instant> = OnceLock::new();
/// Current level as a `TraceLevel` discriminant. Runtime-settable, so a user
/// can raise detail for one reproduction and drop back without restarting.
static LEVEL: AtomicU8 = AtomicU8::new(TraceLevel::Shape as u8);
static SALT: OnceLock<u64> = OnceLock::new();

/// Usefulness↔sensitivity dial (docs/TRACING.md). `Shape` is the safe,
/// shareable default (typed variants, ids, hashed names, no strings). `Labeled`
/// un-hashes names/paths and keeps error text (reveals project/dir names).
/// `Full` additionally keeps command strings — local-debug only, never share.
/// Pane output and keystroke payloads are never captured at any level.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum TraceLevel {
    Shape = 0,
    Labeled = 1,
    Full = 2,
}

impl TraceLevel {
    /// Wire/config name. Paired with [`TraceLevel::parse`].
    pub fn as_str(self) -> &'static str {
        match self {
            TraceLevel::Shape => "shape",
            TraceLevel::Labeled => "labeled",
            TraceLevel::Full => "full",
        }
    }

    /// Parse a wire/config name. Anything unrecognised is the safe default,
    /// so a stale config or a typo can never silently raise sensitivity.
    pub fn parse(s: &str) -> TraceLevel {
        match s.trim() {
            "labeled" => TraceLevel::Labeled,
            "full" => TraceLevel::Full,
            _ => TraceLevel::Shape,
        }
    }

    fn from_u8(v: u8) -> TraceLevel {
        match v {
            1 => TraceLevel::Labeled,
            2 => TraceLevel::Full,
            _ => TraceLevel::Shape,
        }
    }
}

fn process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

fn level() -> TraceLevel {
    TraceLevel::from_u8(LEVEL.load(Ordering::Relaxed))
}

/// Human name of the active level, for the startup announce and the UI.
pub fn level_name() -> &'static str {
    level().as_str()
}

/// Change the level for subsequent events. Takes effect immediately — already
/// written lines keep the level they were recorded at.
fn set_level(level: TraceLevel) {
    LEVEL.store(level as u8, Ordering::Relaxed);
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

/// Resolve the gating rules from `docs/TRACING.md` and, if tracing should be
/// on, spawn the writer, start recording and say so on stderr — loudly, so a
/// trace is never a surprise. Returns the resolved file path when enabled,
/// `None` when off.
///
/// Precedence, highest first:
/// 1. the `DO_NOT_TRACK` / `TMUXY_NO_TRACE` kill switches — always off;
/// 2. an explicit `--trace` (`flag`) — the operator asked for it by name;
/// 3. the saved preference (the app's Debug menu switch), which is also how a
///    user turns a development build's automatic tracing back OFF;
/// 4. a development build (`debug_assertions`) or `dev_mode`.
///
/// Idempotent: a second call returns the already-resolved path.
pub fn init(flag: Option<Option<String>>, dev_mode: bool) -> Option<PathBuf> {
    if let Some(existing) = WRITER.get() {
        return is_enabled().then(|| existing.path.clone());
    }
    if kill_switch() {
        return None;
    }
    let saved = load_prefs();
    // TMUXY_TRACE_LEVEL still wins for a one-off run; otherwise the saved
    // choice, otherwise the safe default.
    set_level(match std::env::var("TMUXY_TRACE_LEVEL") {
        Ok(v) => TraceLevel::parse(&v),
        Err(_) => saved.as_ref().map(|p| p.level).unwrap_or(TraceLevel::Shape),
    });

    let enabled = resolve_enabled(
        flag.is_some(),
        saved.as_ref().map(|p| p.enabled),
        dev_mode || cfg!(debug_assertions),
    );
    // Remember where tracing WOULD write, without creating anything: the UI can
    // show and copy the path, and a later switch-on has somewhere to go. Off
    // means off — a normal install must leave no file behind at all.
    if let Some(p) = flag.flatten().filter(|s| !s.is_empty()) {
        let named = PathBuf::from(p);
        let taken = RESOLVED_PATH.set(named).err();
        if let Some(named) = taken.filter(|named| *named != trace_path()) {
            eprintln!(
                "tmuxy: --trace {} is ignored: this process already traces to {}",
                named.display(),
                trace_path().display()
            );
        }
    }
    if !enabled {
        return None;
    }
    let path = match start_writer() {
        Ok(path) => path,
        Err(e) => {
            eprintln!(
                "tmuxy: action tracing is OFF: {} cannot be written ({e})",
                trace_path().display()
            );
            return None;
        }
    };
    ACTIVE.store(true, Ordering::Relaxed);
    eprintln!(
        "tmuxy: action tracing ON [level={}] → {} (local only, never uploaded; \
         TMUXY_TRACE_LEVEL=shape|labeled|full; DO_NOT_TRACK=1 or TMUXY_NO_TRACE=1 to disable)",
        level_name(),
        path.display()
    );
    Some(path)
}

/// The gating rules of [`init`] as a pure function of their inputs, so the
/// precedence is testable without touching the global writer or the disk. The
/// kill switch is handled by the caller (it also suppresses path resolution).
fn resolve_enabled(flag: bool, saved: Option<bool>, dev: bool) -> bool {
    if flag {
        return true;
    }
    // A saved choice beats the development-build default in BOTH directions:
    // it is how a user turns a dev build's automatic tracing off.
    saved.unwrap_or(dev)
}

/// Spawn the writer thread once and return the file it owns. Called only when
/// tracing actually starts recording — creating the file is what "on" means.
fn start_writer() -> std::io::Result<PathBuf> {
    if let Some(existing) = WRITER.get() {
        return Ok(existing.path.clone());
    }
    let handle = TraceHandle::spawn(trace_path())?;
    let path = handle.path.clone();
    let _ = WRITER.set(handle);
    // Anchor the monotonic origin at (or before) the first event.
    let _ = process_start();
    Ok(path)
}

/// Whether tracing is currently recording. Cheap: a single atomic load.
pub fn is_enabled() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// The file tracing writes to, whether or not it is currently recording, so the
/// UI can show and copy it: the `--trace <path>` the operator named, else the
/// state dir's. Resolving does NOT create it.
pub fn trace_path() -> PathBuf {
    RESOLVED_PATH.get_or_init(crate::paths::trace_file).clone()
}

/// Whether the kill switch forbids tracing in this process. The UI disables its
/// switch when true rather than offering a toggle that cannot take effect.
pub fn is_locked_off() -> bool {
    kill_switch()
}

/// Turn recording on or off at runtime and remember the choice for next launch.
/// Returns the state actually in force — a `true` request is refused when the
/// kill switch is set or no writer could be created.
pub fn set_enabled(on: bool) -> bool {
    let effective = on && !kill_switch() && start_writer().is_ok();
    ACTIVE.store(effective, Ordering::Relaxed);
    save_prefs(effective, level());
    effective
}

/// Change the level and remember it, for the UI's level picker.
pub fn set_level_persisted(level: TraceLevel) {
    set_level(level);
    save_prefs(is_enabled(), level);
}

// --- Saved preference -------------------------------------------------------

/// The user's Debug-menu choice, in the state dir beside the trace itself
/// (`trace.json`): this machine's choice, not config. Deliberately tiny and
/// hand-editable.
struct TracePrefs {
    enabled: bool,
    level: TraceLevel,
}

fn prefs_path() -> PathBuf {
    crate::paths::state_dir().join(crate::paths::TRACE_PREFS.name)
}

fn load_prefs() -> Option<TracePrefs> {
    let text = std::fs::read_to_string(prefs_path()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Some(TracePrefs {
        enabled: v.get("enabled")?.as_bool()?,
        level: v
            .get("level")
            .and_then(Value::as_str)
            .map(TraceLevel::parse)
            .unwrap_or(TraceLevel::Shape),
    })
}

/// Best-effort: a read-only config dir must not break the toggle for this run.
fn save_prefs(enabled: bool, level: TraceLevel) {
    let path = prefs_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = format!(
        "{{\n  \"enabled\": {},\n  \"level\": {:?}\n}}\n",
        enabled,
        level.as_str()
    );
    let _ = crate::private_files::replace(&path, body);
}

fn kill_switch() -> bool {
    kill_switch_in(|var| std::env::var(var).ok())
}

/// [`kill_switch`] over a reader of the environment, so the rule is testable
/// without touching the process's.
fn kill_switch_in(var: impl Fn(&str) -> Option<String>) -> bool {
    ["DO_NOT_TRACK", "TMUXY_NO_TRACE"]
        .into_iter()
        .any(|name| var(name).is_some_and(|v| !v.is_empty() && v != "0"))
}

// =============================================================================
// Public emit surface
// =============================================================================

/// Sanitize + record a client-originated trace event. The browser/Tauri tracer
/// is designed to send only content-free shapes, but the ingest path never
/// trusts it: every field goes through the same [`admit`] as a Rust event's,
/// so a field carrying content is dropped or hashed here too. No-op when
/// tracing is disabled. Client-supplied `ts_wall`/`ts_mono` are preserved
/// (they belong to the client's clock); the server fills them only if absent.
pub fn record_client_event(fields: Map<String, Value>) {
    if !is_enabled() {
        return;
    }
    emit(sanitize_client_fields(fields, level()));
}

/// Every field of a client's event that [`admit`] keeps.
fn sanitize_client_fields(input: Map<String, Value>, lvl: TraceLevel) -> Map<String, Value> {
    input
        .into_iter()
        .filter_map(|(key, value)| Some((key.clone(), admit(&key, value, lvl)?)))
        .collect()
}

/// The longest structural value a client may send.
const MAX_STRUCTURAL: usize = 64;

/// `[A-Za-z0-9_.:-]{1,64}`: what an event type or command name looks like.
fn is_identifier(s: &str) -> bool {
    (1..=MAX_STRUCTURAL).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

/// The one field policy (`schema::class_of`), for a Rust event's fields and
/// a client's alike: what `key` may record of `value` at `lvl`, or `None`
/// to drop it.
fn admit(key: &str, value: Value, lvl: TraceLevel) -> Option<Value> {
    use schema::FieldClass;
    let text = |value: &Value| value.as_str().map(str::to_string);
    match schema::class_of(key)? {
        FieldClass::Structural => text(&value).filter(|s| is_identifier(s)).map(Value::from),
        FieldClass::Verbatim => Some(match value {
            Value::String(s) => Value::from(scrub(&s)),
            other => other,
        }),
        FieldClass::Hashed => text(&value).map(|s| {
            Value::from(if lvl == TraceLevel::Shape {
                hash_str(&s)
            } else {
                bound(&s, MAX_FULL)
            })
        }),
        FieldClass::Scrubbed => text(&value).map(|s| {
            Value::from(if lvl == TraceLevel::Full {
                bound(&s, MAX_FULL)
            } else {
                scrub(&s)
            })
        }),
        FieldClass::FullOnly => text(&value)
            .filter(|_| lvl == TraceLevel::Full)
            .map(|s| Value::from(full_only(&s))),
        FieldClass::ClientNumber => value.is_number().then_some(value),
    }
}

fn emit(mut obj: Map<String, Value>) {
    let Some(handle) = WRITER.get().filter(|_| is_enabled()) else {
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
