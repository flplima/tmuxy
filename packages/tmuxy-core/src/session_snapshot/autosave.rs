use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};

use crate::control_mode::MonitorCommandSender;
use crate::error::TmuxError;

use super::*;

// =============================================================================
// The edges: tmux and ps as subprocesses
// =============================================================================

/// Unix seconds now.
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The foreground program on each pane's terminal, by pane id.
///
/// One `ps` per pane rather than one for all: `-t` takes one terminal, and the
/// output is a handful of lines, so this costs what it looks like.
pub fn discover_commands(panes: &[PaneRecord]) -> Discovery {
    let mut out = Discovery::default();
    for pane in panes {
        if pane.tty.is_empty() {
            continue;
        }
        let output = std::process::Command::new("ps")
            .args(ps_args(&pane.tty))
            .output();
        let Ok(output) = output else { continue };
        let text = String::from_utf8_lossy(&output.stdout);
        if let Some(found) = foreground(&text, pane.pid) {
            if found.settled() {
                out.commands.insert(pane.id.clone(), found.argv);
            } else {
                out.unsettled = true;
            }
        }
    }
    out
}

/// What `discover_commands` found: the settled programs by pane id, and
/// whether some pane's foreground was too young to call — worth a second look
/// once `MIN_FOREGROUND_AGE_SECS` has passed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Discovery {
    pub commands: HashMap<PaneId, Vec<String>>,
    pub unsettled: bool,
}

/// A snapshot as taken, with whether a pane was still settling when it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Taken {
    pub snapshot: Snapshot,
    pub unsettled: bool,
}

/// Take a snapshot of `session` through `run`, which runs one tmux command
/// (as argv, without `tmux`) and returns its output — see `run_steps` for
/// what `run` may be.
pub async fn take<F, Fut>(session: &str, mut run: F) -> Result<Taken, TmuxError>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<String, TmuxError>>,
{
    let (qw, qp) = queries_for(session);
    let windows_out = run(split_query(&qw)).await?;
    let panes_out = run(split_query(&qp)).await?;
    // No stash session (no group was ever made) is the usual case, not an error.
    let stash = run(split_query(QUERY_STASH_PANES))
        .await
        .map(|out| parse_panes(&out))
        .unwrap_or_default();
    let windows = parse_windows(&windows_out);
    let panes = parse_panes(&panes_out);
    let all: Vec<PaneRecord> = panes.iter().chain(&stash).cloned().collect();
    // `ps` is a subprocess; off the async runtime like the other reads.
    let found = tokio::task::spawn_blocking(move || discover_commands(&all))
        .await
        .map_err(|e| TmuxError::other(e.to_string()))?;
    let mut snapshot = assemble(session, now(), windows, panes, &found.commands);
    snapshot.hidden = hidden_members(&snapshot, &stash, &found.commands);
    Ok(Taken {
        snapshot,
        unsettled: found.unsettled,
    })
}

/// `list-panes -s -t x -F '…'` as argv: the format is the one quoted word.
pub(super) fn split_query(query: &str) -> Vec<String> {
    let (head, format) = query.split_once(" -F '").unwrap_or((query, ""));
    let mut argv: Vec<String> = head.split_whitespace().map(str::to_string).collect();
    if !format.is_empty() {
        argv.push("-F".to_string());
        argv.push(format.trim_end_matches('\'').to_string());
    }
    argv
}

/// Attach the last `lines` of each pane's screen to a snapshot, through `run`
/// (see `run_steps`).
pub async fn attach_scrollback<F, Fut>(snapshot: &mut Snapshot, lines: u32, mut run: F)
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<String, TmuxError>>,
{
    let s = snapshot.session.clone();
    for w in &mut snapshot.windows {
        for p in &mut w.panes {
            let argv = vec![
                "capture-pane".to_string(),
                "-p".to_string(),
                "-t".to_string(),
                pane_target(&s, w.index, p.index),
                "-S".to_string(),
                format!("-{lines}"),
            ];
            if let Ok(text) = run(argv).await {
                let captured: Vec<String> = text.lines().map(str::to_string).collect();
                // Trailing blank rows are the empty bottom of the screen.
                let end = captured
                    .iter()
                    .rposition(|l| !l.trim().is_empty())
                    .map_or(0, |i| i + 1);
                p.scrollback = Some(captured[..end].to_vec());
            }
        }
    }
}

