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

/// The snapshot format. Bump when a saved file would no longer mean what a
/// reader expects; a reader refuses newer versions and starts fresh.
pub const SNAPSHOT_VERSION: u32 = 1;

/// How many snapshots to keep per session, however old.
pub const KEEP_AT_LEAST: usize = 5;
/// Snapshots older than this are pruned, down to `KEEP_AT_LEAST`.
pub const KEEP_FOR_SECS: u64 = 30 * 24 * 60 * 60;

/// The pane option a program sets to say how to bring itself back.
pub const RESTORE_OPTION: &str = crate::constants::tmux_options::PANE_RESTORE;
/// A foreground program younger than this is not yet one the user is "in":
/// a prompt's helper (`git status`, `id -Gn`) holds the terminal for a few
/// milliseconds, and a save that lands in that window would offer it back
/// as though it were the user's program. The keeper looks again once the
/// age has passed, so a program the user DID just start is recorded then.
pub const MIN_FOREGROUND_AGE_SECS: u64 = 2;
/// What a left sidebar runs; the client starts it the same way
/// (`groupsAndFloats.ts`). A sidebar is tmuxy's own window, so a restore
/// runs it rather than offering it.
pub const LEFT_SIDEBAR_WIDGET: &str = "tmuxy widget tree";

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowSnapshot {
    pub index: u32,
    pub name: String,
    pub active: bool,
    /// tmux's `#{window_layout}`, replayed through `select-layout`.
    pub layout: String,
    /// `@tmuxy-window-type`: a float, backdrop or sidebar; `None` for a tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_type: Option<String>,
    /// The INDEX of the parent window — a window id would not survive the
    /// restore, an index does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub float_parent_index: Option<u32>,
    /// Every other `@tmuxy-*` window option, verbatim, restored as-is.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, String>,
    pub panes: Vec<PaneSnapshot>,
}

impl WindowSnapshot {
    /// A window tmuxy draws as its own chrome (a sidebar): what runs in it is
    /// tmuxy's program, so a restore runs it rather than offering it.
    pub fn is_chrome(&self) -> bool {
        self.window_type
            .as_deref()
            .is_some_and(|t| t.starts_with("sidebar-"))
    }
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
}

impl PaneSnapshot {
    /// What is offered at the prompt: the program's own word first.
    pub fn offered_command(&self) -> Option<String> {
        if let Some(restore) = &self.restore_command {
            return Some(restore.clone());
        }
        self.command.as_ref().map(|argv| shell_join(argv))
    }
}

// =============================================================================
// Reading the tree out of tmux
// =============================================================================

/// `s/,/%2C/` keeps a comma in a path or a name from splitting the record.
/// Everything else here is comma-free by construction (ids, flags, numbers).
pub const QUERY_WINDOWS: &str = concat!(
    "list-windows -t #SESSION# -F '",
    "#{window_id},#{window_index},#{window_active},",
    "#{@tmuxy-window-type},#{@tmuxy-float-parent},#{@tmuxy-float-width},",
    "#{@tmuxy-float-height},#{@tmuxy-float-drawer},#{@tmuxy-float-bg},",
    "#{@tmuxy-float-noheader},#{@tmuxy-sidebar-cols},#{@tmuxy-sidebar-hidden},",
    "#{@tmuxy-sidebar-rows},#{@tmuxy-collapsible},",
    "#{s/,/%2C/:window_layout},#{s/,/%2C/:window_name}'"
);

pub const QUERY_PANES: &str = concat!(
    "list-panes -s -t #SESSION# -F '",
    "#{pane_id},#{window_id},#{pane_index},#{pane_active},#{pane_pid},",
    "#{s/,/%2C/:pane_tty},#{s/,/%2C/:pane_current_path},",
    "#{s/,/%2C/:@tmuxy-pane-restore},#{s/,/%2C/:@tmuxy-group-id}'"
);

/// The two queries for `session`, ready to send.
pub fn queries_for(session: &str) -> (String, String) {
    (
        QUERY_WINDOWS.replace("#SESSION#", session),
        QUERY_PANES.replace("#SESSION#", session),
    )
}

fn unescape(field: &str) -> String {
    field.replace("%2C", ",")
}

/// A window as `QUERY_WINDOWS` prints it, before it is tied to its panes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowRecord {
    pub id: String,
    pub index: u32,
    pub active: bool,
    pub window_type: Option<String>,
    pub float_parent_id: Option<String>,
    pub options: BTreeMap<String, String>,
    pub layout: String,
    pub name: String,
}

/// A pane as `QUERY_PANES` prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRecord {
    pub id: String,
    pub window_id: String,
    pub index: u32,
    pub active: bool,
    pub pid: u32,
    pub tty: String,
    pub cwd: String,
    pub restore_command: Option<String>,
    pub group_id: Option<String>,
}

fn opt(field: &str) -> Option<String> {
    let value = unescape(field.trim());
    (!value.is_empty()).then_some(value)
}

/// The window options restored verbatim, in the order `QUERY_WINDOWS` prints
/// them after the type and parent.
const WINDOW_OPTION_NAMES: [&str; 9] = [
    "@tmuxy-float-width",
    "@tmuxy-float-height",
    "@tmuxy-float-drawer",
    "@tmuxy-float-bg",
    "@tmuxy-float-noheader",
    "@tmuxy-sidebar-cols",
    "@tmuxy-sidebar-hidden",
    "@tmuxy-sidebar-rows",
    "@tmuxy-collapsible",
];

pub fn parse_windows(output: &str) -> Vec<WindowRecord> {
    output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').collect();
            // id, index, active, type, parent, 9 options, layout, name
            if parts.len() != 16 || !parts[0].starts_with('@') {
                return None;
            }
            let mut options = BTreeMap::new();
            for (name, value) in WINDOW_OPTION_NAMES.iter().zip(&parts[5..14]) {
                if let Some(value) = opt(value) {
                    options.insert((*name).to_string(), value);
                }
            }
            Some(WindowRecord {
                id: parts[0].to_string(),
                index: parts[1].parse().ok()?,
                active: parts[2] == "1",
                window_type: opt(parts[3]),
                float_parent_id: opt(parts[4]),
                options,
                layout: unescape(parts[14]),
                name: unescape(parts[15]),
            })
        })
        .collect()
}

pub fn parse_panes(output: &str) -> Vec<PaneRecord> {
    output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() != 9 || !parts[0].starts_with('%') {
                return None;
            }
            Some(PaneRecord {
                id: parts[0].to_string(),
                window_id: parts[1].to_string(),
                index: parts[2].parse().ok()?,
                active: parts[3] == "1",
                pid: parts[4].parse().ok()?,
                tty: unescape(parts[5]),
                cwd: unescape(parts[6]),
                restore_command: opt(parts[7]),
                group_id: opt(parts[8]),
            })
        })
        .collect()
}

