//! A tmux session's SHAPE, saved so the session can come back after a reboot.
//!
//! Nothing portable can checkpoint a live process, so this does what every
//! working implementation does (tmux-resurrect, Zellij): it records the tree —
//! windows, panes, layouts, working directories, tmuxy's own `@tmuxy-*` tags —
//! and the program each pane was running, and on restore it rebuilds the tree
//! and *offers* the programs again. A shell comes back as a shell; `vim notes`
//! comes back typed at a prompt, waiting for Enter.
//!
//! Three things are deliberately NOT here, and docs/NON-GOALS.md says why:
//! process state, screen contents by default, and a boot service.
//!
//! The module is pure except for the thin `std::process`/`std::fs` edges at
//! the bottom, because every decision in it — which process is the foreground
//! one, what a restore does first, whether a file is stale — is the kind that
//! only ever goes wrong on a machine nobody is looking at. So the decisions
//! take their inputs as values and are tested as values; the edges just fetch.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::constants::tmux_options;
use crate::{GroupId, PaneId, WindowId};

mod autosave;
mod capture;
mod restore;

pub use autosave::*;
pub use capture::*;
pub use restore::*;

/// The snapshot format. Bump when a saved file would no longer mean what a
/// reader expects; a reader refuses newer versions and starts fresh.
pub const SNAPSHOT_VERSION: u32 = 1;

/// How many snapshots to keep per session, however old.
pub const KEEP_AT_LEAST: usize = 5;
/// Past the last `KEEP_AT_LEAST`, one snapshot per hour is kept for this long…
pub const KEEP_HOURLY_SECS: u64 = 24 * 60 * 60;
/// …and one per day for this long; anything older is pruned.
pub const KEEP_FOR_SECS: u64 = 30 * 24 * 60 * 60;

/// The pane option a program sets to say how to bring itself back.
pub const RESTORE_OPTION: &str = tmux_options::PANE_RESTORE;
/// A foreground program younger than this is not yet one the user is "in":
/// a prompt's helper (`git status`, `id -Gn`) holds the terminal for a few
/// milliseconds, and a save that lands in that window would offer it back
/// as though it were the user's program. The keeper looks again once the
/// age has passed, so a program the user DID just start is recorded then.
pub const MIN_FOREGROUND_AGE_SECS: u64 = 2;
/// What a left sidebar runs; the client starts it the same way
/// (`OpenSidebar` in domain/commands.ts). A sidebar is tmuxy's own window, so a
/// restore runs it rather than offering it. The bundled script by its installed
/// path, not a bare `tmuxy`: that is whatever PATH holds, and a stale one exits
/// at once and takes the column's window with it. The data dir is the one the
/// entry file publishes (`session::DATA_DIR_ENV`), which the pane's shell
/// expands.
pub const LEFT_SIDEBAR_WIDGET: &str = "$TMUXY_DATA_DIR/bin/tmuxy/tmuxy-widget-tree";
/// What a left sidebar ran before: a bare `tmuxy widget tree`, then the
/// bundled script under the config dir, before the scripts moved to the data
/// dir. A snapshot saved then still says so, and restores as the sidebar all
/// the same.
pub const LEGACY_LEFT_SIDEBAR_WIDGETS: [&str; 2] = [
    "tmuxy widget tree",
    "$HOME/.config/tmuxy/bin/tmuxy/tmuxy-widget-tree",
];

// =============================================================================
// Model
// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    pub session: String,
    /// Unix seconds.
    pub saved_at: u64,
    pub windows: Vec<WindowSnapshot>,
    /// Pane-group members not on screen: parked in the stash session, which
    /// every session on the socket shares. Only the members of this session's
    /// groups, in the group's order (the order a group strip lists them in).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden: Vec<HiddenMember>,
}

/// A pane-group member parked out of view. It comes back parked again, in the
/// same group, beside the visible member that carries the group's tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HiddenMember {
    pub group_id: GroupId,
    /// Its place in the group, when the group was reordered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_command: Option<String>,
    /// A command a restore offered and nobody has answered yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offer: Option<String>,
}

