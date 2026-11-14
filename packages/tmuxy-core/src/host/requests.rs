//! What a host answers a client's requests with, read over the session's
//! monitor (`control_mode::query`).

use std::future::Future;
use std::time::Duration;

use crate::command_router::{route_command, Route};
use crate::control_mode::{query, run, MonitorCommand, MonitorCommandSender};
use crate::session_snapshot as snapshot;
use crate::tmux_quote;
use crate::{CommandError, PaneId, TmuxState};

use super::bindings::{self, is_source_file, source_with_entry};

// ============================================
// A client's first requests
// ============================================

/// A client's initial state: the monitor's own picture of the session, the
/// same one its `Full` broadcast carries. A client that connects after that
/// broadcast would otherwise start from a baseline the deltas never correct,
/// because a delta only carries what changed.
pub async fn initial_state(tx: &MonitorCommandSender) -> Result<TmuxState, CommandError> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::GetState { reply })
        .await
        .map_err(|e| CommandError::unavailable(format!("Monitor channel error: {e}")))?;
    tokio::time::timeout(crate::host::MONITOR_READY_TIMEOUT, rx)
        .await
        .map_err(|_| {
            CommandError::unavailable("tmux monitor did not answer with the initial state")
        })?
        .map_err(|_| CommandError::unavailable("monitor went away before answering"))
}

/// How long a client's first state waits for the resize it just asked for.
/// tmux answers in milliseconds over a local socket; the bound stops a size
/// tmux will not take (`resize_given_up` in the monitor) from holding up the
/// first paint.
pub const INITIAL_STATE_RESIZE_WAIT: Duration = Duration::from_millis(750);

