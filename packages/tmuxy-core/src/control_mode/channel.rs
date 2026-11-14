//! The monitor's command channel, as its users speak it: a read that waits
//! for what tmux printed, and a mutation that does not wait.
//!
//! Both ride the monitor's control-mode connection: an external `tmux`
//! process while a control-mode client is attached can crash tmux 3.5a
//! (docs/TMUX.md).

use super::{CommandReply, MonitorCommand, MonitorCommandSender};
use crate::CommandError;

/// Run a command on the monitor's connection and wait for what it printed. An
/// `%error` from tmux is a `tmux` error carrying tmux's message; a monitor
/// that is gone is `unavailable`.
pub async fn query(tx: &MonitorCommandSender, command: &str) -> Result<String, CommandError> {
    ask(tx, command).await?.into_result()
}

/// [`query`], for a caller that reads what a command list printed before one
/// of its commands failed.
pub async fn ask(tx: &MonitorCommandSender, command: &str) -> Result<CommandReply, CommandError> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::RunCommandWithReply {
        command: command.to_string(),
        reply,
    })
    .await
    .map_err(|e| CommandError::unavailable(format!("Monitor channel error: {e}")))?;
    rx.await
        .map_err(|_| CommandError::unavailable("monitor went away before answering"))
}

/// Run a command on the monitor's connection without waiting for it. A
/// `%error` reaches the user through the emitter, not the caller.
pub async fn run(tx: &MonitorCommandSender, command: &str) -> Result<(), CommandError> {
    tx.send(MonitorCommand::RunCommand {
        command: command.to_string(),
    })
    .await
    .map_err(|e| CommandError::unavailable(format!("Monitor channel error: {e}")))
}
