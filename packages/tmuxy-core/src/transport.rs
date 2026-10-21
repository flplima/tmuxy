//! What both transports do with a live monitor, written once.
//!
//! The web server (`tmuxy-server/src/sse.rs`) and the desktop app
//! (`tmuxy-tauri-app/src/commands.rs`, `monitor.rs`) differ in how they reach
//! a client — an SSE broadcast, a Tauri event — and in nothing else. Every
//! tmux read here rides the monitor's control-mode connection
//! (`MonitorCommand::RunCommandWithReply`): an external `tmux` process while a
//! control-mode client is attached can crash tmux 3.5a (docs/TMUX.md).

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::command_router::{route_command, Route};
use crate::control_mode::{MonitorCommand, MonitorCommandSender, MonitorConfig};
use crate::executor::tmux_quote;
use crate::session_snapshot::{self as snapshot, RestoreOptions, Snapshot, SnapshotKeeper};
use crate::{CommandError, PaneId, StateUpdate, TmuxError, TmuxState};

mod bindings;
pub use bindings::*;

// ============================================
// The monitor loop
// ============================================

/// The bookkeeping both emitters do with a state update before handing it to
/// their client.
///
/// `forget_dead_images` is given a full state — the one update that names
/// every live pane — so the emitter's image store, behind whichever lock it
/// keeps, can drop the pictures of the rest. The keeper is told of a change
/// of SHAPE (a split, a closed pane, a tag, a program starting — never bytes
/// arriving), which is what a snapshot follows. And the emit is traced by the
/// DELTA seq and kind, so the return leg joins to the client's applied `seq`
/// (docs/TRACING.md); the transport's own ids are another counter.
/// Content-free.
pub fn on_state_update(
    update: &StateUpdate,
    keeper: &SnapshotKeeper,
    forget_dead_images: impl FnOnce(&TmuxState),
) {
    match update {
        StateUpdate::Full { state } => {
            forget_dead_images(state);
            if !snapshot::autosave_disabled() {
                keeper.note_change();
            }
            tracing::debug!(target: "tmuxy_core::emit", kind = "full", "emit state");
        }
        StateUpdate::Delta { delta } => {
            if snapshot::is_structural(delta) && !snapshot::autosave_disabled() {
                keeper.note_change();
            }
            tracing::debug!(target: "tmuxy_core::emit", seq = delta.seq, kind = "delta", "emit state");
        }
    }
}

/// A session about to be CREATED may have a snapshot to come back from.
/// Decided once, before the connect: the first window is made as the snapshot
/// wants it, and the rebuild runs onto it after attach
/// ([`restore_after_attach`]) — over control mode, never with a clientless
/// server. `None` when there is nothing to come back from, or
/// `TMUXY_NO_RESTORE` says not to.
pub fn restore_plan(dir: &Path, config: &mut MonitorConfig) -> Option<Snapshot> {
    let found = snapshot::restorable(dir, &config.session)?;
    config.first_window = found.first_window_hint(&snapshot::fallback_cwd());
    Some(found)
}

/// The rebuild onto the window `new-session` just made, for the caller to
/// spawn once the monitor is in its loop — after the initial sync, which is
/// the order it needs.
///
/// The keeper is held from HERE, not from inside the task: the first delta of
/// the fresh session must not race the task's start into a save of the
/// placeholder window. It is released however the rebuild ends; what stands
/// then is the shape worth keeping.
pub fn restore_after_attach(
    snapshot: Snapshot,
    keeper: Arc<SnapshotKeeper>,
    tx: MonitorCommandSender,
) -> impl Future<Output = Result<(), TmuxError>> + Send {
    keeper.restore_started();
    async move {
        let options = RestoreOptions {
            run: false,
            fallback_cwd: snapshot::fallback_cwd(),
            onto_existing_window: true,
            existing_window_index: None,
        };
        let outcome = snapshot::restore_via_monitor(&snapshot, &options, &tx).await;
        keeper.restore_finished();
        outcome
    }
}

// ============================================
// A client's first requests
// ============================================

/// How long a client's first request waits for the monitor to come up. The
/// monitor's own connect gives tmux ten seconds to answer.
pub const MONITOR_READY_TIMEOUT: Duration = Duration::from_secs(15);

