use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{span, Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

use super::schema::{self, event, field};
use super::{
    admit, bound, emit, is_enabled, level, scrub, TraceLevel, CHANNEL_CAP, MAX_BYTES, MAX_FULL,
};

// =============================================================================
// Writer thread
// =============================================================================

pub(super) struct TraceHandle {
    pub(super) tx: SyncSender<String>,
    pub(super) path: PathBuf,
    pub(super) dropped: Arc<AtomicU64>,
}

impl TraceHandle {
    /// Open the file, then start the writer on it: a file that cannot be
    /// opened is an error here, before anything says tracing is on.
    pub(super) fn spawn(path: PathBuf) -> std::io::Result<Self> {
        let file = open_append(&path)?;
        let (tx, rx) = sync_channel::<String>(CHANNEL_CAP);
        let dropped = Arc::new(AtomicU64::new(0));
        let writer_dropped = dropped.clone();
        let writer_path = path.clone();
        std::thread::Builder::new()
            .name("tmuxy-trace".to_string())
            .spawn(move || writer_loop(rx, file, writer_path, writer_dropped))?;
        Ok(Self { tx, path, dropped })
    }
}

fn writer_loop(rx: Receiver<String>, mut file: File, path: PathBuf, dropped: Arc<AtomicU64>) {
    let mut size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut reported_dropped = 0u64;

    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(line) => {
                write_line(&mut file, &mut size, &path, &line);
                while let Ok(next) = rx.try_recv() {
                    write_line(&mut file, &mut size, &path, &next);
                }
                let _ = file.flush();
            }
            Err(RecvTimeoutError::Timeout) => {
                let d = dropped.load(Ordering::Relaxed);
                if d != reported_dropped {
                    reported_dropped = d;
                    let meta = serde_json::json!({
                        field::LAYER: schema::Layer::Trace.as_str(),
                        field::NAME: event::OVERFLOW,
                        "dropped": d,
                        field::TS_WALL: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |t| t.as_millis() as u64),
                    })
                    .to_string();
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

fn rotate(path: &Path) -> Option<(File, u64)> {
    let backup = PathBuf::from(format!("{}.1", path.display()));
    std::fs::rename(path, &backup).ok()?;
    let file = open_append(path).ok()?;
    Some((file, 0))
}

fn open_append(path: &Path) -> std::io::Result<File> {
    // The state dir is created here rather than when the path is resolved, so
    // resolving a path for the UI leaves nothing behind while tracing is off.
    if let Some(dir) = path.parent() {
        crate::private_files::create_dir_all(dir)?;
    }
    crate::private_files::open_append(path)
}

// =============================================================================
// tracing Layer
// =============================================================================

/// The `tracing_subscriber` layer that turns admitted spans/events into NDJSON
/// lines. Registered once by `tmuxy_core::logging::init_logging`; a no-op until
/// [`super::init`] installs the writer.
pub struct TraceLayer;

impl<S> Layer<S> for TraceLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if !is_enabled() {
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
        // An event inside a span that names its session (the monitor's
        // `run{session=…}`) belongs to that session even when it does not say
        // so itself — the aggregator, which never knows the session's name.
        if !obj.contains_key("session") {
            if let Some(scope) = ctx.event_scope(event) {
                for span in scope {
                    if let Some(session) = span
                        .extensions()
                        .get::<SpanState>()
                        .and_then(|state| state.fields.get("session").cloned())
                    {
                        obj.insert("session".to_string(), session);
                        break;
                    }
                }
            }
        }
        obj.insert(
            "layer".to_string(),
            Value::from(schema::Layer::of_target(target).as_str()),
        );
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
        if !is_enabled() {
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
        if !is_enabled() {
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
        obj.insert(
            "layer".to_string(),
            Value::from(schema::Layer::of_target(&state.target).as_str()),
        );
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

struct SpanState {
    start: Instant,
    fields: Map<String, Value>,
    name: String,
    target: String,
}

pub(super) fn target_allowed(target: &str) -> bool {
    target.starts_with("tmuxy_core")
        || target.starts_with("tmuxy_server")
        || target.starts_with("tmuxy_tauri")
}

#[derive(Default)]
pub(super) struct FieldVisitor {
    pub(super) fields: Map<String, Value>,
    pub(super) message: Option<String>,
}

impl FieldVisitor {
    /// The event's message is its name, scrubbed like free text.
    pub(super) fn put_str(&mut self, key: &str, value: &str) {
        let lvl = level();
        if key == "message" {
            self.message = Some(if lvl == TraceLevel::Full {
                bound(value, MAX_FULL)
            } else {
                scrub(value)
            });
        } else {
            self.put(key, Value::from(value), lvl);
        }
    }

    pub(super) fn put_num(&mut self, key: &str, value: Value) {
        self.put(key, value, level());
    }

    fn put(&mut self, key: &str, value: Value, lvl: TraceLevel) {
        if let Some(admitted) = admit(key, value, lvl) {
            self.fields.insert(key.to_string(), admitted);
        }
    }
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put_str(field.name(), value);
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        // `%x` (Display) and `?x` (Debug) fields, and the event message, all
        // arrive here; Debug quotes strings, so trim the quotes.
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
