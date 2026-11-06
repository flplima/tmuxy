//! The process-wide `tracing` subscriber every tmuxy binary installs: the
//! standalone `tmuxy-server`, and the desktop app for its window and for
//! `tmuxy server …`. Without one, `error!`/`warn!` logs (the fatal dev-mode
//! port-collision message among them) are dropped, and a server exits with no
//! diagnostic output.
//!
//! Every filter names tmuxy's crates by their common `tmuxy` prefix (a
//! directive's target matches by prefix), so a crate added to the workspace
//! logs without being listed here.

mod log_file;

/// The filter used when `RUST_LOG` says nothing.
const DEFAULT_LOG_FILTER: &str = "tmuxy=info,warn";

/// What the log file keeps: tmuxy's own lines, never a dependency's.
const FILE_LOG_FILTER: &str = "tmuxy=info";

/// The trace layer gets its OWN filter, decoupled from stderr's: it captures
/// DEBUG from the tmuxy crates so the hot-path `debug!` signal events (command
/// verb, emit seq) land in the trace file without spamming stderr.
const TRACE_LOG_FILTER: &str = "tmuxy=debug";

/// The stderr `fmt` layer and the NDJSON `trace` layer (`docs/TRACING.md`).
/// The trace layer stays a no-op until [`crate::trace::init`] installs the
/// writer, so registering it costs nothing when tracing is off.
pub fn init_logging() {
    install(None);
}

/// [`init_logging`], plus the tmuxy crates' lines at `info` and above appended
/// to `log_file`, without colour, rotated once it grows past a few MiB
/// (`log_file::RotatingLog`). The desktop app's stderr goes nowhere when
/// it is launched from Finder; the file is what a bug report attaches
/// (Help ▸ Reveal Log File) and what the smoke tests read. A file that cannot
/// be opened costs only the file: stderr and the trace are installed as usual.
pub fn init_logging_to_file(log_file: &std::path::Path) {
    match log_file::RotatingLog::open(log_file) {
        Ok(file) => install(Some(file)),
        Err(e) => {
            install(None);
            tracing::warn!(path = %log_file.display(), error = %e, "log file not opened");
        }
    }
}

fn install(log_file: Option<log_file::RotatingLog>) {
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{fmt, EnvFilter};

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_LOG_FILTER));
    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(std::io::stderr);
    let file_layer = log_file.map(|file| {
        fmt::layer()
            .with_target(true)
            .with_thread_ids(false)
            .with_ansi(false)
            .with_writer(std::sync::Arc::new(file))
            .with_filter(EnvFilter::new(FILE_LOG_FILTER))
    });
    tracing_subscriber::registry()
        .with(stderr_layer.with_filter(filter))
        .with(file_layer)
        .with(crate::trace::TraceLayer.with_filter(EnvFilter::new(TRACE_LOG_FILTER)))
        .try_init()
        .ok();
}