/// Assemble a snapshot from the two query outputs and whatever each pane was
/// found to be running (`commands`, keyed by pane id).
pub fn assemble(
    session: &str,
    saved_at: u64,
    windows: Vec<WindowRecord>,
    panes: Vec<PaneRecord>,
    commands: &BTreeMap<String, Vec<String>>,
) -> Snapshot {
    let index_of: BTreeMap<&str, u32> = windows.iter().map(|w| (w.id.as_str(), w.index)).collect();
    let mut out: Vec<WindowSnapshot> = windows
        .iter()
        .map(|w| {
            let mut ws_panes: Vec<PaneSnapshot> = panes
                .iter()
                .filter(|p| p.window_id == w.id)
                .map(|p| {
                    let mut options = BTreeMap::new();
                    if let Some(gid) = &p.group_id {
                        options.insert("@tmuxy-group-id".to_string(), gid.clone());
                    }
                    // A sidebar is tmuxy's: what runs in it is the widget
                    // the client started (or, on the right, a shell), never
                    // the helper the widget happens to be sleeping in.
                    let (command, restore_command) = match w.window_type.as_deref() {
                        Some("sidebar-left") => (None, Some(LEFT_SIDEBAR_WIDGET.to_string())),
                        Some("sidebar-right") => (None, None),
                        _ => (commands.get(&p.id).cloned(), p.restore_command.clone()),
                    };
                    PaneSnapshot {
                        index: p.index,
                        active: p.active,
                        cwd: p.cwd.clone(),
                        command,
                        restore_command,
                        options,
                        scrollback: None,
                    }
                })
                .collect();
            ws_panes.sort_by_key(|p| p.index);
            WindowSnapshot {
                index: w.index,
                name: w.name.clone(),
                active: w.active,
                layout: w.layout.clone(),
                window_type: w.window_type.clone(),
                float_parent_index: w
                    .float_parent_id
                    .as_deref()
                    .and_then(|id| index_of.get(id).copied()),
                options: w.options.clone(),
                panes: ws_panes,
            }
        })
        .collect();
    out.sort_by_key(|w| w.index);
    Snapshot {
        version: SNAPSHOT_VERSION,
        session: session.to_string(),
        saved_at,
        windows: out,
    }
}

// =============================================================================
// What a pane is running
// =============================================================================

/// Shells, by the basename of argv[0]. A login shell announces itself with a
/// leading `-` (`-zsh`), which is stripped before the comparison.
const SHELLS: [&str; 12] = [
    "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh",
];

/// Whether argv names a shell rather than a program worth bringing back.
pub fn is_shell(argv: &[String]) -> bool {
    let Some(first) = argv.first() else {
        return true;
    };
    let base = first.trim_start_matches('-');
    let base = base.rsplit('/').next().unwrap_or(base);
    SHELLS.contains(&base)
}

/// The command to ask `ps` for the processes on a pane's terminal.
///
/// `-t` wants the tty without `/dev/` (`ttys003`, `pts/3`); `tpgid` is the
/// foreground process group of that terminal, which is the part that makes
/// this precise: the job that owns the terminal, not a background one and not
/// a child the shell happens to have.
pub fn ps_args(tty: &str) -> Vec<String> {
    let tty = tty.strip_prefix("/dev/").unwrap_or(tty);
    vec![
        "-t".to_string(),
        tty.to_string(),
        "-o".to_string(),
        "pid=,pgid=,tpgid=,etime=,args=".to_string(),
    ]
}

/// `ps`'s elapsed time (`[[dd-]hh:]mm:ss`) in seconds.
pub fn etime_secs(etime: &str) -> Option<u64> {
    let (days, clock) = match etime.split_once('-') {
        Some((d, rest)) => (d.parse::<u64>().ok()?, rest),
        None => (0, etime),
    };
    let mut secs = 0u64;
    for part in clock.split(':') {
        secs = secs * 60 + part.parse::<u64>().ok()?;
    }
    Some(days * 86_400 + secs)
}

/// The foreground program of a terminal as `ps` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Foreground {
    pub argv: Vec<String>,
    /// How long it has had the terminal, from `ps`'s `etime`.
    pub age_secs: u64,
}

impl Foreground {
    /// Old enough to be the user's program rather than a prompt's helper.
    pub fn settled(&self) -> bool {
        self.age_secs >= MIN_FOREGROUND_AGE_SECS
    }
}

/// The foreground program from `ps` output, or `None` when the shell itself
/// has the terminal (or nothing readable does).
///
/// The foreground job is the process group `tpgid` names. Within it the group
/// leader (`pid == pgid`) is the program the user typed; the rest are its
/// children. The shell is excluded by pid and, as a backstop, by name; a
/// process on its way out (`ps` parenthesises its name) is nobody's program.
pub fn foreground(ps_output: &str, shell_pid: u32) -> Option<Foreground> {
    let mut best: Option<(u32, Foreground)> = None;
    for line in ps_output.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(pgid), Some(tpgid), Some(etime)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(pgid), Ok(tpgid)) = (
            pid.parse::<u32>(),
            pgid.parse::<u32>(),
            tpgid.parse::<u32>(),
        ) else {
            continue;
        };
        if pgid != tpgid || pid == shell_pid {
            continue;
        }
        let argv: Vec<String> = it.map(str::to_string).collect();
        if argv.is_empty() || is_shell(&argv) || argv[0].starts_with('(') {
            continue;
        }
        let found = Foreground {
            argv,
            age_secs: etime_secs(etime).unwrap_or(0),
        };
        // The group leader, or failing that the lowest pid in the group.
        let leader = pid == pgid;
        match &best {
            Some((best_pid, _)) if !leader && *best_pid <= pid => {}
            _ => {
                best = Some((pid, found));
                if leader {
                    break;
                }
            }
        }
    }
    best.map(|(_, found)| found)
}

/// The foreground program's argv alone — what `discover_commands` records.
pub fn foreground_argv(ps_output: &str, shell_pid: u32) -> Option<Vec<String>> {
    foreground(ps_output, shell_pid).map(|f| f.argv)
}

/// A shell line for argv, quoted so it round-trips through a prompt.
pub fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn shell_quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

// =============================================================================
// Storage
// =============================================================================

/// Where a state dir keeps snapshots.
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
    std::fs::create_dir_all(dir).map_err(io)?;
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
    std::fs::write(&tmp, &json).map_err(io)?;
    std::fs::rename(&tmp, &target).map_err(io)?;
    // `latest` is a copy rather than a symlink: a symlink survives nothing on
    // a filesystem that has none, and a copy is one more atomic rename.
    let tmp_latest = dir.join(format!(".{}.latest.tmp", snapshot.session));
    std::fs::write(&tmp_latest, &json).map_err(io)?;
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

