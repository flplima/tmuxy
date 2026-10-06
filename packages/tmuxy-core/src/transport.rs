//! What both transports do with a live monitor, written once.
//!
//! The web server (`tmuxy-server/src/sse.rs`) and the desktop app
//! (`tmuxy-tauri-app/src/commands.rs`, `monitor.rs`) differ in how they reach
//! a client — an SSE broadcast, a Tauri event — and in nothing else. Every
//! tmux read here rides the monitor's control-mode connection
//! (`MonitorCommand::RunCommandWithReply`): an external `tmux` process while a
//! control-mode client is attached can crash tmux 3.5a (docs/TMUX.md).

use crate::control_mode::{MonitorCommand, MonitorCommandSender};

/// Run a command on the monitor's connection and wait for what it printed. An
/// `%error` from tmux is the `Err`, carrying tmux's message.
pub async fn query(tx: &MonitorCommandSender, command: &str) -> Result<String, String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::RunCommandWithReply {
        command: command.to_string(),
        reply,
    })
    .await
    .map_err(|e| format!("Monitor channel error: {e}"))?;
    rx.await
        .map_err(|_| "monitor went away before answering".to_string())?
        .into_result()
}

/// Run a command on the monitor's connection without waiting for it. A
/// `%error` reaches the user through the emitter, not the caller.
pub async fn run(tx: &MonitorCommandSender, command: &str) -> Result<(), String> {
    tx.send(MonitorCommand::RunCommand {
        command: command.to_string(),
    })
    .await
    .map_err(|e| format!("Monitor channel error: {e}"))
}

// ============================================
// Scrollback
// ============================================

/// A range of a pane's scrollback as cells, for copy mode: the
/// `{ cells, historySize, start, end, width }` both transports answer
/// `get_scrollback_cells` with.
///
/// The pane id is the client's and goes into a command line as a target, so
/// it has to be one (`%N`) before it goes anywhere. The width is tmux's, never
/// a guess: a wrong width re-wraps every captured line at the wrong column, so
/// an answer tmux did not give fails and the client asks again.
///
/// One round trip: the pane's geometry and the capture share a command list,
/// so they describe the same moment.
pub async fn scrollback_cells(
    tx: &MonitorCommandSender,
    pane_id: &str,
    start: i64,
    end: i64,
) -> Result<serde_json::Value, String> {
    if !crate::session::is_pane_id(pane_id) {
        return Err(format!("not a pane id: {pane_id:?}"));
    }
    let output = query(
        tx,
        &format!(
            "display-message -p -t {pane_id} '#{{pane_width}} #{{history_size}}' ; \
             capture-pane -p -e -t {pane_id} -S {start} -E {end}"
        ),
    )
    .await
    .map_err(|e| format!("Failed to capture pane range: {e}"))?;
    let (geometry, raw) = output.split_once('\n').unwrap_or((output.as_str(), ""));
    let (width, history_size) = parse_geometry(geometry)?;
    Ok(serde_json::json!({
        "cells": crate::parse_scrollback_to_cells(raw, width),
        "historySize": history_size,
        "start": start,
        "end": end,
        "width": width,
    }))
}

/// `<pane_width> <history_size>`, as the scrollback query prints it.
fn parse_geometry(line: &str) -> Result<(u32, u32), String> {
    let mut fields = line.split_whitespace();
    let width = fields.next().and_then(|w| w.parse::<u32>().ok());
    let history = fields.next().and_then(|h| h.parse::<u32>().ok());
    match (width, history) {
        (Some(width), Some(history)) if width > 0 => Ok((width, history)),
        _ => Err(format!("Failed to parse pane geometry from tmux: {line:?}")),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// A monitor that answers every query with `answer`, recording what it
    /// was asked.
    fn answering(
        answer: Result<String, String>,
    ) -> (
        MonitorCommandSender,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = asked.clone();
        tokio::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                if let MonitorCommand::RunCommandWithReply { command, reply } = cmd {
                    seen.lock().unwrap().push(command);
                    let (output, error) = match &answer {
                        Ok(out) => (out.clone(), None),
                        Err(e) => (String::new(), Some(e.clone())),
                    };
                    let _ = reply.send(crate::control_mode::CommandReply { output, error });
                }
            }
        });
        (tx, asked)
    }

    #[tokio::test]
    async fn scrollback_is_read_through_the_monitor_in_one_query() {
        let (tx, asked) = answering(Ok("40 120\nhello\nworld\n".to_string()));
        let answer = scrollback_cells(&tx, "%3", -10, -1).await.unwrap();
        assert_eq!(answer["width"], 40);
        assert_eq!(answer["historySize"], 120);
        assert_eq!(answer["start"], -10);
        assert_eq!(answer["end"], -1);
        assert_eq!(answer["cells"].as_array().unwrap().len(), 2);
        let asked = asked.lock().unwrap();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains("-t %3 -S -10 -E -1"), "{}", asked[0]);
    }

    /// The width is tmux's or nothing: a guessed 80 re-wraps every captured
    /// line at the wrong column.
    #[tokio::test]
    async fn scrollback_without_a_width_fails_rather_than_guessing() {
        let (tx, _) = answering(Ok("\nhello\n".to_string()));
        assert!(scrollback_cells(&tx, "%3", -10, -1).await.is_err());
    }

    /// The pane id goes into a command line as a target.
    #[tokio::test]
    async fn scrollback_refuses_anything_but_a_pane_id() {
        let (tx, asked) = answering(Ok("40 0\n".to_string()));
        for id in ["other:0.0", "%1 ; kill-server", "{last}", ""] {
            assert!(scrollback_cells(&tx, id, -1, -1).await.is_err(), "{id}");
        }
        assert!(asked.lock().unwrap().is_empty());
    }
}
