//! Tmux Control Mode Integration
//!
//! This module provides event-driven communication with tmux using control mode (`tmux -CC`).
//! Instead of polling with `capture-pane`, it receives real-time notifications of changes.
//!
//! ## Key components:
//! - `octal` - Decode tmux's octal escape sequences
//! - `parser` - Parse control mode notifications
//! - `connection` - Manage the tmux -CC subprocess
//! - `state` - Aggregate events into coherent state
//! - `monitor` - High-level API with adapter pattern
//! - `osc` - OSC (Operating System Command) sequence parser

// Sans-IO parse + state layer (wasm-safe).
pub mod images;
mod log;
mod octal;
mod osc;
mod parser;
mod state;

// Native async/pty transport, gated behind the `native` feature.
#[cfg(feature = "native")]
mod connection;
#[cfg(feature = "native")]
mod monitor;

#[cfg(feature = "native")]
pub use connection::{ControlModeConnection, INITIAL_PTY_COLS, INITIAL_PTY_ROWS};
pub use images::{ImageParser, ImagePlacement, ImageProtocol, StoredImage};
pub use log::{LogKind, LogSink};
#[cfg(feature = "native")]
pub use monitor::{
    CommandReply, MonitorCommand, MonitorCommandSender, MonitorConfig, StateEmitter, TmuxMonitor,
};
pub use octal::decode_octal;
pub use osc::OscParser;
pub use parser::{ControlModeEvent, Parser};
pub use state::{
    accepted_clipboard_write, control_mode_lines, normalize_capture_bytes, window_relist_commands,
    ChangeType, Markers, SideEffect, StateAggregator, StepResult, BUFFER_BEGIN_MARKER,
    BUFFER_END_MARKER, CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER, MAX_CLIPBOARD_BYTES,
    REPLY_BEGIN_MARKER, REPLY_END_MARKER,
};