/// Keep the last `KEEP_AT_LEAST`, and anything younger than `KEEP_FOR_SECS`.
pub fn prune(dir: &Path, session: &str, now: u64) {
    let files = dated_files(dir, session);
    let cutoff = stamp(now.saturating_sub(KEEP_FOR_SECS));
    let keep_from = files.len().saturating_sub(KEEP_AT_LEAST);
    for (i, file) in files.iter().enumerate() {
        if i >= keep_from {
            break;
        }
        let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let file_stamp = name
            .trim_start_matches(&format!("{session}."))
            .trim_end_matches(".json");
        if file_stamp < cutoff.as_str() {
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

// =============================================================================
// Restore
// =============================================================================

#[derive(Debug, Clone, Default)]
pub struct RestoreOptions {
    /// Run each offered command instead of leaving it typed at the prompt.
    pub run: bool,
    /// A directory to use when a pane's own has gone.
    pub fallback_cwd: String,
    /// The session already exists with one window at index 0 (the one
    /// `new-session -A` just made) — build onto it instead of creating one.
    /// This is the restore-on-start path, which runs over control mode after
    /// the client has attached, so there is never a clientless server.
    pub onto_existing_window: bool,
    /// The index that window has. `base-index` decides it (tmuxy's config
    /// says 1), so it is asked of tmux rather than assumed; `None` means 0.
    pub existing_window_index: Option<u32>,
}

impl Snapshot {
    /// What the first window should be made as, for a `new-session -A` that
    /// will be built onto: its name and its first pane's directory.
    pub fn first_window_hint(&self, fallback_cwd: &str) -> Option<(String, String)> {
        let first = self.windows.first()?;
        let cwd = first
            .panes
            .first()
            .map(|p| p.cwd.as_str())
            .filter(|c| !c.is_empty() && Path::new(c).is_dir())
            .unwrap_or(fallback_cwd);
        Some((first.name.clone(), cwd.to_string()))
    }
}

/// A tmux command as argv, without the `tmux` word.
pub type TmuxArgv = Vec<String>;

/// Something a restore needs tmux to run or answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Run this; the output does not matter.
    Run(TmuxArgv),
    /// Run this and keep the trimmed output under `key`, for later steps to
    /// name as `#<key>#`.
    Ask { key: String, argv: TmuxArgv },
}

/// Fill `#<key>#` placeholders from the answers so far.
pub fn fill(argv: &[String], answers: &BTreeMap<String, String>) -> TmuxArgv {
    argv.iter()
        .map(|a| {
            let mut out = a.clone();
            for (key, value) in answers {
                out = out.replace(&format!("#{key}#"), value);
            }
            out
        })
        .collect()
}

/// Run every step of `steps`, threading answers into the steps after them.
///
/// `runner` is the only thing that touches tmux, which is what lets a plan be
/// tested by reading it back and the executor be tested with a fake.
pub fn run_steps<F>(steps: &[Step], mut runner: F) -> Result<(), String>
where
    F: FnMut(&[String]) -> Result<String, String>,
{
    let mut answers = BTreeMap::new();
    for step in steps {
        match step {
            Step::Run(argv) => {
                runner(&fill(argv, &answers))?;
            }
            Step::Ask { key, argv } => {
                let answer = runner(&fill(argv, &answers))?.trim().to_string();
                answers.insert(key.clone(), answer);
            }
        }
    }
    Ok(())
}

/// Plan and run a restore through `runner`.
pub fn apply<F>(snapshot: &Snapshot, options: &RestoreOptions, runner: F) -> Result<(), String>
where
    F: FnMut(&[String]) -> Result<String, String>,
{
    run_steps(&plan(snapshot, options), runner)
}

fn target(session: &str, window_index: u32) -> String {
    format!("{session}:{window_index}")
}

fn pane_target(session: &str, window_index: u32, pane_index: u32) -> String {
    format!("{session}:{window_index}.{pane_index}")
}

fn cwd_or_fallback(cwd: &str, options: &RestoreOptions) -> String {
    if !cwd.is_empty() && Path::new(cwd).is_dir() {
        cwd.to_string()
    } else {
        options.fallback_cwd.clone()
    }
}

fn argv(words: &[&str]) -> TmuxArgv {
    words.iter().map(|w| (*w).to_string()).collect()
}

/// The tmux commands that rebuild a session from its snapshot, in order.
///
/// Why the shape is what it is:
///
///   * Windows are made with `split-window ; break-pane`, never `new-window`:
///     `new-window` crashes tmux 3.5a while a control-mode client is attached
///     (docs/TMUX.md), and a restore run from the CLI is exactly that case.
///   * Panes are split in index order and the layout applied LAST: tmux maps a
///     layout's cells onto panes by their order, so a window with the right
///     number of panes takes its old layout exactly.
///   * `@tmuxy-float-parent` is a window ID, which does not survive. It is
///     looked up (`Ask`) by the parent's index after every window exists.
///   * Each offered command is typed with `send-keys -l`, not run; `run` adds
///     the Enter. A program that was running is not proof it should run again.
///   * A pane with saved scrollback starts as `cat` of that text and then the
///     shell, so what was on screen is on screen again above a fresh prompt.
pub fn plan(snapshot: &Snapshot, options: &RestoreOptions) -> Vec<Step> {
    let s = &snapshot.session;
    let mut steps = Vec::new();
    let Some(first) = snapshot.windows.first() else {
        return steps;
    };
    let first_pane_cwd = first
        .panes
        .first()
        .map(|p| cwd_or_fallback(&p.cwd, options))
        .unwrap_or_else(|| options.fallback_cwd.clone());

    // The session, with its first window — or the window `new-session -A`
    // already made, renamed and moved to the first window's index.
    if options.onto_existing_window {
        let placeholder = options.existing_window_index.unwrap_or(0);
        steps.push(Step::Run(argv(&[
            "rename-window",
            "-t",
            &target(s, placeholder),
            &first.name,
        ])));
        if first.index != placeholder {
            steps.push(Step::Run(argv(&[
                "move-window",
                "-s",
                &target(s, placeholder),
                "-t",
                &target(s, first.index),
            ])));
        }
    } else {
        steps.push(Step::Run(argv(&[
            "new-session",
            "-d",
            "-s",
            s,
            "-n",
            &first.name,
            "-c",
            &first_pane_cwd,
        ])));
    }

    // Every other window: split off the first window, break out at its index.
    // `-P -F` prints the new pane's id, and that id is what gets broken out —
    // never "the current pane", which is whatever the user is looking at.
    for w in snapshot.windows.iter().skip(1) {
        let cwd = w
            .panes
            .first()
            .map(|p| cwd_or_fallback(&p.cwd, options))
            .unwrap_or_else(|| options.fallback_cwd.clone());
        let key = format!("PANE_W{}", w.index);
        steps.push(Step::Ask {
            key: key.clone(),
            argv: argv(&[
                "split-window",
                "-d",
                "-t",
                &target(s, first.index),
                "-c",
                &cwd,
                "-P",
                "-F",
                "#{pane_id}",
            ]),
        });
        steps.push(Step::Run(argv(&[
            "break-pane",
            "-d",
            "-s",
            &format!("#{key}#"),
            "-t",
            &target(s, w.index),
            "-n",
            &w.name,
        ])));
    }

    // Each window's panes and layout, and its options.
    for w in &snapshot.windows {
        for p in w.panes.iter().skip(1) {
            steps.push(Step::Run(argv(&[
                "split-window",
                "-d",
                "-t",
                &target(s, w.index),
                "-c",
                &cwd_or_fallback(&p.cwd, options),
            ])));
        }
        if !w.layout.is_empty() && w.panes.len() > 1 {
            steps.push(Step::Run(argv(&[
                "select-layout",
                "-t",
                &target(s, w.index),
                &w.layout,
            ])));
        }
        if let Some(kind) = &w.window_type {
            steps.push(Step::Run(argv(&[
                "set-option",
                "-w",
                "-t",
                &target(s, w.index),
                "@tmuxy-window-type",
                kind,
            ])));
        }
        for (name, value) in &w.options {
            steps.push(Step::Run(argv(&[
                "set-option",
                "-w",
                "-t",
                &target(s, w.index),
                name,
                value,
            ])));
        }
        for p in &w.panes {
            for (name, value) in &p.options {
                steps.push(Step::Run(argv(&[
                    "set-option",
                    "-p",
                    "-t",
                    &pane_target(s, w.index, p.index),
                    name,
                    value,
                ])));
            }
        }
    }

    // Float parents, now that every window has an id.
    for w in &snapshot.windows {
        if let Some(parent) = w.float_parent_index {
            let key = format!("WIN{parent}");
            steps.push(Step::Ask {
                key: key.clone(),
                argv: argv(&[
                    "display-message",
                    "-p",
                    "-t",
                    &target(s, parent),
                    "#{window_id}",
                ]),
            });
            steps.push(Step::Run(argv(&[
                "set-option",
                "-w",
                "-t",
                &target(s, w.index),
                "@tmuxy-float-parent",
                &format!("#{key}#"),
            ])));
        }
    }

    // What each pane was doing.
    for w in &snapshot.windows {
        for p in &w.panes {
            let pane = pane_target(s, w.index, p.index);
            if let Some(lines) = &p.scrollback {
                if !lines.is_empty() {
                    // Printed, not typed: `-l` would send it to the shell.
                    let text = lines.join("\n");
                    steps.push(Step::Run(argv(&[
                        "run-shell",
                        "-t",
                        &pane,
                        &format!("printf '%s\\n' {}", shell_quote(&text)),
                    ])));
                }
            }
            if let Some(cmd) = p.offered_command() {
                let chrome = w.is_chrome();
                if let (Some(word), false) = (&p.restore_command, chrome) {
                    // The program's own word outlives the offer: typed and
                    // not run, it would otherwise be gone from the next save.
                    steps.push(Step::Run(argv(&[
                        "set-option",
                        "-p",
                        "-t",
                        &pane,
                        RESTORE_OPTION,
                        word,
                    ])));
                }
                steps.push(Step::Run(argv(&["send-keys", "-t", &pane, "-l", &cmd])));
                if options.run || chrome {
                    steps.push(Step::Run(argv(&["send-keys", "-t", &pane, "Enter"])));
                }
            }
        }
    }

    // Focus, last: the active pane of every window, then the active window.
    for w in &snapshot.windows {
        if let Some(p) = w.panes.iter().find(|p| p.active) {
            steps.push(Step::Run(argv(&[
                "select-pane",
                "-t",
                &pane_target(s, w.index, p.index),
            ])));
        }
    }
    if let Some(w) = snapshot.windows.iter().find(|w| w.active) {
        steps.push(Step::Run(argv(&[
            "select-window",
            "-t",
            &target(s, w.index),
        ])));
    }
    steps
}

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
    pub commands: BTreeMap<String, Vec<String>>,
    pub unsettled: bool,
}

/// A snapshot as taken, with whether a pane was still settling when it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Taken {
    pub snapshot: Snapshot,
    pub unsettled: bool,
}