// =============================================================================
// Where snapshots live, and when a host is told not to use them
// =============================================================================

/// Where snapshots live: under the state directory (`crate::paths`), the same
/// place the trace goes.
pub fn default_dir() -> PathBuf {
    snapshot_dir(&crate::paths::state_dir())
}

/// `TMUXY_NO_RESTORE=1`: start a missing session empty even when a snapshot exists.
pub fn restore_disabled() -> bool {
    std::env::var_os("TMUXY_NO_RESTORE").is_some_and(|v| !v.is_empty() && v != "0")
}

/// `TMUXY_NO_SNAPSHOT=1`: never write snapshots.
pub fn autosave_disabled() -> bool {
    std::env::var_os("TMUXY_NO_SNAPSHOT").is_some_and(|v| !v.is_empty() && v != "0")
}

/// The home directory, for a pane whose own directory has gone.
pub fn fallback_cwd() -> String {
    dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string())
}

/// Whether a delta changes the SHAPE of the session — the only kind of change
/// a snapshot is about. Output arriving in a pane is not.
pub fn is_structural(delta: &crate::TmuxDelta) -> bool {
    if delta.new_panes.is_some()
        || delta.new_windows.is_some()
        || delta.windows.is_some()
        || delta.active_window_id.is_some()
        || delta.active_pane_id.is_some()
    {
        return true;
    }
    delta.panes.as_ref().is_some_and(|panes| {
        panes.values().any(|change| match change {
            None => true,
            Some(d) => {
                d.window_id.is_some()
                    || d.x.is_some()
                    || d.y.is_some()
                    || d.width.is_some()
                    || d.height.is_some()
                    || d.active.is_some()
                    || d.command.is_some()
                    || d.group_id.is_some()
                    || d.group_pos.is_some()
                    || d.pane_widget.is_some()
                    || d.pane_restore.is_some()
            }
        })
    })
}

// =============================================================================
// Through a running monitor: the hosts' half
// =============================================================================

/// Run one tmux command through a monitor's control-mode connection: the
/// hosts' `run` for `take`, `run_steps` and `attach_scrollback`.
async fn via_monitor(tx: &MonitorCommandSender, argv: Vec<String>) -> Result<String, TmuxError> {
    let command = argv
        .iter()
        .map(|a| tmux_word(a))
        .collect::<Vec<_>>()
        .join(" ");
    crate::transport::query(tx, &command)
        .await
        .map_err(|e| TmuxError::other(e.error))
}

