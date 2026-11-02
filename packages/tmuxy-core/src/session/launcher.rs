use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::config::Layout;

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

/// The commands that publish [`SERVER_BIN_ENV`] and [`SERVER_SUBCOMMAND_ENV`]
/// to the tmux server, or nothing when no entry point recorded a binary.
pub fn server_command_env() -> Vec<String> {
    SERVER_COMMAND
        .get()
        .map(|(exe, subcommand)| server_command_env_for(exe, *subcommand))
        .unwrap_or_default()
}

pub(super) fn server_command_env_for(exe: &Path, subcommand: Option<&str>) -> Vec<String> {
    let quote = crate::executor::tmux_quote;
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

/// Static `tmuxy` shell wrapper that reads the launcher path written by
/// [`refresh_launcher`] and dispatches:
///   - no args → open the GUI through `open -a` on macOS (LaunchServices
///     bounces the dock icon and applies the right activation policy)
///   - any args → exec the binary directly so it runs in CLI mode
///
/// Earlier versions always routed through `open -a`, which on macOS
/// silently swallows args for known apps and never starts a CLI session,
/// so `tmuxy pane list` etc. just opened a duplicate GUI window instead
/// of dispatching into the noun-verb shell helper.
const LAUNCHER_WRAPPER: &str = "#!/bin/sh
# tmuxy — auto-generated shorthand for the desktop app.
#
# Refreshed by the GUI on every launch (see refresh_launcher in
# tmuxy-core/src/session.rs). DO NOT EDIT — your changes will be replaced
# the next time you open the app.
set -eu
# The launcher lives in tmuxy's state dir, resolved as tmuxy-core's state_dir().
if [ -n \"${TMUXY_STATE_DIR:-}\" ]; then
  STATE_DIR=\"$TMUXY_STATE_DIR\"
elif [ \"$(uname -s)\" = Darwin ]; then
  STATE_DIR=\"$HOME/Library/Application Support/tmuxy\"
else
  case \"${XDG_STATE_HOME:-}\" in
    /*) STATE_DIR=\"$XDG_STATE_HOME/tmuxy\" ;;
    *) STATE_DIR=\"$HOME/.local/state/tmuxy\" ;;
  esac
fi
LAUNCHER_FILE=\"$STATE_DIR/launcher\"
if [ ! -f \"$LAUNCHER_FILE\" ]; then
  echo 'tmuxy: no launcher recorded yet — open the app once via Finder/GUI.' >&2
  exit 1
fi
EXEC_PATH=\"$(cat \"$LAUNCHER_FILE\")\"

# Exec the binary directly — main.rs routes terminal invocations to status info
# and explicit 'gui' / non-terminal invocations to the GUI window.
exec \"$EXEC_PATH\" \"$@\"
";

/// Async-friendly: refresh the `tmuxy` shell shorthand to point at the
/// currently-running executable. Writes two files:
///
///   1. `launcher` in the state dir — a single line: the absolute path to
///      the .app/binary that launched us. Refreshed every GUI launch so
///      the shorthand always points at the most-recently-opened build
///      (handy when juggling Releases.app vs. a debug build). This machine's
///      own fact, so never in the config dir a dotfiles repo may hold.
///
///   2. `~/.local/bin/tmuxy` — the wrapper script. Only rewritten when
///      its content drifts from [`LAUNCHER_WRAPPER`], so we don't churn
///      the inode on every launch. The wrapper is `chmod +x`'d.
///
/// Errors are logged and otherwise swallowed; this is a best-effort install
/// convenience, not a hard prerequisite for app use.
pub fn refresh_launcher(exe_path: &Path) {
    refresh_launcher_in(&Layout::current(), exe_path);
}

/// Heal `~/.local/bin/tmuxy` and the state dir's `launcher` when the wrapper
/// is already installed and either its script has drifted from
/// [`LAUNCHER_WRAPPER`] or the target recorded in `launcher` no longer exists
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
    // A valid symlink put there by hand (e.g. pointing to a checkout's
    // `bin/tmuxy-cli`) is the user's; only a dangling symlink or our wrapper
    // file is healed.
    if meta.file_type().is_symlink() {
        if std::fs::metadata(&wrapper_path).is_err() {
            refresh_launcher_in(layout, exe_path);
        }
        return;
    }
    let wrapper_stale =
        std::fs::read_to_string(&wrapper_path).ok().as_deref() != Some(LAUNCHER_WRAPPER);
    let launcher_file = layout.state.join("launcher");
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

    let launcher_file = dir.join("launcher");
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

    // Probe via symlink_metadata so we see the *link*, not what it points to.
    // Earlier dev-tree installs sometimes left `~/.local/bin/tmuxy` as a
    // symlink to a now-renamed path (e.g. `…/projects/tmuxy/scripts/tmuxy-cli`).
    // `read_to_string` would follow the dangling symlink, fail, and we'd then
    // try to `write` *through* it — also failing because the target's parent
    // directory no longer exists. Unlink stale symlinks first so we always
    // end up with a fresh regular-file wrapper.
    let symlink_meta = std::fs::symlink_metadata(&wrapper_path).ok();
    let is_symlink = symlink_meta
        .as_ref()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);

    let needs_write = if is_symlink {
        let _ = std::fs::remove_file(&wrapper_path);
        true
    } else {
        match std::fs::read_to_string(&wrapper_path) {
            Ok(existing) => existing != LAUNCHER_WRAPPER,
            Err(_) => true,
        }
    };

    if needs_write {
        if let Err(e) = std::fs::write(&wrapper_path, LAUNCHER_WRAPPER) {
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