/// Take a snapshot of `session` through `run`, which runs one tmux command
/// (as argv, without `tmux`) and returns its output.
pub fn take<F>(session: &str, mut run: F) -> Result<Taken, String>
where
    F: FnMut(&[String]) -> Result<String, String>,
{
    let (qw, qp) = queries_for(session);
    let windows_out = run(&split_query(&qw))?;
    let panes_out = run(&split_query(&qp))?;
    let windows = parse_windows(&windows_out);
    let panes = parse_panes(&panes_out);
    let found = discover_commands(&panes);
    Ok(Taken {
        snapshot: assemble(session, now(), windows, panes, &found.commands),
        unsettled: found.unsettled,
    })
}

/// `list-panes -s -t x -F '…'` as argv: the format is the one quoted word.
fn split_query(query: &str) -> Vec<String> {
    let (head, format) = query.split_once(" -F '").unwrap_or((query, ""));
    let mut argv: Vec<String> = head.split_whitespace().map(str::to_string).collect();
    if !format.is_empty() {
        argv.push("-F".to_string());
        argv.push(format.trim_end_matches('\'').to_string());
    }
    argv
}

/// Attach the last `lines` of each pane's screen to a snapshot, through `run`.
pub fn attach_scrollback<F>(snapshot: &mut Snapshot, lines: u32, mut run: F)
where
    F: FnMut(&[String]) -> Result<String, String>,
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
            if let Ok(text) = run(&argv) {
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

/// The state directory: `TMUXY_STATE_DIR`, else the XDG state dir (macOS has
/// none, so `~/Library/Application Support`), under `tmuxy` — the same place
/// the trace and the browser profiles go, and deliberately nowhere any route
/// serves files from.
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TMUXY_STATE_DIR") {
        return PathBuf::from(dir);
    }
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
        .unwrap_or_else(std::env::temp_dir)
        .join("tmuxy")
}

pub fn default_dir() -> PathBuf {
    snapshot_dir(&state_dir())
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
                    || d.pane_widget.is_some()
                    || d.pane_restore.is_some()
            }
        })
    })
}

// =============================================================================
// Through a running monitor: the hosts' half
// =============================================================================

use crate::control_mode::{MonitorCommand, MonitorCommandSender};

/// Run one tmux command through a monitor's control-mode connection.
async fn via_monitor(tx: &MonitorCommandSender, argv: &[String]) -> Result<String, String> {
    let command = argv
        .iter()
        .map(|a| tmux_word(a))
        .collect::<Vec<_>>()
        .join(" ");
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.send(MonitorCommand::RunCommandWithReply { command, reply })
        .await
        .map_err(|e| format!("monitor channel: {e}"))?;
    let reply: crate::control_mode::CommandReply = rx
        .await
        .map_err(|_| "monitor went away before answering".to_string())?;
    reply.into_result()
}

