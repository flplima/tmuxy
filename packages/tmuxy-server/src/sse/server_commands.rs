use std::sync::Arc;
use tmuxy_core::control_mode::{MonitorCommand, MonitorCommandSender};
use tmuxy_core::servers::RemoteSessionInfo;
use tmuxy_core::transport;
use tmuxy_core::CommandError;

use crate::state::AppState;

/// The session's monitor command channel, waiting for the monitor to finish
/// connecting if the request got here first.
pub(super) async fn wait_for_monitor(
    state: &Arc<AppState>,
    session: &str,
) -> Result<MonitorCommandSender, CommandError> {
    transport::wait_for_monitor(|| async { state.monitor_tx(session).await.ok() }).await
}

/// A client's initial state, from a monitor that may still be connecting,
/// agreeing with the size the session has been told to be (`last_resize`).
pub(super) async fn initial_state_for_size(
    state: &Arc<AppState>,
    session: &str,
) -> Result<tmuxy_core::TmuxState, CommandError> {
    let tx = wait_for_monitor(state, session).await?;
    let asked = {
        let sessions = state.sessions.read().await;
        sessions.get(session).and_then(|conns| conns.last_resize)
    };
    transport::initial_state_for_size(&tx, asked).await
}

/// Run a command through the session's control-mode connection and wait for
/// what it printed. The counterpart of `send_via_control_mode` for reads.
pub(super) async fn query_via_control_mode(
    state: &Arc<AppState>,
    session: &str,
    command: &str,
) -> Result<String, CommandError> {
    tracing::debug!(
        target: "tmuxy_server::sse",
        verb = command.split_whitespace().next().unwrap_or(""),
        command,
        "query"
    );
    let tx = state.monitor_tx(session).await?;
    transport::query(&tx, command).await
}

/// The most rows of scrollback one request from a viewer is answered with.
const MAX_VIEWER_SCROLLBACK_ROWS: i64 = 5000;

/// A viewer's scrollback, answered from the monitor's own grid at zero tmux
/// round trips (SEC-11/SEC-16).
pub(super) async fn viewer_scrollback(
    state: &Arc<AppState>,
    session: &str,
    pane_id: tmuxy_core::PaneId,
    start: i64,
    end: i64,
) -> Result<serde_json::Value, CommandError> {
    let tx = state.monitor_tx(session).await?;
    let start = start.max(end.saturating_sub(MAX_VIEWER_SCROLLBACK_ROWS - 1));
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::GetScrollback {
        pane_id: pane_id.clone(),
        start,
        end,
        reply,
    })
    .await
    .map_err(|e| CommandError::unavailable(format!("Monitor channel error: {e}")))?;
    let chunk = rx
        .await
        .map_err(|_| CommandError::unavailable("monitor went away before answering"))?
        .ok_or_else(|| {
            CommandError::invalid(format!("pane {pane_id} is not in session {session}"))
        })?;

    Ok(serde_json::json!({
        "cells": chunk.cells,
        "historySize": chunk.history_size,
        "start": start,
        "end": end,
        "width": chunk.width
    }))
}

async fn current_live_sessions(
    state: &Arc<AppState>,
    session: &str,
) -> Option<Vec<RemoteSessionInfo>> {
    let out = query_via_control_mode(
        state,
        session,
        "list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'",
    )
    .await
    .ok()?;
    Some(tmuxy_core::servers::parse_session_list(&out))
}

pub(super) async fn handle_list_servers(
    state: &Arc<AppState>,
    session: &str,
) -> Result<serde_json::Value, CommandError> {
    let live_count = current_live_sessions(state, session).await.map(|s| s.len());
    let (mut servers, current) = tokio::task::spawn_blocking(|| {
        (
            tmuxy_core::servers::read_servers(),
            tmuxy_core::servers::current_server_id(),
        )
    })
    .await
    .map_err(|e| CommandError::unavailable(e.to_string()))?;
    if let Some(count) = live_count {
        if let Some(cur) = servers.iter_mut().find(|s| s.id == current) {
            cur.session_count = Some(count);
        }
    }
    Ok(serde_json::json!({
        "servers": servers,
        "currentId": current,
    }))
}

pub(super) async fn handle_connect_server(
    id: String,
    session_override: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let server = tmuxy_core::servers::find_server(&id)
        .ok_or_else(|| CommandError::invalid(format!("unknown server '{id}'")))?;
    let target_session = session_override
        .or_else(|| server.session.clone())
        .unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string());
    let server_id = server.id.clone();
    let sess_clone = target_session.clone();
    let _ = tokio::task::spawn_blocking(move || {
        tmuxy_core::servers::touch_server(&server_id, Some(&sess_clone))
    })
    .await;
    Ok(serde_json::json!({
        "serverId": id,
        "session": target_session,
    }))
}
