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
//! - `monitor_core` - The sans-IO client core every host runs
//! - `monitor` - The tokio host of that core
//! - `osc` - OSC (Operating System Command) sequence parser

// Sans-IO parse + state layer (wasm-safe).
pub mod images;
mod log;
mod octal;
mod osc;
mod parser;
mod state;

// The sans-IO client core every host runs (wasm-safe).
pub mod monitor_core;

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
pub use monitor::{MonitorCommand, MonitorCommandSender, MonitorConfig, StateEmitter, TmuxMonitor};
pub use monitor_core::{Action, AttachConfig, CommandReply, MonitorCore, Outgoing, ReadPacing};
pub use octal::decode_octal;
pub use osc::OscParser;
pub use parser::{ControlModeEvent, Parser};
pub(crate) use state::normalize_capture_bytes;
pub use state::{
    control_mode_lines, Batch, ChangeType, Instant, Markers, Notice, SideEffect, StateAggregator,
    StepResult, BUFFER_BEGIN_MARKER, BUFFER_END_MARKER, CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER,
    LIST_BEGIN_MARKER, LIST_END_MARKER, MAX_CLIPBOARD_BYTES, REPLY_BEGIN_MARKER, REPLY_END_MARKER,
};