impl HiddenMember {
    /// What is offered at its prompt, as for any pane.
    pub fn offered_command(&self) -> Option<String> {
        if let Some(restore) = &self.restore_command {
            return Some(restore.clone());
        }
        self.command
            .as_ref()
            .map(|argv| shell_join(argv))
            .or_else(|| self.offer.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowSnapshot {
    pub index: u32,
    pub name: String,
    pub active: bool,
    /// tmux's `#{window_layout}` in its classic form (tmux 3.8's JSON is
    /// converted on save), replayed through `select-layout`.
    pub layout: String,
    /// `@tmuxy-window-type`: a float or sidebar; `None` for a tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_type: Option<String>,
    /// The INDEX of the parent window — a window id would not survive the
    /// restore, an index does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub float_parent_index: Option<u32>,
    /// The float and sidebar `@tmuxy-*` window options capture reads, verbatim;
    /// a restore puts back only those.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, String>,
    pub panes: Vec<PaneSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneSnapshot {
    pub index: u32,
    pub active: bool,
    pub cwd: String,
    /// The program's argv, when the pane was running something other than its
    /// shell. Offered at the prompt on restore, not run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    /// What the program itself said to run to bring it back (`@tmuxy-pane-restore`).
    /// Wins over `command`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_command: Option<String>,
    /// `@tmuxy-*` pane options worth restoring (the pane group), verbatim.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, String>,
    /// The last lines of the pane, only when a save asked for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scrollback: Option<Vec<String>>,
    /// A command a restore offered and nobody has answered yet: still at its
    /// shell, so nothing else says what the pane was for. Offered again on
    /// the next restore, so a second restart does not lose it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offer: Option<String>,
}

impl PaneSnapshot {
    /// What is offered at the prompt: the program's own word first, then what
    /// was found running, then an offer still waiting from the last restore.
    pub fn offered_command(&self) -> Option<String> {
        if let Some(restore) = &self.restore_command {
            return Some(restore.clone());
        }
        self.command
            .as_ref()
            .map(|argv| shell_join(argv))
            .or_else(|| self.offer.clone())
    }
}

// =============================================================================
// Storage
// =============================================================================

/// Where a server's snapshots live: `sessions/<socket>/` under the state dir.
/// A session is named within its tmux server, not the machine — a released
/// build, the dev server and the E2E suite each have a `tmuxy` session on
/// their own socket (`tmuxy`, `tmuxy-dev`, `tmuxy-test`) — so the socket is
/// part of the key, or one server would rebuild another's session at start.
pub fn snapshot_dir(state_dir: &Path) -> PathBuf {
    let socket = crate::session::tmux_socket();
    // A socket path (`-S /x/y.sock`) keys by its file name, like `tmux -L`.
    let name = socket.rsplit('/').next().unwrap_or(&socket).to_string();
    state_dir.join("sessions").join(name)
}

/// `<name>.<stamp>.json` — the stamp sorts lexically in time order.
fn snapshot_file_name(session: &str, saved_at: u64) -> String {
    format!("{session}.{}.json", stamp(saved_at))
}

fn latest_link(dir: &Path, session: &str) -> PathBuf {
    dir.join(format!("{session}.latest.json"))
}

/// `YYYYMMDDTHHMMSSZ` from unix seconds, with no date crate: the civil
/// calendar from days (Howard Hinnant's algorithm).
pub fn stamp(unix: u64) -> String {
    let days = unix / 86_400;
    let secs = unix % 86_400;
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        secs / 3600,
        (secs / 60) % 60,
        secs % 60
    )
}

/// Why a snapshot could not be used. Never fatal to the caller: a session that
/// cannot be restored is started fresh, and this says why.
#[derive(Debug, PartialEq, Eq)]
pub enum SnapshotError {
    Io(String),
    Unreadable(String),
    NewerVersion(u32),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnapshotError::Io(e) => write!(f, "{e}"),
            SnapshotError::Unreadable(e) => write!(f, "snapshot is not readable: {e}"),
            SnapshotError::NewerVersion(v) => {
                write!(
                    f,
                    "snapshot is version {v}, this tmuxy reads up to {SNAPSHOT_VERSION}"
                )
            }
        }
    }
}

/// Parse a snapshot, refusing one from a newer tmuxy.
pub fn parse(json: &str) -> Result<Snapshot, SnapshotError> {
    let snapshot: Snapshot =
        serde_json::from_str(json).map_err(|e| SnapshotError::Unreadable(e.to_string()))?;
    if snapshot.version > SNAPSHOT_VERSION {
        return Err(SnapshotError::NewerVersion(snapshot.version));
    }
    Ok(snapshot)
}

/// Write a snapshot, atomically, unless the latest one is already identical.
///
/// Returns the path written, or `None` when nothing changed. A write is a
/// rename: a power cut mid-way leaves the previous `latest` intact rather than
/// a truncated file that would block the next restore.
pub fn write(dir: &Path, snapshot: &Snapshot) -> Result<Option<PathBuf>, SnapshotError> {
    let io = |e: std::io::Error| SnapshotError::Io(e.to_string());
    crate::private_files::create_dir_all(dir).map_err(io)?;
    let json = serde_json::to_string_pretty(snapshot)
        .map_err(|e| SnapshotError::Unreadable(e.to_string()))?;

    let latest = latest_link(dir, &snapshot.session);
    if let Ok(existing) = std::fs::read_to_string(&latest) {
        if same_shape(&existing, &json) {
            return Ok(None);
        }
    }

    let target = dir.join(snapshot_file_name(&snapshot.session, snapshot.saved_at));
    let tmp = dir.join(format!(
        ".{}.tmp",
        snapshot_file_name(&snapshot.session, snapshot.saved_at)
    ));
    crate::private_files::write(&tmp, &json).map_err(io)?;
    std::fs::rename(&tmp, &target).map_err(io)?;
    // `latest` is a copy rather than a symlink: a symlink survives nothing on
    // a filesystem that has none, and a copy is one more atomic rename.
    let tmp_latest = dir.join(format!(".{}.latest.tmp", snapshot.session));
    crate::private_files::write(&tmp_latest, &json).map_err(io)?;
    std::fs::rename(&tmp_latest, &latest).map_err(io)?;
    prune(dir, &snapshot.session, snapshot.saved_at);
    Ok(Some(target))
}

/// Identical but for `saved_at`: a save that found nothing changed must not
/// write a new file just because the clock moved.
fn same_shape(a: &str, b: &str) -> bool {
    let strip = |s: &str| {
        s.lines()
            .filter(|l| !l.trim_start().starts_with("\"saved_at\""))
            .collect::<Vec<_>>()
            .join("\n")
    };
    strip(a) == strip(b)
}

/// The dated snapshots of a session, oldest first.
fn dated_files(dir: &Path, session: &str) -> Vec<PathBuf> {
    let prefix = format!("{session}.");
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    name.starts_with(&prefix)
                        && name.ends_with(".json")
                        && !name.ends_with(".latest.json")
                        && !name.starts_with('.')
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// Thin a session's snapshots out with age: the last `KEEP_AT_LEAST`
/// always; past those, the newest of each hour for a day, then the newest of
/// each day for `KEEP_FOR_SECS`; nothing older. A save writes on every
/// structural change, so a busy hour leaves dozens of files, and only the
/// last one of any of them is worth going back to.
pub fn prune(dir: &Path, session: &str, now: u64) {
    let files = dated_files(dir, session);
    let stamp_of = |file: &PathBuf| -> String {
        let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name.trim_start_matches(&format!("{session}."))
            .trim_end_matches(".json")
            .to_string()
    };
    let hourly_cutoff = stamp(now.saturating_sub(KEEP_HOURLY_SECS));
    let daily_cutoff = stamp(now.saturating_sub(KEEP_FOR_SECS));
    // `YYYYMMDDTHH` and `YYYYMMDD`: the hour and the day a stamp falls in.
    let mut hours = std::collections::HashSet::new();
    let mut days = std::collections::HashSet::new();
    for (age, file) in files.iter().rev().enumerate() {
        let file_stamp = stamp_of(file);
        let hour = file_stamp.get(..11).unwrap_or("").to_string();
        let day = file_stamp.get(..8).unwrap_or("").to_string();
        let keep = age < KEEP_AT_LEAST
            || (file_stamp >= hourly_cutoff && !hours.contains(&hour))
            || (file_stamp >= daily_cutoff && !days.contains(&day));
        if keep {
            hours.insert(hour);
            days.insert(day);
        } else {
            let _ = std::fs::remove_file(file);
        }
    }
}

/// The latest snapshot of a session, or why there is none to use.
pub fn read_latest(dir: &Path, session: &str) -> Result<Option<Snapshot>, SnapshotError> {
    let latest = latest_link(dir, session);
    match std::fs::read_to_string(&latest) {
        Ok(json) => parse(&json).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(SnapshotError::Io(e.to_string())),
    }
}

/// Every session that has a snapshot, with when it was last saved.
pub fn list(dir: &Path) -> Vec<(String, u64)> {
    let mut out: Vec<(String, u64)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_str()?.to_string();
                    let session = name.strip_suffix(".latest.json")?.to_string();
                    let json = std::fs::read_to_string(e.path()).ok()?;
                    let snapshot = parse(&json).ok()?;
                    Some((session, snapshot.saved_at))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// Remove every snapshot of a session. Returns how many files went.
pub fn forget(dir: &Path, session: &str) -> usize {
    let mut removed = 0;
    for file in dated_files(dir, session) {
        if std::fs::remove_file(file).is_ok() {
            removed += 1;
        }
    }
    if std::fs::remove_file(latest_link(dir, session)).is_ok() {
        removed += 1;
    }
    removed
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_capture;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_restore;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_storage;
