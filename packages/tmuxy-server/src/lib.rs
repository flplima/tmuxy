pub mod auth;
pub mod command;
mod dev;
pub mod server;
pub mod sse;
pub mod state;
pub use tmuxy_connect as connect;
pub use tmuxy_tree as tree;

pub use command::ClientCommand;

/// Initialize the tracing subscriber for the server.
///
/// Called by both the standalone `tmuxy-server` binary and the combined
/// `tmuxy server` CLI path in the Tauri app. Without this, `error!`/`warn!`
/// logs (including the fatal dev-mode port-collision message) are silently
/// dropped, leaving the server to exit with no diagnostic output.
pub fn init_logging() {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("tmuxy_core=info,tmuxy_server=info,warn"));
    fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(std::io::stderr)
        .try_init()
        .ok();
}