/// One argv word as tmux's own command parser reads it: double-quoted, with
/// the characters that mean something inside double quotes escaped.
///
/// A format such as `#{window_id}` MUST be quoted: to tmux's parser a bare
/// `#` starts a comment, so an unquoted format vanishes and the command fails
/// with "-F expects an argument". Inside double quotes it is just text, and
/// the command expands it when it runs. Found by the first real save, which
/// never wrote a file.
///
/// Braces too: `{` opens a command block to the same parser, so the layout of
/// any side-by-side split (`…{40x24,0,0,1,…}`) was a syntax error, and the
/// restore stopped there — before the tags, groups and commands it had left.
pub fn tmux_word(word: &str) -> String {
    if !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c))
    {
        return word.to_string();
    }
    let mut out = String::with_capacity(word.len() + 2);
    out.push('"');
    for c in word.chars() {
        match c {
            '"' | '\\' | '$' | '`' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Rebuild a snapshot through a monitor's connection, step by step.
pub async fn restore_via_monitor(
    snapshot: &Snapshot,
    options: &RestoreOptions,
    tx: &MonitorCommandSender,
) -> Result<(), TmuxError> {
    let mut options = options.clone();
    if options.onto_existing_window && options.existing_window_index.is_none() {
        // `^` is tmux's "first window" target; its index is whatever
        // `base-index` made it.
        let first = via_monitor(
            tx,
            vec![
                "display-message".to_string(),
                "-p".to_string(),
                "-t".to_string(),
                format!("{}:^", snapshot.session),
                "#{window_index}".to_string(),
            ],
        )
        .await?;
        options.existing_window_index = first.trim().parse().ok();
    }
    apply(snapshot, &options, |argv| via_monitor(tx, argv)).await
}

/// How long a burst of structural changes settles before it is written.
pub const AUTOSAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(1);

/// The autosave: a host tells it when the session's shape changed, and it
/// writes a snapshot once the changes settle.
///
/// Event-driven, never a timer. Continuum saves every fifteen minutes because
/// its save is a fork-storm it can only afford that often; a snapshot here is
/// two `list-*` queries and a few kilobytes, so it can afford to follow every
/// change — and a split made a second before a crash is the one worth having.
pub struct SnapshotKeeper {
    pub(super) dirty: tokio::sync::watch::Sender<u64>,
    /// Set while a restore is rebuilding the session: every step of it is a
    /// change of shape, and a save taken between two of them would put half a
    /// session on disk as the latest — the one a crash right then would
    /// restore from next.
    restoring: std::sync::atomic::AtomicBool,
}

impl Default for SnapshotKeeper {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapshotKeeper {
    pub fn new() -> Self {
        let (dirty, _) = tokio::sync::watch::channel(0);
        Self {
            dirty,
            restoring: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// A restore is starting: hold every save until `restore_finished`.
    pub fn restore_started(&self) {
        self.restoring
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// The restore is over, however it ended; what stands now is the shape
    /// worth keeping, so it is saved.
    pub fn restore_finished(&self) {
        self.restoring
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.note_change();
    }

    /// Whether a restore is in flight — a last save at shutdown asks, too.
    pub fn restoring(&self) -> bool {
        self.restoring.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The shape changed. Cheap enough to call from the emit path.
    pub fn note_change(&self) {
        self.dirty.send_modify(|n| *n += 1);
    }

    /// Serve until the sender side (this keeper) is dropped, or the future is
    /// cancelled by the host's shutdown.
    pub async fn run(&self, session: String, dir: PathBuf, tx: MonitorCommandSender) {
        let mut rx = self.dirty.subscribe();
        loop {
            if rx.changed().await.is_err() {
                return;
            }
            // Settle: more changes during the debounce restart it.
            loop {
                match tokio::time::timeout(AUTOSAVE_DEBOUNCE, rx.changed()).await {
                    Ok(Ok(())) => continue,
                    Ok(Err(_)) => return,
                    Err(_) => break,
                }
            }
            if self.restoring() {
                continue;
            }
            if save_now(&session, &dir, &tx).await {
                // Something had the terminal for less than a prompt's helper
                // takes; by now it is either gone or the user's program.
                tokio::time::sleep(std::time::Duration::from_secs(MIN_FOREGROUND_AGE_SECS)).await;
                if !self.restoring() {
                    save_now(&session, &dir, &tx).await;
                }
            }
        }
    }
}

/// Take and write one snapshot; failures are logged, never raised — a save
/// that could not happen must not take anything else down with it. Says
/// whether a pane was still settling (see `Discovery::unsettled`).
pub async fn save_now(session: &str, dir: &Path, tx: &MonitorCommandSender) -> bool {
    match take(session, |argv| via_monitor(tx, argv)).await {
        Ok(taken) => {
            if let Err(e) = write(dir, &taken.snapshot) {
                tracing::warn!(target: "tmuxy_core::snapshot", %session, %e, "snapshot not written");
            }
            taken.unsettled
        }
        Err(e) => {
            tracing::warn!(target: "tmuxy_core::snapshot", %session, %e, "snapshot not taken");
            false
        }
    }
}

/// The snapshot a missing session should be rebuilt from, if any. A snapshot
/// that cannot be read is logged and treated as none: the session starts
/// fresh, the server starts regardless.
pub fn restorable(dir: &Path, session: &str) -> Option<Snapshot> {
    if restore_disabled() {
        return None;
    }
    match read_latest(dir, session) {
        Ok(found) => found,
        Err(e) => {
            tracing::warn!(target: "tmuxy_core::snapshot", %session, %e, "snapshot ignored, starting fresh");
            None
        }
    }
}
