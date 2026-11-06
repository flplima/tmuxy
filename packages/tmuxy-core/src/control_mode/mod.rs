//! Event-driven communication with tmux through control mode (`tmux -CC`):
//! tmux pushes notifications of every change instead of being polled with
//! `capture-pane`.

// Sans-IO, so these also build for wasm.
pub mod images;
mod log;
mod octal;
mod osc;
mod parser;
mod state;

pub mod monitor_core;

#[cfg(feature = "native")]
mod channel;
#[cfg(feature = "native")]
mod connection;
#[cfg(feature = "native")]
mod monitor;

#[cfg(feature = "native")]
pub use channel::{query, run};
#[cfg(feature = "native")]
pub use connection::{
    new_session_flags, ControlModeConnection, INITIAL_PTY_COLS, INITIAL_PTY_ROWS,
};
pub use images::{ImageParser, ImagePlacement, ImageProtocol, StoredImage};
pub use log::{LogKind, LogSink};
#[cfg(feature = "native")]
pub use monitor::{MonitorCommand, MonitorCommandSender, MonitorConfig, StateEmitter, TmuxMonitor};
pub use monitor_core::{Action, AttachConfig, CommandReply, MonitorCore, Outgoing, ReadPacing};
pub use octal::decode_octal;
pub use parser::{ControlModeEvent, Parser};
pub(crate) use state::normalize_capture_bytes;
pub use state::{
    control_mode_lines, Batch, ChangeType, Instant, Markers, Notice, SideEffect, StateAggregator,
    StepResult, BUFFER_BEGIN_MARKER, BUFFER_END_MARKER, CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER,
    LIST_BEGIN_MARKER, LIST_END_MARKER, MAX_CLIPBOARD_BYTES, REPLY_BEGIN_MARKER, REPLY_END_MARKER,
};