/// The monitor's command channel, waiting for a monitor that is still
/// connecting when the client asks first: the web server starts one on the
/// SSE connect that precedes the request, the desktop app with the app.
/// `lookup` is how the caller finds the channel, asked again every 50 ms.
pub async fn wait_for_monitor<F, Fut>(mut lookup: F) -> Result<MonitorCommandSender, CommandError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<MonitorCommandSender>>,
{
    let deadline = tokio::time::Instant::now() + MONITOR_READY_TIMEOUT;
    loop {
        if let Some(tx) = lookup().await {
            return Ok(tx);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(CommandError::unavailable(
                "tmux monitor did not come up in time",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A client's initial state: the monitor's own picture of the session, the
/// same one its `Full` broadcast carries. A client that connects after that
/// broadcast would otherwise start from a baseline the deltas never correct,
/// because a delta only carries what changed.
pub async fn initial_state(tx: &MonitorCommandSender) -> Result<TmuxState, CommandError> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::GetState { reply })
        .await
        .map_err(|e| CommandError::unavailable(format!("Monitor channel error: {e}")))?;
    tokio::time::timeout(MONITOR_READY_TIMEOUT, rx)
        .await
        .map_err(|_| {
            CommandError::unavailable("tmux monitor did not answer with the initial state")
        })?
        .map_err(|_| CommandError::unavailable("monitor went away before answering"))
}

/// A command's answer as JSON; failing to make it is this side's fault.
pub fn to_json(
    value: impl serde::Serialize,
    what: &str,
) -> Result<serde_json::Value, CommandError> {
    serde_json::to_value(value)
        .map_err(|e| CommandError::unavailable(format!("Failed to serialize {what}: {e}")))
}

// ============================================
// Client commands
// ============================================

/// Decide a client command's route (`command_router`) and record the WHAT as
/// its tmux verb — the first token, a fixed subcommand name and never the
/// args; the full command string is admitted only at trace level `full`
/// (docs/TRACING.md). `size` is the viewport a freshly created window
/// should be sized to, when a client has reported one.
pub fn route(command: &str, session: &str, size: Option<(u32, u32)>) -> Route {
    tracing::debug!(
        target: "tmuxy_core::transport",
        verb = command.split_whitespace().next().unwrap_or(""),
        command,
        "run command"
    );
    route_command(command, session, size)
}

/// Git worktree context for the sidebar tree, discovered from the cwd of
/// every pane on the socket — or of one session's panes, for a server pinned
/// to it, so a viewer does not learn the repo path and branch of every pane
/// on the tmux server. The cwds come from tmux, never from the request, and
/// the `git` subprocesses stay off the async runtime.
pub async fn git_worktrees_json(
    tx: &MonitorCommandSender,
    session_pin: Option<&str>,
) -> Result<serde_json::Value, CommandError> {
    use crate::worktrees::{list_git_worktrees, list_pane_paths_cmd, paths_from_pane_listing};
    let listing = query(tx, &list_pane_paths_cmd(session_pin)).await?;
    let repositories = tokio::task::spawn_blocking(move || {
        list_git_worktrees(paths_from_pane_listing(&listing))
            .map_err(|e| CommandError::unavailable(e.to_string()))
    })
    .await
    .map_err(|e| CommandError::unavailable(format!("worktree discovery task failed: {e}")))??;
    to_json(repositories, "worktrees")
}

/// Everything the Debug menu needs to render itself (docs/TRACING.md): the
/// switch position, the level, the file it writes to, and whether a
/// `DO_NOT_TRACK` / `TMUXY_NO_TRACE` kill switch forbids turning it on at all
/// (in which case the UI shows the control disabled rather than a switch that
/// silently does nothing).
pub fn trace_settings_json() -> serde_json::Value {
    serde_json::json!({
        "enabled": crate::trace::is_enabled(),
        "level": crate::trace::level_name(),
        "path": crate::trace::trace_path().map(|p| p.display().to_string()),
        "locked": crate::trace::is_locked_off(),
    })
}

/// Set the trace level (`shape` | `labeled` | `full`) and remember it; the
/// name of the level in force. An unknown name resolves to `shape`, so a bad
/// argument cannot raise sensitivity.
pub fn set_trace_level(level: &str) -> &'static str {
    let level = crate::trace::TraceLevel::parse(level);
    crate::trace::set_level_persisted(level);
    level.as_str()
}

/// Run a command on the monitor's connection and wait for what it printed. An
/// `%error` from tmux is a `tmux` error carrying tmux's message; a monitor
/// that is gone is `unavailable`.
pub async fn query(tx: &MonitorCommandSender, command: &str) -> Result<String, CommandError> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::RunCommandWithReply {
        command: command.to_string(),
        reply,
    })
    .await
    .map_err(|e| CommandError::unavailable(format!("Monitor channel error: {e}")))?;
    rx.await
        .map_err(|_| CommandError::unavailable("monitor went away before answering"))?
        .into_result()
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

// ============================================
// Scrollback
// ============================================

/// A range of a pane's scrollback as cells, for copy mode: the
/// `{ cells, historySize, start, end, width }` both transports answer
/// `get_scrollback_cells` with.
///
/// The pane id goes into a command line as a target, which its type makes
/// safe: it was checked to be one (`%N`) where it arrived. The width is tmux's, never
/// a guess: a wrong width re-wraps every captured line at the wrong column, so
/// an answer tmux did not give fails and the client asks again.
///
/// One round trip: the pane's geometry and the capture share a command list,
/// so they describe the same moment.
pub async fn scrollback_cells(
    tx: &MonitorCommandSender,
    pane_id: &PaneId,
    start: i64,
    end: i64,
) -> Result<serde_json::Value, CommandError> {
    let output = query(
        tx,
        &format!(
            "display-message -p -t {pane_id} '#{{pane_width}} #{{history_size}}' ; \
             capture-pane -p -e -t {pane_id} -S {start} -E {end}"
        ),
    )
    .await
    .map_err(|e| e.context("Failed to capture pane range"))?;
    let (geometry, raw) = output.split_once('\n').unwrap_or((output.as_str(), ""));
    let (width, history_size) = parse_geometry(geometry).map_err(CommandError::tmux)?;
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

// ============================================
// Session snapshots
// ============================================

/// The sessions that have a snapshot to be rebuilt from, as the
/// `[{ name, savedAt }]` both transports answer `list_snapshots` with.
pub async fn list_snapshots_json() -> Result<serde_json::Value, CommandError> {
    let dir = snapshot::default_dir();
    let list = tokio::task::spawn_blocking(move || snapshot::list(&dir))
        .await
        .map_err(|e| CommandError::unavailable(e.to_string()))?;
    Ok(serde_json::json!(list
        .into_iter()
        .map(|(name, saved_at)| serde_json::json!({ "name": name, "savedAt": saved_at }))
        .collect::<Vec<_>>()))
}

/// Rebuild a session from its latest snapshot through the caller's
/// control-mode client — a session made from inside a control-mode client is
/// how both transports already create one. Refused when the session is
/// already running.
pub async fn restore_named(name: &str, tx: &MonitorCommandSender) -> Result<(), CommandError> {
    if !crate::session::is_safe_session_name(name) {
        return Err(CommandError::invalid(format!(
            "not a usable session name: {name:?}"
        )));
    }
    if session_running(tx, name).await {
        return Err(CommandError::invalid(format!(
            "session {name:?} is already running"
        )));
    }
    let dir = snapshot::default_dir();
    let saved = snapshot::read_latest(&dir, name)
        .map_err(|e| CommandError::unavailable(e.to_string()))?
        .ok_or_else(|| CommandError::invalid(format!("no snapshot for {name:?}")))?;
    let options = RestoreOptions {
        run: false,
        fallback_cwd: snapshot::fallback_cwd(),
        onto_existing_window: false,
        existing_window_index: None,
    };
    snapshot::restore_via_monitor(&saved, &options, tx)
        .await
        .map_err(|e| CommandError::tmux(e.to_string()))
}

/// Whether a session of exactly this name exists, asked over control mode.
async fn session_running(tx: &MonitorCommandSender, name: &str) -> bool {
    query(
        tx,
        &format!("has-session -t {}", tmux_quote(&format!("={name}"))),
    )
    .await
    .is_ok()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