/// The initial state, agreeing with the size the session was asked to be
/// (`asked`, the client's viewport) when there is one — so the first paint
/// is at the client's size, not the control-mode PTY's.
pub async fn initial_state_for_size(
    tx: &MonitorCommandSender,
    asked: Option<(u32, u32)>,
) -> Result<TmuxState, CommandError> {
    let mut state = initial_state(tx).await?;
    let Some((cols, rows)) = asked else {
        return Ok(state);
    };
    let deadline = tokio::time::Instant::now() + INITIAL_STATE_RESIZE_WAIT;
    while state.total_width != cols || state.total_height != rows {
        if tokio::time::Instant::now() >= deadline {
            tracing::debug!(
                target: "tmuxy_core::host",
                asked = ?(cols, rows),
                got = ?(state.total_width, state.total_height),
                "first state still disagrees with the size asked for; sending it anyway"
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        state = initial_state(tx).await?;
    }
    Ok(state)
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

/// Git worktree context for the sidebar tree, discovered from the cwd of
/// every pane on the socket. The cwds come from tmux, never from the request,
/// and the `git` subprocesses stay off the async runtime.
pub async fn git_worktrees(
    tx: &MonitorCommandSender,
) -> Result<Vec<crate::worktrees::GitRepository>, CommandError> {
    use crate::worktrees::{list_git_worktrees, paths_from_pane_listing, LIST_PANE_PATHS_CMD};
    let listing = query(tx, LIST_PANE_PATHS_CMD).await?;
    let repositories = tokio::task::spawn_blocking(move || {
        list_git_worktrees(paths_from_pane_listing(&listing))
            .map_err(|e| CommandError::unavailable(e.to_string()))
    })
    .await
    .map_err(|e| CommandError::unavailable(format!("worktree discovery task failed: {e}")))??;
    Ok(repositories)
}

/// Everything the Debug menu needs to render itself (docs/TRACING.md).
pub fn trace_settings() -> TraceSettings {
    TraceSettings {
        enabled: crate::trace::is_enabled(),
        level: crate::trace::level_name(),
        path: crate::trace::trace_path().display().to_string(),
        locked: crate::trace::is_locked_off(),
    }
}

/// A slice of the trace, redacted for sharing (`trace::share`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TraceShare {
    /// NDJSON, one redacted event a line.
    pub text: String,
    pub lines: usize,
}

/// The last `last` actions (at most 200) of the trace, redacted for sharing.
pub fn trace_share(last: u32) -> Result<TraceShare, String> {
    let (text, lines) = crate::trace::share::shared_slice(last.clamp(1, 200) as usize)?;
    Ok(TraceShare { text, lines })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TraceSettings {
    pub enabled: bool,
    pub level: &'static str,
    pub path: String,
    pub locked: bool,
}

/// Returns the name of the level in force. An unknown name resolves to
/// `shape`, so a bad argument cannot raise sensitivity.
pub fn set_trace_level(level: &str) -> &'static str {
    let level = crate::trace::TraceLevel::parse(level);
    crate::trace::set_level_persisted(level);
    level.as_str()
}

/// A mutation the host builds itself, routed by the shared policy like a
/// client's, whose output it needs back: the id a `splitw -P` printed, say.
/// It rides the same command channel as every other mutation, so it stays in
/// order with them, and a `%error` comes back to the caller instead of going
/// to the emitter. A blocked command is an error here: the caller is waiting
/// for an answer that would never come.
pub async fn run_with_output(
    tx: &MonitorCommandSender,
    command: &str,
    session: &str,
    size: Option<(u32, u32)>,
) -> Result<String, CommandError> {
    match route_command(command, session, size) {
        Route::Blocked(reason) => Err(CommandError::forbidden(reason)),
        Route::ControlMode(cmd) => query(tx, &cmd).await,
    }
}

/// A client's mutation, the way both hosts run one: routed by the shared
/// policy (a blocked command is logged and dropped — both answer it with
/// nothing), written to the monitor, and, when it was a `source-file`,
/// preceded by a rebuild of the entry file (so no chain it sources is stale;
/// see [`source_with_entry`]) and followed by the menu choices the user's
/// `tmuxy.conf` does not pin (a sourced defaults file resets them) and by
/// `after_source_file` once tmux has had [`SOURCE_FILE_SETTLE`] to apply it:
/// the prefix, the bindings, the theme and the appearance may all have
/// changed, and the host pushes fresh copies.
pub async fn run_client_command<F>(
    tx: &MonitorCommandSender,
    command: &str,
    session: &str,
    size: Option<(u32, u32)>,
    after_source_file: impl FnOnce() -> F,
) -> Result<(), CommandError>
where
    F: Future<Output = ()>,
{
    let routed = match route_command(command, session, size) {
        Route::Blocked(reason) => {
            tracing::warn!(target: "tmuxy_core::host", reason, "blocked command");
            return Ok(());
        }
        Route::ControlMode(cmd) => cmd,
    };
    let sourced = is_source_file(&routed);
    let routed = if sourced {
        let entry = crate::session::get_config_path();
        // Reload Config: the same check a saved file gets.
        if entry.is_some() && routed.trim() == bindings::SOURCE_ENTRY_CONF {
            bindings::refuse_broken_config().await?;
        }
        source_with_entry(routed, entry.as_deref())
    } else {
        routed
    };
    run(tx, &routed).await?;
    if sourced {
        bindings::after_source_file(tx).await?;
        after_source_file().await;
    }
    Ok(())
}

// ============================================
// Scrollback
// ============================================

/// A range of a pane's scrollback as cells, for copy mode.
///
/// The pane id goes into a command line as a target, which its type makes
/// safe: it was checked to be one (`%N`) where it arrived. The width is tmux's, never
/// a guess: a wrong width re-wraps every captured line at the wrong column, so
/// an answer tmux did not give fails and the client asks again.
///
/// One round trip: the pane's geometry and the capture share a command list,
/// so they describe the same moment.
///
/// `start` and `end` arrive from the client unchecked; they are clamped to
/// the range tmux's `capture-pane -S/-E` accepts (`INT_MIN..=SHRT_MAX`),
/// where its own clamp to the history that exists takes over.
pub async fn scrollback_cells(
    tx: &MonitorCommandSender,
    pane_id: &PaneId,
    start: i64,
    end: i64,
) -> Result<ScrollbackCells, CommandError> {
    let start = clamp_capture_line(start);
    let end = clamp_capture_line(end);
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
    Ok(ScrollbackCells {
        cells: crate::parse_scrollback_to_cells(raw, width),
        history_size,
        start,
        end,
        width,
    })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackCells {
    pub cells: crate::PaneContent,
    pub history_size: u32,
    pub start: i64,
    pub end: i64,
    pub width: u32,
}

fn clamp_capture_line(line: i64) -> i64 {
    line.clamp(i64::from(i32::MIN), i64::from(i16::MAX))
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

pub async fn list_snapshots() -> Result<Vec<SnapshotInfo>, CommandError> {
    let dir = snapshot::default_dir();
    let list = tokio::task::spawn_blocking(move || snapshot::list(&dir))
        .await
        .map_err(|e| CommandError::unavailable(e.to_string()))?;
    Ok(list
        .into_iter()
        .map(|(name, saved_at)| SnapshotInfo { name, saved_at })
        .collect())
}

/// `saved_at` is unix seconds.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub name: String,
    pub saved_at: u64,
}

/// Rebuild a session from its latest snapshot through the caller's
/// control-mode client — a session made from inside a control-mode client is
/// how both hosts already create one
/// ([`snapshot::named_restore`] says what is refused).
pub async fn restore_named(name: &str, tx: &MonitorCommandSender) -> Result<(), CommandError> {
    let running = match crate::session::SessionName::parse(name) {
        Some(_) => session_running(tx, name).await?,
        None => false,
    };
    let (saved, options) = snapshot::named_restore(name, running, false)?;
    snapshot::restore_via_monitor(&saved, &options, tx)
        .await
        .map_err(|e| CommandError::tmux(e.to_string()))
}

/// Whether a session of exactly this name exists, asked over control mode:
/// tmux's `%error` is "no", and a monitor that could not ask is no answer.
async fn session_running(tx: &MonitorCommandSender, name: &str) -> Result<bool, CommandError> {
    match query(
        tx,
        &format!(
            "has-session -t {}",
            tmux_quote(&crate::session::exact_session_target(name))
        ),
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(e) if e.kind == crate::ErrorKind::Tmux => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
#[path = "requests_tests.rs"]
mod tests;
