//! The tmuxy web server, and the verbs `tmuxy server <verb>` runs.
//!
//! The public surface is what the desktop binary (`tmuxy-tauri-app`) links:
//! `server` to run the CLI, `connect` for the add-a-server form, and the
//! logging setup. `browser` is public for the engine's integration tests
//! (`tests/browser_engine.rs`). Everything else is this crate's own, so that
//! rustc's dead-code lint can see what nothing uses any more.

mod auth;
pub mod browser;
mod command;
pub mod connect;
mod dev;
mod request_guard;
pub mod server;
mod session_cli;
mod sse;
mod state;
mod trace_view;

pub use command::ClientCommand;

/// Initialize the tracing subscriber for the server.
///
/// Called by both the standalone `tmuxy-server` binary and the combined
/// `tmuxy server` CLI path in the Tauri app. Without this, `error!`/`warn!`
/// logs (including the fatal dev-mode port-collision message) are silently
/// dropped, leaving the server to exit with no diagnostic output.
///
/// Registers two layers: the stderr `fmt` layer (existing behaviour) and the
/// NDJSON `trace` layer (`docs/TELEMETRY.md`). The trace layer stays a no-op
/// until `tmuxy_core::trace::init` installs the writer, so registering it here
/// costs nothing when tracing is off.
pub fn init_logging() {
    init_logging_with(DEFAULT_LOG_FILTER)
}

/// The filter used when `RUST_LOG` says nothing.
pub const DEFAULT_LOG_FILTER: &str = "tmuxy_core=info,tmuxy_server=info,warn";

/// The same, for a command that OWNS THE SCREEN.
///
/// `tmuxy browser --repl` draws a picture of a page over the whole pane; a
/// stray `WARN` from a dependency written to stderr lands in the middle of it,
/// and chromiumoxide emits one for every CDP message it does not model. So the
/// blanket `warn` goes: tmuxy's own logs still appear (they are few, and worth
/// seeing), and `RUST_LOG` still overrides everything when something needs
/// debugging.
pub const QUIET_LOG_FILTER: &str = "tmuxy_core=info,tmuxy_server=info";

/// `init_logging`, with the default filter named explicitly.
pub fn init_logging_with(default_filter: &str) {
    install(default_filter, None);
}

/// `init_logging`, plus the tmuxy crates' lines at `info` and above appended
/// to `log_file`, without colour. The desktop app's stderr goes nowhere when
/// it is launched from Finder; the file is what a bug report attaches
/// (Help ▸ Reveal Log File) and what the smoke tests read. A file that cannot
/// be opened costs only the file: stderr and the trace are installed as usual.
pub fn init_logging_to_file(log_file: &std::path::Path) {
    let file = log_file
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_file)
        });
    match file {
        Ok(file) => install(DEFAULT_LOG_FILTER, Some(file)),
        Err(e) => {
            install(DEFAULT_LOG_FILTER, None);
            tracing::warn!(path = %log_file.display(), error = %e, "log file not opened");
        }
    }
}

/// What the log file keeps: tmuxy's own lines, never a dependency's.
const FILE_LOG_FILTER: &str = "tmuxy_core=info,tmuxy_server=info,tmuxy_tauri_app=info";

fn install(default_filter: &str, log_file: Option<std::fs::File>) {
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{fmt, EnvFilter};

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));
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
    // The trace layer gets its OWN filter, decoupled from stderr's: it captures
    // DEBUG from the tmuxy crates so the hot-path `debug!` signal events (command
    // verb, emit seq) land in the trace file without spamming stderr. RUST_LOG
    // still controls the stderr fmt layer as before.
    let trace_filter = EnvFilter::new("tmuxy_core=debug,tmuxy_server=debug,tmuxy_tauri_app=debug");
    tracing_subscriber::registry()
        .with(stderr_layer.with_filter(filter))
        .with(file_layer)
        .with(tmuxy_core::trace::TraceLayer.with_filter(trace_filter))
        .try_init()
        .ok();
}
