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

mod connection;
mod monitor;
mod octal;
mod osc;
mod parser;
mod state;

pub use connection::ControlModeConnection;
pub use monitor::{MonitorCommand, MonitorCommandSender, MonitorConfig, StateEmitter, TmuxMonitor};
pub use octal::decode_octal;
pub use osc::OscParser;
pub use parser::{ControlModeEvent, Parser};
pub use state::{ChangeType, ProcessEventResult, StateAggregator};
