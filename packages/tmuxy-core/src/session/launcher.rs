use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::paths::Layout;

/// The tmux global environment variables naming the binary that runs this
/// build's server verbs (`group`, `session`, …), and the subcommand it needs
/// first: none for `tmuxy-server`, `server` for the desktop app. The helper
/// scripts run under `run-shell`, which hands them tmux's global environment,
/// so this is how a script finds THIS build — the copies in [`super::bin_dir`]
/// sit nowhere near a build tree, and a socket's tmux server is the one place a
/// dev build and an installed one never share.
pub const SERVER_BIN_ENV: &str = "TMUXY_SERVER_BIN";
pub const SERVER_SUBCOMMAND_ENV: &str = "TMUXY_SERVER_SUBCOMMAND";

static SERVER_COMMAND: OnceLock<(PathBuf, Option<&'static str>)> = OnceLock::new();

/// `<prefix>/Cellar/<formula>/<version>/<rest>` → `<prefix>/opt/<formula>/<rest>`,
/// and `None` for any path that is not inside a Cellar or whose `opt` twin
/// does not exist.
pub fn cellar_to_opt(path: &str) -> Option<String> {
    let (prefix, tail) = path.split_once("/Cellar/")?;
    let mut parts = tail.splitn(3, '/');
    let formula = parts.next()?;
    parts.next()?; // version
    let rest = parts.next()?;

    let opt = format!("{prefix}/opt/{formula}/{rest}");
    Path::new(&opt).exists().then_some(opt)
}

/// The path that re-launches this binary after the current process exits.
///
/// Inside an AppImage, `current_exe()` is the binary inside the FUSE mount
/// (`/tmp/.mount_tmuxyXXXXXX/usr/bin/tmuxy`), which disappears as soon as
/// the process exits; `$APPIMAGE` is the file on disk. Under Homebrew,
/// `$APPIMAGE` (or `current_exe()`) resolves into the versioned `Cellar/`
/// directory, which disappears on the next `brew upgrade`; [`cellar_to_opt`]
/// rewrites it to the `opt/<formula>` symlink Homebrew repoints on upgrade.
pub fn invoked_exe() -> Option<PathBuf> {
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let current = std::env::current_exe().ok();
    resolve_invoked_exe(appimage.as_deref(), current.as_deref())
}

pub(super) fn resolve_invoked_exe(
    appimage: Option<&Path>,
    current_exe: Option<&Path>,
) -> Option<PathBuf> {
    let raw = appimage
        .filter(|p| !p.as_os_str().is_empty())
        .or(current_exe)?;
    Some(
        raw.to_str()
            .and_then(cellar_to_opt)
            .map(PathBuf::from)
            .unwrap_or_else(|| raw.to_path_buf()),
    )
}

/// Record how this process's own binary runs a server verb. Called once by
/// each entry point, before any monitor attaches.
pub fn set_server_command(exe: PathBuf, subcommand: Option<&'static str>) {
    let _ = SERVER_COMMAND.set((exe, subcommand));
}

/// The binary and subcommand [`set_server_command`] recorded: how a pane
/// tmuxy opens runs one of this build's server verbs (a plugin's
/// `tmuxy plugin exec`).
pub fn server_command() -> Option<(PathBuf, Option<&'static str>)> {
    SERVER_COMMAND.get().cloned()
}

/// The commands that publish [`SERVER_BIN_ENV`] and [`SERVER_SUBCOMMAND_ENV`]
/// to the tmux server, or nothing when no entry point recorded a binary.
pub fn server_command_env() -> Vec<String> {
    SERVER_COMMAND
        .get()
        .map(|(exe, subcommand)| server_command_env_for(exe, *subcommand))
        .unwrap_or_default()
}

pub(super) fn server_command_env_for(exe: &Path, subcommand: Option<&str>) -> Vec<String> {
    let quote = crate::tmux_quote;
    vec![
        format!(
            "set-environment -g {SERVER_BIN_ENV} {}",
            quote(&exe.to_string_lossy())
        ),
        match subcommand {
            Some(sub) => format!("set-environment -g {SERVER_SUBCOMMAND_ENV} {}", quote(sub)),
            None => format!("set-environment -g -u {SERVER_SUBCOMMAND_ENV}"),
        },
    ]
}

/// The first line after the shebang of every wrapper tmuxy writes: how a
/// file at `~/.local/bin/tmuxy` is known to be one.
const WRAPPER_MARK: &str = "# tmuxy — auto-generated shorthand for the desktop app.";

/// The line of the wrapper that names its launcher file.
const LAUNCHER_LINE: &str = "LAUNCHER_FILE=";

/// The `tmuxy` shell wrapper [`refresh_launcher`] writes, reading the
/// launcher path from `launcher_file` — the state dir's, baked in when the
/// wrapper is written, so the shell never re-derives the dir rules
/// (`paths::Layout` owns them) — and dispatching:
///   - no args → open the GUI through `open -a` on macOS (LaunchServices
///     bounces the dock icon and applies the right activation policy)
///   - any args → exec the binary directly so it runs in CLI mode
///
/// Earlier versions always routed through `open -a`, which on macOS
/// silently swallows args for known apps and never starts a CLI session,
/// so `tmuxy pane list` etc. just opened a duplicate GUI window instead
/// of dispatching into the noun-verb shell helper.
pub(super) fn launcher_wrapper(launcher_file: &Path) -> String {
    format!(
        "#!/bin/sh
{WRAPPER_MARK}
#
# Refreshed by the GUI on every launch (see refresh_launcher in
# tmuxy-core/src/session/launcher.rs). DO NOT EDIT — your changes will be
# replaced the next time you open the app.
set -eu
{LAUNCHER_LINE}{launcher}
if [ ! -f \"$LAUNCHER_FILE\" ]; then
  echo 'tmuxy: no launcher recorded yet — open the app once via Finder/GUI.' >&2
  exit 1
fi
EXEC_PATH=\"$(cat \"$LAUNCHER_FILE\")\"

# Exec the binary directly — main.rs routes terminal invocations to status info
# and explicit 'gui' / non-terminal invocations to the GUI window.
exec \"$EXEC_PATH\" \"$@\"
",
        launcher = shell_quote(&launcher_file.to_string_lossy())
    )
}

/// `value` as one POSIX shell word.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The launcher file a wrapper reads: the one baked into it, or — for one
/// an older build wrote, which derived the state dir in the shell — the
/// default state dir's. `None` for a file that is no wrapper of tmuxy's.
fn wrapper_launcher(wrapper: &str) -> Option<PathBuf> {
    let line = wrapper
        .lines()
        .find(|line| line.starts_with(LAUNCHER_LINE))?;
    let value = &line[LAUNCHER_LINE.len()..];
    match value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
        Some(quoted) => Some(PathBuf::from(quoted.replace("'\\''", "'"))),
        None => Some(crate::paths::default_state_dir().join(crate::paths::LAUNCHER.name)),
    }
}

/// Async-friendly: refresh the `tmuxy` shell shorthand to point at the
/// currently-running executable. Writes two files:
///
///   1. `launcher` in the state dir — a single line: the absolute path to
///      the .app/binary that launched us. Refreshed every GUI launch so
///      the shorthand always points at the most-recently-opened build
///      (handy when juggling Releases.app vs. a debug build). This machine's
///      own fact, so never in the config dir a dotfiles repo may hold.
///
///   2. `~/.local/bin/tmuxy` — the wrapper script ([`launcher_wrapper`]).
///      Only rewritten when its content drifts, so we don't churn the inode
///      on every launch, and never over a symlink that resolves (the user's
///      own). The wrapper is `chmod +x`'d.
///
/// Errors are logged and otherwise swallowed; this is a best-effort install
/// convenience, not a hard prerequisite for app use.
pub fn refresh_launcher(exe_path: &Path) {
    refresh_launcher_in(&Layout::current(), exe_path);
}

/// Heal `~/.local/bin/tmuxy` and the state dir's `launcher` when the wrapper
/// is already installed, reads this process's launcher file, and either its
/// script has drifted from [`launcher_wrapper`] or the target recorded in
/// `launcher` no longer exists
/// on disk (such as an unmounted `/tmp/.mount_tmuxy*` path or an upgraded
/// `Cellar/<old-version>` path). Leaves a healthy `launcher` untouched so
/// running a `target/debug/tmuxy` test binary never clobbers the user's
/// installed launcher, and never creates `~/.local/bin/tmuxy` on a headless
/// host that never had one.
pub fn refresh_launcher_if_installed(exe_path: &Path) {
    refresh_launcher_if_installed_in(&Layout::current(), exe_path);
}

pub(super) fn refresh_launcher_if_installed_in(layout: &Layout, exe_path: &Path) {
    let wrapper_path = layout.home.join(".local/bin/tmuxy");
    let Ok(meta) = std::fs::symlink_metadata(&wrapper_path) else {
        return;
    };
    let launcher_file = layout.path(&crate::paths::LAUNCHER);
    // A valid symlink put there by hand (e.g. pointing to a checkout's
    // `bin/tmuxy-cli`) is the user's; only a dangling symlink is healed, and
    // only by a tmuxy that keeps its state where the user's own does.
    if meta.file_type().is_symlink() {
        let dangling = std::fs::metadata(&wrapper_path).is_err();
        if dangling && layout.state == crate::paths::default_state_dir() {
            refresh_launcher_in(layout, exe_path);
        }
        return;
    }
    let Ok(wrapper) = std::fs::read_to_string(&wrapper_path) else {
        return;
    };
    // Only the wrapper that reads THIS process's launcher is its to heal: a
    // test's server, or a build run with another state dir, must never point
    // the user's shorthand at its own.
    if wrapper_launcher(&wrapper).as_deref() != Some(launcher_file.as_path()) {
        return;
    }
    let wrapper_stale = wrapper != launcher_wrapper(&launcher_file);
    let target_missing = match std::fs::read_to_string(&launcher_file) {
        Ok(recorded) => {
            let trimmed = recorded.trim();
            trimmed.is_empty() || !Path::new(trimmed).exists()
        }
        Err(_) => true,
    };
    if wrapper_stale || target_missing {
        refresh_launcher_in(layout, exe_path);
    }
}

pub(super) fn refresh_launcher_in(layout: &Layout, exe_path: &Path) {
    let dir = &layout.state;
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!(dir = %dir.display(), error = %e, "refresh_launcher: mkdir failed");
        return;
    }

    let launcher_file = layout.path(&crate::paths::LAUNCHER);
    let exe_str = exe_path.to_string_lossy();
    let content = format!("{exe_str}\n");
    if std::fs::read_to_string(&launcher_file).ok().as_deref() != Some(content.as_str()) {
        if let Err(e) = std::fs::write(&launcher_file, content) {
            tracing::warn!(path = %launcher_file.display(), error = %e, "refresh_launcher: write failed");
            return;
        }
    }

    let bin_dir = layout.home.join(".local/bin");
    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        tracing::warn!(dir = %bin_dir.display(), error = %e, "refresh_launcher: mkdir failed");
        return;
    }

    let wrapper_path = bin_dir.join("tmuxy");

    // Probed with symlink_metadata, to see the link rather than its target.
    let is_symlink = std::fs::symlink_metadata(&wrapper_path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    // A symlink that resolves is the user's (a checkout's `bin/tmuxy-cli`,
    // as AGENTS.md sets one up): kept. A dangling one is unlinked first —
    // writing through it would fail on the missing target's directory.
    if is_symlink {
        if std::fs::metadata(&wrapper_path).is_ok() {
            return;
        }
        if let Err(e) = std::fs::remove_file(&wrapper_path) {
            tracing::warn!(path = %wrapper_path.display(), error = %e, "refresh_launcher: stale symlink not removed");
            return;
        }
    }

    let wrapper = launcher_wrapper(&launcher_file);
    let needs_write =
        std::fs::read_to_string(&wrapper_path).ok().as_deref() != Some(wrapper.as_str());
    if needs_write {
        if let Err(e) = std::fs::write(&wrapper_path, wrapper) {
            tracing::warn!(path = %wrapper_path.display(), error = %e, "refresh_launcher: wrapper write failed");
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&wrapper_path, std::fs::Permissions::from_mode(0o755));
        }
        tracing::info!(path = %wrapper_path.display(), "refresh_launcher: installed shorthand");
    }
}
