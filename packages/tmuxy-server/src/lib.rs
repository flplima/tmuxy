pub mod auth;
pub mod command;
mod dev;
pub mod server;
pub mod sse;
pub mod state;
pub mod trace_view;
pub use tmuxy_connect as connect;
pub use tmuxy_tree as tree;

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
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("tmuxy_core=info,tmuxy_server=info,warn"));
    let fmt_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(std::io::stderr);
    // The trace layer gets its OWN filter, decoupled from stderr's: it captures
    // DEBUG from the tmuxy crates so the hot-path `debug!` signal events (command
    // verb, emit seq) land in the trace file without spamming stderr. RUST_LOG
    // still controls the stderr fmt layer as before.
    let trace_filter = EnvFilter::new("tmuxy_core=debug,tmuxy_server=debug,tmuxy_tauri_app=debug");
    tracing_subscriber::registry()
        .with(fmt_layer.with_filter(filter))
        .with(tmuxy_core::trace::TraceLayer.with_filter(trace_filter))
        .try_init()
        .ok();
}