/// One argv word as tmux's own command parser reads it: double-quoted, with
/// the characters that mean something inside double quotes escaped.
///
/// A format such as `#{window_id}` MUST be quoted: to tmux's parser a bare
/// `#` starts a comment, so an unquoted format vanishes and the command fails
/// with "-F expects an argument". Inside double quotes it is just text, and
/// the command expands it when it runs. Found by the first real save, which
/// never wrote a file.
pub fn tmux_word(word: &str) -> String {
    if !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,{}".contains(c))
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

/// Take a snapshot of the monitor's session through its connection.
pub async fn take_via_monitor(session: &str, tx: &MonitorCommandSender) -> Result<Taken, String> {
    let (qw, qp) = queries_for(session);
    let windows_out = via_monitor(tx, &split_query(&qw)).await?;
    let panes_out = via_monitor(tx, &split_query(&qp)).await?;
    let windows = parse_windows(&windows_out);
    let panes = parse_panes(&panes_out);
    // `ps` is a subprocess; off the async runtime like the other reads.
    let found = tokio::task::spawn_blocking(move || discover_commands(&panes))
        .await
        .map_err(|e| e.to_string())?;
    let panes = parse_panes(&panes_out);
    Ok(Taken {
        snapshot: assemble(session, now(), windows, panes, &found.commands),
        unsettled: found.unsettled,
    })
}

/// Rebuild a snapshot through a monitor's connection, step by step.
pub async fn restore_via_monitor(
    snapshot: &Snapshot,
    options: &RestoreOptions,
    tx: &MonitorCommandSender,
) -> Result<(), String> {
    let mut options = options.clone();
    if options.onto_existing_window && options.existing_window_index.is_none() {
        // `^` is tmux's "first window" target; its index is whatever
        // `base-index` made it.
        let first = via_monitor(
            tx,
            &[
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
    let options = &options;
    let mut answers = BTreeMap::new();
    for step in plan(snapshot, options) {
        match step {
            Step::Run(argv) => {
                via_monitor(tx, &fill(&argv, &answers)).await?;
            }
            Step::Ask { key, argv } => {
                let answer = via_monitor(tx, &fill(&argv, &answers)).await?;
                answers.insert(key, answer.trim().to_string());
            }
        }
    }
    Ok(())
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
    dirty: tokio::sync::watch::Sender<u64>,
}

impl Default for SnapshotKeeper {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapshotKeeper {
    pub fn new() -> Self {
        let (dirty, _) = tokio::sync::watch::channel(0);
        Self { dirty }
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
            if save_now(&session, &dir, &tx).await {
                // Something had the terminal for less than a prompt's helper
                // takes; by now it is either gone or the user's program.
                tokio::time::sleep(std::time::Duration::from_secs(MIN_FOREGROUND_AGE_SECS)).await;
                save_now(&session, &dir, &tx).await;
            }
        }
    }
}

/// Take and write one snapshot; failures are logged, never raised — a save
/// that could not happen must not take anything else down with it. Says
/// whether a pane was still settling (see `Discovery::unsettled`).
pub async fn save_now(session: &str, dir: &Path, tx: &MonitorCommandSender) -> bool {
    match take_via_monitor(session, tx).await {
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn window_line(
        id: &str,
        index: u32,
        active: bool,
        kind: &str,
        parent: &str,
        layout: &str,
        name: &str,
    ) -> String {
        // id, index, active, type, parent, nine empty options, layout, name
        format!(
            "{id},{index},{},{kind},{parent},,,,,,,,,,{layout},{name}",
            u8::from(active)
        )
    }

    #[test]
    fn a_window_record_round_trips_its_tags_and_a_comma_in_its_name() {
        let out = [
            window_line("@1", 0, true, "", "", "a1b2%2C80x24%2C0%2C0%2C5", "main"),
            // A float, with a parent and a width; the name has a comma.
            "@3,2,0,float,@1,120,40,,dim,1,,,,,b7c1%2C120x40%2C0%2C0%2C9,notes%2C today"
                .to_string(),
        ]
        .join("\n");
        let windows = parse_windows(&out);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].layout, "a1b2,80x24,0,0,5");
        assert_eq!(windows[0].name, "main");
        assert!(windows[0].active);
        assert_eq!(windows[1].window_type.as_deref(), Some("float"));
        assert_eq!(windows[1].float_parent_id.as_deref(), Some("@1"));
        assert_eq!(windows[1].options["@tmuxy-float-width"], "120");
        assert_eq!(windows[1].options["@tmuxy-float-bg"], "dim");
        assert_eq!(windows[1].options["@tmuxy-float-noheader"], "1");
        assert!(!windows[1].options.contains_key("@tmuxy-float-drawer"));
        assert_eq!(windows[1].name, "notes, today");
    }

    #[test]
    fn a_pane_record_keeps_a_comma_in_its_path_and_its_restore_command() {
        let out = "%5,@1,0,1,4242,/dev/ttys003,/Users/x/a%2Cb,claude --resume abc%2Cdef,g2\n\
                   garbage line\n\
                   %6,@1,1,0,4300,/dev/ttys004,/tmp,,";
        let panes = parse_panes(out);
        assert_eq!(panes.len(), 2);
        assert_eq!(panes[0].cwd, "/Users/x/a,b");
        assert_eq!(
            panes[0].restore_command.as_deref(),
            Some("claude --resume abc,def")
        );
        assert_eq!(panes[0].group_id.as_deref(), Some("g2"));
        assert_eq!(panes[0].pid, 4242);
        assert!(panes[1].restore_command.is_none());
        assert!(panes[1].group_id.is_none());
    }

    #[test]
    fn the_queries_name_the_session_and_escape_what_can_hold_a_comma() {
        let (w, p) = queries_for("work");
        assert!(w.starts_with("list-windows -t work "));
        assert!(w.contains("#{s/,/%2C/:window_layout}"));
        assert!(w.contains("#{s/,/%2C/:window_name}"));
        assert!(p.contains("#{s/,/%2C/:pane_current_path}"));
        assert!(p.contains("#{s/,/%2C/:@tmuxy-pane-restore}"));
        // The argv form keeps the format as one word.
        let argv = split_query(&p);
        assert_eq!(argv[0], "list-panes");
        assert_eq!(argv[argv.len() - 2], "-F");
        assert!(argv[argv.len() - 1].starts_with("#{pane_id},"));
        assert!(!argv[argv.len() - 1].ends_with('\''));
    }

    /// The foreground job is the group `tpgid` names; the shell is not it.
    #[test]
    fn the_foreground_program_is_the_leader_of_the_terminals_foreground_group() {
        let ps = "\
  4242  4242  5100 01:02:03 -zsh\n\
  5100  5100  5100    12:30 vim notes.md\n\
  5101  5100  5100    00:02 /bin/sh -c spell\n";
        assert_eq!(
            foreground_argv(ps, 4242),
            Some(vec!["vim".to_string(), "notes.md".to_string()])
        );
    }

    #[test]
    fn an_idle_shell_has_nothing_to_offer() {
        // The shell is the foreground group itself.
        let ps = "  4242  4242  4242 01:02:03 -zsh\n";
        assert_eq!(foreground_argv(ps, 4242), None);
        // A background job does not count: its group is not the foreground one.
        let ps = "  4242  4242  4242 01:02:03 -zsh\n  5000  5000  4242 00:10 sleep 100\n";
        assert_eq!(foreground_argv(ps, 4242), None);
        // A process on its way out is nobody's program.
        let ps = "  4242  4242  5300 01:02:03 -zsh\n  5300  5300  5300 00:00 (id)\n";
        assert_eq!(foreground_argv(ps, 4242), None);
    }

    /// `sudo vim` makes sudo the leader; the user typed sudo, so that is right.
    #[test]
    fn a_wrapper_is_recorded_as_typed() {
        let ps = "  4242  4242  5200 01:02:03 -zsh\n  5200  5200  5200 05:00 sudo vim /etc/hosts\n  5201  5200  5200 05:00 vim /etc/hosts\n";
        assert_eq!(foreground_argv(ps, 4242).unwrap()[0], "sudo");
    }

    /// A prompt's helper holds the terminal for milliseconds; the program the
    /// user started a moment ago looks the same until it has aged.
    #[test]
    fn a_foreground_younger_than_a_prompt_helper_is_not_settled() {
        let ps = "  4242  4242  5400 01:02:03 -zsh\n  5400  5400  5400 00:00 id -Gn\n";
        let young = foreground(ps, 4242).unwrap();
        assert_eq!(young.argv, vec!["id".to_string(), "-Gn".to_string()]);
        assert!(!young.settled());
        let ps = "  4242  4242  5400 01:02:03 -zsh\n  5400  5400  5400 00:02 claude\n";
        assert!(foreground(ps, 4242).unwrap().settled());
        assert_eq!(etime_secs("2-01:00:05"), Some(86_400 * 2 + 3_605));
        assert_eq!(etime_secs("00:02"), Some(2));
        assert_eq!(etime_secs("x"), None);
    }

    #[test]
    fn shells_are_known_by_basename_with_or_without_the_login_dash() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(is_shell(&s(&["-zsh"])));
        assert!(is_shell(&s(&["/bin/bash", "-l"])));
        assert!(is_shell(&s(&["fish"])));
        assert!(!is_shell(&s(&["vim"])));
        assert!(!is_shell(&s(&["/usr/bin/nvim", "-S"])));
        assert!(is_shell(&[]), "nothing readable is treated as the shell");
    }

    #[test]
    fn a_command_is_offered_as_a_shell_line_that_round_trips() {
        let argv = vec![
            "claude".to_string(),
            "--resume".to_string(),
            "it's me".to_string(),
        ];
        assert_eq!(shell_join(&argv), r"claude --resume 'it'\''s me'");
        let pane = PaneSnapshot {
            index: 0,
            active: true,
            cwd: "/".into(),
            command: Some(argv),
            restore_command: Some("claude --resume abc".into()),
            options: BTreeMap::new(),
            scrollback: None,
        };
        assert_eq!(
            pane.offered_command().as_deref(),
            Some("claude --resume abc"),
            "the program's own word wins"
        );
    }

    #[test]
    fn the_stamp_is_a_sortable_utc_date() {
        assert_eq!(stamp(0), "19700101T000000Z");
        assert_eq!(stamp(1_759_622_400), "20251005T000000Z");
        assert!(stamp(1_759_622_400) < stamp(1_759_622_401));
    }

    fn fixture() -> Snapshot {
        let mut float_opts = BTreeMap::new();
        float_opts.insert("@tmuxy-float-width".to_string(), "100".to_string());
        let mut group = BTreeMap::new();
        group.insert("@tmuxy-group-id".to_string(), "g1".to_string());
        Snapshot {
            version: SNAPSHOT_VERSION,
            session: "work".into(),
            saved_at: 1_759_622_400,
            windows: vec![
                WindowSnapshot {
                    index: 0,
                    name: "main".into(),
                    active: false,
                    layout: "b1c2,80x24,0,0{40x24,0,0,1,39x24,41,0,2}".into(),
                    window_type: None,
                    float_parent_index: None,
                    options: BTreeMap::new(),
                    panes: vec![
                        PaneSnapshot {
                            index: 0,
                            active: false,
                            cwd: "/tmp".into(),
                            command: None,
                            restore_command: None,
                            options: group.clone(),
                            scrollback: None,
                        },
                        PaneSnapshot {
                            index: 1,
                            active: true,
                            cwd: "/does/not/exist".into(),
                            command: Some(vec!["vim".into(), "a".into()]),
                            restore_command: None,
                            options: BTreeMap::new(),
                            scrollback: None,
                        },
                    ],
                },
                WindowSnapshot {
                    index: 2,
                    name: "notes".into(),
                    active: true,
                    layout: "a1b2,100x30,0,0,5".into(),
                    window_type: Some("float".into()),
                    float_parent_index: Some(0),
                    options: float_opts,
                    panes: vec![PaneSnapshot {
                        index: 0,
                        active: true,
                        cwd: "/tmp".into(),
                        command: None,
                        restore_command: Some("tmuxy browser --repl".into()),
                        options: BTreeMap::new(),
                        scrollback: None,
                    }],
                },
            ],
        }
    }

    fn joined(steps: &[Step]) -> Vec<String> {
        steps
            .iter()
            .map(|s| match s {
                Step::Run(a) => format!("run: {}", a.join(" ")),
                Step::Ask { argv: a, .. } => format!("ask: {}", a.join(" ")),
            })
            .collect()
    }

    #[test]
    fn a_restore_never_uses_new_window_and_applies_each_layout_after_its_splits() {
        let steps = plan(
            &fixture(),
            &RestoreOptions {
                run: false,
                fallback_cwd: "/home/x".into(),
                ..Default::default()
            },
        );
        let lines = joined(&steps);
        assert!(
            lines.iter().all(|l| !l.contains("new-window")),
            "{lines:#?}"
        );
        assert_eq!(lines[0], "run: new-session -d -s work -n main -c /tmp");
        // The float is split off window 0 and broken out at its index, by id.
        let i_split = lines
            .iter()
            .position(|l| l.starts_with("ask: split-window -d -t work:0 -c /tmp -P -F"))
            .unwrap();
        assert_eq!(
            lines[i_split + 1],
            "run: break-pane -d -s #PANE_W2# -t work:2 -n notes"
        );
        // Window 0's second pane, then its layout.
        let i_pane = lines
            .iter()
            .position(|l| l == "run: split-window -d -t work:0 -c /home/x")
            .unwrap();
        let i_layout = lines
            .iter()
            .position(|l| l.starts_with("run: select-layout -t work:0 "))
            .unwrap();
        assert!(i_pane < i_layout);
        // A one-pane window gets no layout.
        assert!(!lines
            .iter()
            .any(|l| l.starts_with("run: select-layout -t work:2")));
    }

    #[test]
    fn a_vanished_directory_falls_back_without_failing_the_restore() {
        let steps = plan(
            &fixture(),
            &RestoreOptions {
                run: false,
                fallback_cwd: "/home/x".into(),
                ..Default::default()
            },
        );
        let lines = joined(&steps);
        assert!(lines.contains(&"run: split-window -d -t work:0 -c /home/x".to_string()));
    }

    #[test]
    fn tags_come_back_and_the_float_parent_is_looked_up_by_index() {
        let lines = joined(&plan(&fixture(), &RestoreOptions::default()));
        assert!(
            lines.contains(&"run: set-option -w -t work:2 @tmuxy-window-type float".to_string())
        );
        assert!(lines.contains(&"run: set-option -w -t work:2 @tmuxy-float-width 100".to_string()));
        assert!(lines.contains(&"run: set-option -p -t work:0.0 @tmuxy-group-id g1".to_string()));
        let i_ask = lines
            .iter()
            .position(|l| l == "ask: display-message -p -t work:0 #{window_id}")
            .unwrap();
        assert_eq!(
            lines[i_ask + 1],
            "run: set-option -w -t work:2 @tmuxy-float-parent #WIN0#"
        );
    }

    #[test]
    fn commands_are_typed_not_run_unless_asked() {
        let typed = joined(&plan(&fixture(), &RestoreOptions::default()));
        assert!(typed.contains(&"run: send-keys -t work:0.1 -l vim a".to_string()));
        assert!(
            typed.contains(&"run: send-keys -t work:2.0 -l tmuxy browser --repl".to_string()),
            "the restore tag wins"
        );
        assert!(!typed.iter().any(|l| l.ends_with(" Enter")));
        let run = joined(&plan(
            &fixture(),
            &RestoreOptions {
                run: true,
                ..Default::default()
            },
        ));
        assert!(run.contains(&"run: send-keys -t work:0.1 Enter".to_string()));
    }

    /// A program's own word is typed AND written back as the pane's tag, so
    /// a save after the restore still carries it; a sidebar's widget is run,
    /// not offered, because it is tmuxy's own window.
    #[test]
    fn a_restore_keeps_the_programs_word_and_runs_the_chrome() {
        let mut snapshot = fixture();
        snapshot.windows.push(WindowSnapshot {
            index: 3,
            name: "__sidebar-left".into(),
            active: false,
            layout: "bd23,30x27,0,0,6".into(),
            window_type: Some("sidebar-left".into()),
            float_parent_index: None,
            options: BTreeMap::new(),
            panes: vec![PaneSnapshot {
                index: 0,
                active: true,
                cwd: "/tmp".into(),
                command: None,
                restore_command: Some(LEFT_SIDEBAR_WIDGET.into()),
                options: BTreeMap::new(),
                scrollback: None,
            }],
        });
        let lines = joined(&plan(&snapshot, &RestoreOptions::default()));
        let i_tag = lines
            .iter()
            .position(|l| {
                l == "run: set-option -p -t work:2.0 @tmuxy-pane-restore tmuxy browser --repl"
            })
            .expect("the browser pane's word is written back");
        assert_eq!(
            lines[i_tag + 1],
            "run: send-keys -t work:2.0 -l tmuxy browser --repl"
        );
        assert!(!lines.contains(&"run: send-keys -t work:2.0 Enter".to_string()));
        // A discovered command is not a tag: nothing is written for vim.
        assert!(!lines
            .iter()
            .any(|l| l.contains("-t work:0.1 @tmuxy-pane-restore")));
        // The sidebar's widget runs, and is not tagged.
        let i_widget = lines
            .iter()
            .position(|l| l == "run: send-keys -t work:3.0 -l tmuxy widget tree")
            .unwrap();
        assert_eq!(lines[i_widget + 1], "run: send-keys -t work:3.0 Enter");
        assert!(!lines
            .iter()
            .any(|l| l.contains("-t work:3.0 @tmuxy-pane-restore")));
    }

    /// A sidebar's pane says what the client runs there, never what `ps` saw
    /// the widget sleeping in.
    #[test]
    fn a_sidebar_comes_back_as_its_widget_not_the_helper_it_sleeps_in() {
        let windows = parse_windows(&format!(
            "{}\n{}",
            window_line("@1", 0, true, "", "", "a1b2%2C80x24%2C0%2C0%2C5", "main"),
            window_line(
                "@2",
                1,
                false,
                "sidebar-left",
                "",
                "bd23%2C30x27%2C0%2C0%2C6",
                "__sidebar-left"
            )
        ));
        let panes =
            parse_panes("%5,@1,0,1,100,/dev/ttys001,/tmp,,\n%6,@2,0,1,200,/dev/ttys002,/tmp,,");
        let mut commands = BTreeMap::new();
        commands.insert("%5".to_string(), vec!["vim".to_string()]);
        commands.insert(
            "%6".to_string(),
            vec!["sleep".to_string(), "3600".to_string()],
        );
        let snapshot = assemble("s", 1, windows, panes, &commands);
        assert_eq!(
            snapshot.windows[0].panes[0].command,
            Some(vec!["vim".to_string()])
        );
        let sidebar = &snapshot.windows[1].panes[0];
        assert_eq!(sidebar.command, None);
        assert_eq!(
            sidebar.restore_command.as_deref(),
            Some(LEFT_SIDEBAR_WIDGET)
        );
    }

    /// The restore-on-start path builds onto the window `new-session -A` made.
    #[test]
    fn restoring_onto_an_existing_session_renames_window_zero_instead_of_creating() {
        let lines = joined(&plan(
            &fixture(),
            &RestoreOptions {
                onto_existing_window: true,
                ..Default::default()
            },
        ));
        assert!(!lines.iter().any(|l| l.starts_with("run: new-session")));
        assert_eq!(lines[0], "run: rename-window -t work:0 main");
        // With `base-index 1` the placeholder sits at 1 and must be moved to
        // the snapshot's first index — the failure the first real restore hit.
        let based = joined(&plan(
            &fixture(),
            &RestoreOptions {
                onto_existing_window: true,
                existing_window_index: Some(1),
                ..Default::default()
            },
        ));
        assert_eq!(based[0], "run: rename-window -t work:1 main");
        assert_eq!(based[1], "run: move-window -s work:1 -t work:0");
        assert!(
            !lines.iter().any(|l| l.starts_with("run: move-window")),
            "the first window is at 0 already"
        );
        // The hint names the first window and its first pane's directory.
        let snap = fixture();
        let (name, cwd) = snap.first_window_hint("/home/x").unwrap();
        assert_eq!(name, "main");
        assert_eq!(cwd, "/tmp");
    }

    #[test]
    fn a_tmux_word_quotes_what_tmux_would_otherwise_split_or_expand() {
        // A bare `#` is a comment to tmux's parser: a format is always quoted.
        assert_eq!(tmux_word("#{window_id}"), "\"#{window_id}\"");
        assert_eq!(
            tmux_word("#{s/,/%2C/:window_layout}"),
            "\"#{s/,/%2C/:window_layout}\""
        );
        assert_eq!(
            tmux_word("b1c2,80x24,0,0{40x24,0,0,1}"),
            "b1c2,80x24,0,0{40x24,0,0,1}"
        );
        assert_eq!(tmux_word("a b"), "\"a b\"");
        assert_eq!(tmux_word("say \"hi\" $HOME"), "\"say \\\"hi\\\" \\$HOME\"");
    }

    #[test]
    fn a_delta_is_structural_when_the_shape_moves_not_when_output_arrives() {
        let mut d = crate::TmuxDelta {
            seq: 1,
            panes: None,
            windows: None,
            new_panes: None,
            new_windows: None,
            active_window_id: None,
            active_pane_id: None,
            status_line: None,
            focus_request: None,
            total_width: None,
            total_height: None,
        };
        assert!(!is_structural(&d));
        let mut panes = std::collections::HashMap::new();
        panes.insert(
            "%1".to_string(),
            Some(crate::PaneDelta {
                content: Some(Default::default()),
                ..Default::default()
            }),
        );
        d.panes = Some(panes.clone());
        assert!(!is_structural(&d), "output alone is not a shape change");
        panes.insert("%2".to_string(), None);
        d.panes = Some(panes);
        assert!(is_structural(&d), "a pane going away is");
        d.panes = None;
        d.active_pane_id = Some("%1".into());
        assert!(is_structural(&d));
    }

    #[test]
    fn focus_is_restored_last() {
        let lines = joined(&plan(&fixture(), &RestoreOptions::default()));
        assert_eq!(lines.last().unwrap(), "run: select-window -t work:2");
        assert!(lines.contains(&"run: select-pane -t work:0.1".to_string()));
    }

    /// The executor threads each answer into the following step.
    #[test]
    fn apply_feeds_an_answer_into_the_next_step() {
        let mut seen = Vec::new();
        apply(&fixture(), &RestoreOptions::default(), |argv| {
            seen.push(argv.join(" "));
            Ok(if argv[0] == "split-window" {
                "%9\n".into()
            } else if argv[0] == "display-message" {
                "@7\n".into()
            } else {
                String::new()
            })
        })
        .unwrap();
        assert!(seen.contains(&"break-pane -d -s %9 -t work:2 -n notes".to_string()));
        assert!(seen.contains(&"set-option -w -t work:2 @tmuxy-float-parent @7".to_string()));
    }

    #[test]
    fn apply_stops_at_the_first_failure() {
        let result = apply(&fixture(), &RestoreOptions::default(), |argv| {
            if argv[0] == "new-session" {
                Err("no".into())
            } else {
                Ok(String::new())
            }
        });
        assert_eq!(result, Err("no".to_string()));
    }

    #[test]
    fn assemble_ties_panes_to_windows_and_parents_to_indices() {
        let windows = parse_windows(
            &[
                window_line("@1", 0, true, "", "", "l0", "main"),
                window_line("@3", 2, false, "float", "@1", "l2", "f"),
            ]
            .join("\n"),
        );
        let panes = parse_panes("%5,@1,0,1,1,/dev/ttys1,/a,,\n%6,@3,0,1,2,/dev/ttys2,/b,,g1\n%4,@1,1,0,3,/dev/ttys3,/c,,");
        let mut commands = BTreeMap::new();
        commands.insert("%5".to_string(), vec!["vim".to_string()]);
        let snap = assemble("work", 7, windows, panes, &commands);
        assert_eq!(snap.windows.len(), 2);
        assert_eq!(
            snap.windows[0]
                .panes
                .iter()
                .map(|p| p.index)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(
            snap.windows[0].panes[0].command,
            Some(vec!["vim".to_string()])
        );
        assert_eq!(snap.windows[1].float_parent_index, Some(0));
        assert_eq!(snap.windows[1].panes[0].options["@tmuxy-group-id"], "g1");
    }

    #[test]
    fn storage_writes_atomically_skips_identical_shapes_and_tolerates_a_bad_file() {
        let dir = std::env::temp_dir().join(format!("tmuxy-snap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let snap = fixture();
        let first = write(&dir, &snap).unwrap();
        assert!(first.is_some());
        assert!(!std::fs::read_dir(&dir).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_str()
            .unwrap()
            .ends_with(".tmp")));
        // Same shape, later clock: nothing written.
        let again = Snapshot {
            saved_at: snap.saved_at + 60,
            ..snap.clone()
        };
        assert_eq!(write(&dir, &again).unwrap(), None);
        assert_eq!(
            read_latest(&dir, "work").unwrap().unwrap().windows,
            snap.windows
        );
        assert_eq!(list(&dir), vec![("work".to_string(), snap.saved_at)]);
        // A truncated latest is an error the caller can read, not a panic.
        std::fs::write(dir.join("work.latest.json"), "{\"version\":1,\"sess").unwrap();
        assert!(matches!(
            read_latest(&dir, "work"),
            Err(SnapshotError::Unreadable(_))
        ));
        // A newer tmuxy's file is refused by version.
        std::fs::write(
            dir.join("work.latest.json"),
            format!(
                "{{\"version\":{},\"session\":\"work\",\"saved_at\":1,\"windows\":[]}}",
                SNAPSHOT_VERSION + 1
            ),
        )
        .unwrap();
        assert_eq!(
            read_latest(&dir, "work"),
            Err(SnapshotError::NewerVersion(SNAPSHOT_VERSION + 1))
        );
        assert_eq!(read_latest(&dir, "nobody").unwrap(), None);
        assert!(forget(&dir, "work") >= 2);
        assert_eq!(read_latest(&dir, "work").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pruning_keeps_five_however_old_and_everything_recent() {
        let dir = std::env::temp_dir().join(format!("tmuxy-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let now = 1_759_622_400u64;
        let old = now - KEEP_FOR_SECS - 10;
        for i in 0..8u64 {
            std::fs::write(dir.join(snapshot_file_name("s", old + i)), "{}").unwrap();
        }
        std::fs::write(dir.join(snapshot_file_name("s", now)), "{}").unwrap();
        prune(&dir, "s", now);
        let left = dated_files(&dir, "s");
        assert_eq!(left.len(), KEEP_AT_LEAST, "{left:?}");
        assert!(left.last().unwrap().to_str().unwrap().contains(&stamp(now)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
