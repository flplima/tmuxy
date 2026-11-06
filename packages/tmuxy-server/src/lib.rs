//! The tmuxy web server. `server::run_argv` parses `tmuxy server …`: serving,
//! `stop` and `status` are this crate's own, every other verb is
//! `tmuxy-verbs`'.
//!
//! The public surface is what the desktop binary (`tmuxy-tauri-app`) links,
//! `server` to run `tmuxy server …`. Everything else is this crate's own, so
//! that rustc's dead-code lint can see what nothing uses any more.

mod auth;
mod dev;
mod mcp;
mod push;
mod request_guard;
pub mod server;
mod sse;
mod state;
