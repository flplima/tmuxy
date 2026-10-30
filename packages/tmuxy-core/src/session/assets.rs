use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing::warn;

use super::{config_dir, write_app_owned_conf};

/// Bundled theme CSS files, embedded at compile time. Mirrored to
/// ~/.config/tmuxy/themes/ on every launch by [`ensure_themes`] — app-owned
/// there, like the defaults conf — and served from that directory first by
/// [`resolve_user_css`], which is also where a user's own theme lives.
pub(super) const BUNDLED_THEMES: &[(&str, &str)] = &[
    (
        "default.css",
        include_str!("../../../tmuxy-ui/public/themes/default.css"),
    ),
    (
        "dracula.css",
        include_str!("../../../tmuxy-ui/public/themes/dracula.css"),
    ),
    (
        "fallout.css",
        include_str!("../../../tmuxy-ui/public/themes/fallout.css"),
    ),
    (
        "gruvbox.css",
        include_str!("../../../tmuxy-ui/public/themes/gruvbox.css"),
    ),
    (
        "nord.css",
        include_str!("../../../tmuxy-ui/public/themes/nord.css"),
    ),
    (
        "solarized.css",
        include_str!("../../../tmuxy-ui/public/themes/solarized.css"),
    ),
    (
        "tokyonight.css",
        include_str!("../../../tmuxy-ui/public/themes/tokyonight.css"),
    ),
];

/// Bundled CLI dispatcher and helper scripts, embedded at compile time and
/// mirrored to `~/.config/tmuxy/bin/` on launch by [`ensure_bin_scripts`].
///
/// These power the noun-verb CLI (`tmuxy pane list`) and the in-config
/// `command-alias` entries that drive Ctrl+hjkl pane navigation, pane
/// groups, etc. The .app bundle's working directory at launch is `/`,
/// so the historical `bin/tmuxy/nav` relative paths in `.tmuxy.conf`
/// would resolve to `/bin/tmuxy/nav` and silently fail. Materializing
/// to a stable absolute path under `$HOME/.config/tmuxy/bin/` and
/// referencing them by `$HOME/...` in the config fixes both issues.
pub(super) const BUNDLED_BIN_SCRIPTS: &[(&str, &str)] = &[
    (
        "tmuxy-cli",
        include_str!("../../../tmuxy-cli/bin/tmuxy-cli"),
    ),
    (
        "tmuxy/_lib",
        include_str!("../../../tmuxy-cli/bin/tmuxy/_lib"),
    ),
    (
        "tmuxy/_contract",
        include_str!("../../../tmuxy-cli/bin/tmuxy/_contract"),
    ),
    (
        "tmuxy/cli-commands.sh",
        include_str!("../../../tmuxy-cli/bin/tmuxy/cli-commands.sh"),
    ),
    (
        "tmuxy/cli-info.sh",
        include_str!("../../../tmuxy-cli/bin/tmuxy/cli-info.sh"),
    ),
    (
        "tmuxy/cli-pane.sh",
        include_str!("../../../tmuxy-cli/bin/tmuxy/cli-pane.sh"),
    ),
    (
        "tmuxy/cli-pane-run.sh",
        include_str!("../../../tmuxy-cli/bin/tmuxy/cli-pane-run.sh"),
    ),
    (
        "tmuxy/capture-html",
        include_str!("../../../tmuxy-cli/bin/tmuxy/capture-html"),
    ),
    (
        "tmuxy/send",
        include_str!("../../../tmuxy-cli/bin/tmuxy/send"),
    ),
    (
        "tmuxy/agent-hook",
        include_str!("../../../tmuxy-cli/bin/tmuxy/agent-hook"),
    ),
    (
        "tmuxy/float-create",
        include_str!("../../../tmuxy-cli/bin/tmuxy/float-create"),
    ),
    (
        "tmuxy/nav",
        include_str!("../../../tmuxy-cli/bin/tmuxy/nav"),
    ),
    (
        "tmuxy/reap-orphan-shells",
        include_str!("../../../tmuxy-cli/bin/tmuxy/reap-orphan-shells"),
    ),
    (
        "tmuxy/pane-group",
        include_str!("../../../tmuxy-cli/bin/tmuxy/pane-group"),
    ),
    (
        "tmuxy/pane-group-tab",
        include_str!("../../../tmuxy-cli/bin/tmuxy/pane-group-tab"),
    ),
    (
        "tmuxy/paste-synced",
        include_str!("../../../tmuxy-cli/bin/tmuxy/paste-synced"),
    ),
    (
        "tmuxy/stack",
        include_str!("../../../tmuxy-cli/bin/tmuxy/stack"),
    ),
    (
        "tmuxy/session-connect",
        include_str!("../../../tmuxy-cli/bin/tmuxy/session-connect"),
    ),
    (
        "tmuxy/session-switch",
        include_str!("../../../tmuxy-cli/bin/tmuxy/session-switch"),
    ),
    (
        "tmuxy/session-names.json",
        include_str!("../../../tmuxy-cli/bin/tmuxy/session-names.json"),
    ),
    (
        "tmuxy/tmuxy-widget",
        include_str!("../../../tmuxy-cli/bin/tmuxy/tmuxy-widget"),
    ),
    (
        "tmuxy/tmuxy-widget-preview",
        include_str!("../../../tmuxy-cli/bin/tmuxy/tmuxy-widget-preview"),
    ),
    (
        "tmuxy/tmuxy-widget-browser",
        include_str!("../../../tmuxy-cli/bin/tmuxy/tmuxy-widget-browser"),
    ),
    (
        "tmuxy/browser.js",
        include_str!("../../../tmuxy-cli/bin/tmuxy/browser.js"),
    ),
    (
        "tmuxy/browser-lib.js",
        include_str!("../../../tmuxy-cli/bin/tmuxy/browser-lib.js"),
    ),
    (
        "tmuxy/tmuxy-widget-tree",
        include_str!("../../../tmuxy-cli/bin/tmuxy/tmuxy-widget-tree"),
    ),
];

/// The first line of every built-in theme file in the config dir: the file is
/// the app's, refreshed on every launch like `tmuxy.defaults.conf`, so an edit
/// to it is lost on the next start. A custom theme is a copy under a new name.
pub(super) const BUILT_IN_THEME_HEADER: &str =
    "/* Shipped by tmuxy and rewritten on every launch — copy this file to a new name to customize it. */\n";

/// Ensure the themes directory exists at ~/.config/tmuxy/themes/ and holds
/// the bundled theme CSS files, each rewritten to this build's copy. Returns
/// the path to the themes directory.
pub fn ensure_themes() -> PathBuf {
    let themes_dir = config_dir().join("themes");
    ensure_themes_in(&themes_dir);
    themes_dir
}

/// [`ensure_themes`] for a given directory. A built-in file this build no
/// longer ships — one that still opens with [`BUILT_IN_THEME_HEADER`] — is
/// removed, or the theme list (read from this directory) would offer a theme
/// the app dropped. Any other `*.css` there is the user's and is left alone.
pub(super) fn ensure_themes_in(themes_dir: &Path) {
    if let Err(e) = std::fs::create_dir_all(themes_dir) {
        warn!(dir = ?themes_dir, error = %e, "could not create themes dir");
        return;
    }

    for (name, content) in BUNDLED_THEMES {
        write_app_owned_conf(
            &themes_dir.join(name),
            &format!("{BUILT_IN_THEME_HEADER}{content}"),
        );
    }

    let Ok(entries) = std::fs::read_dir(themes_dir) else {
        return;
    };
    for path in entries.filter_map(|e| e.ok()).map(|e| e.path()) {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".css") || BUNDLED_THEMES.iter().any(|(n, _)| *n == name) {
            continue;
        }
        let built_in =
            std::fs::read_to_string(&path).is_ok_and(|css| css.starts_with(BUILT_IN_THEME_HEADER));
        if built_in {
            if let Err(e) = std::fs::remove_file(&path) {
                warn!(?path, error = %e, "could not remove a retired built-in theme");
            }
        }
    }
}

/// Whether `name` can be a theme's file stem or a `--css-variable` suffix:
/// letters, digits, `-` and `_` only, so it can neither leave the themes
/// directory nor end a CSS declaration.
pub fn is_safe_css_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// The stylesheet a client asked for by its path under the app's origin —
/// `themes/<name>.css` or `custom.css` — as both transports serve it: the
/// user's file in the config dir first, else the bundled copy of a built-in
/// theme. A missing `custom.css` is an empty sheet, so the page never has a
/// failed request for the file most users never write. `None` is a path
/// that is not one of these.
pub fn resolve_user_css(path: &str) -> Option<Vec<u8>> {
    resolve_user_css_in(&config_dir(), path)
}

pub(super) fn resolve_user_css_in(dir: &Path, path: &str) -> Option<Vec<u8>> {
    let path = path.trim_start_matches('/');
    if path == "custom.css" {
        return Some(std::fs::read(dir.join("custom.css")).unwrap_or_default());
    }
    let stem = path
        .strip_prefix("themes/")
        .and_then(|file| file.strip_suffix(".css"))
        .filter(|stem| is_safe_css_name(stem))?;
    let file = format!("{stem}.css");
    if let Ok(bytes) = std::fs::read(dir.join("themes").join(&file)) {
        return Some(bytes);
    }
    BUNDLED_THEMES
        .iter()
        .find(|(name, _)| *name == file)
        .map(|(_, content)| content.as_bytes().to_vec())
}

/// The colour modes a theme supports: `dark` when its `:root.theme-dark`
/// block declares something, `light` likewise. Every bundled theme carries a
/// `theme-light` selector, but one with an empty block has no light palette,
/// and switching to it would draw the page in the browser's defaults.
pub fn theme_modes(css: &str) -> Vec<&'static str> {
    ["dark", "light"]
        .into_iter()
        .filter(|mode| {
            css.match_indices(&format!(".theme-{mode}")).any(|(at, _)| {
                let rest = &css[at..];
                let Some(open) = rest.find('{') else {
                    return false;
                };
                let body = &rest[open + 1..];
                let close = body.find('}').unwrap_or(body.len());
                body[..close].contains("--")
            })
        })
        .collect()
}

/// The tmux global environment variables naming the binary that runs this
/// build's server verbs (`group`, `session`, …), and the subcommand it needs
/// first: none for `tmuxy-server`, `server` for the desktop app. The helper
/// scripts run under `run-shell`, which hands them tmux's global environment,
/// so this is how a script finds THIS build — the copies in [`bin_dir`] sit
/// nowhere near a build tree, and a socket's tmux server is the one place a
/// dev build and an installed one never share.
pub const SERVER_BIN_ENV: &str = "TMUXY_SERVER_BIN";
pub const SERVER_SUBCOMMAND_ENV: &str = "TMUXY_SERVER_SUBCOMMAND";

static SERVER_COMMAND: OnceLock<(PathBuf, Option<&'static str>)> = OnceLock::new();

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

/// User bin directory: `~/.config/tmuxy/bin/`. Where we materialize the
/// embedded CLI dispatcher (`tmuxy-cli`) and helper scripts so the
/// in-config `run-shell "$HOME/.config/tmuxy/bin/tmuxy/nav …"` calls and
/// the `tmuxy <subcommand>` shell wrapper can reach them at known paths,
/// independent of the .app bundle's working directory.
pub fn bin_dir() -> PathBuf {
    config_dir().join("bin")
}

/// Mirror the bundled CLI dispatcher and helper scripts to
/// `~/.config/tmuxy/bin/`. Always overwrites — these are not user-editable;
/// upgrades must ship their own helpers without leaving stale copies behind.
/// Returns the bin directory path.
pub fn ensure_bin_scripts() -> PathBuf {
    let bin = bin_dir();

    if let Err(e) = std::fs::create_dir_all(&bin) {
        warn!(dir = ?bin, error = %e, "could not create bin dir");
        return bin;
    }
    if let Err(e) = std::fs::create_dir_all(bin.join("tmuxy")) {
        warn!(dir = ?bin, error = %e, "could not create bin/tmuxy dir");
        return bin;
    }

    for (rel_path, content) in BUNDLED_BIN_SCRIPTS {
        let path = bin.join(rel_path);
        if let Err(e) = std::fs::write(&path, content) {
            warn!(?path, error = %e, "could not write bundled script");
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
    }

    bin
}

/// List user-available theme names (file stems of *.css under
/// ~/.config/tmuxy/themes/). Falls back to the bundled list if the
/// directory can't be read. Sorted alphabetically with `default` first.
pub fn list_themes() -> Vec<String> {
    let themes_dir = config_dir().join("themes");

    let mut names: Vec<String> = match std::fs::read_dir(&themes_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let path = e.path();
                if path.extension().and_then(|s| s.to_str()) != Some("css") {
                    return None;
                }
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
            .collect(),
        Err(_) => BUNDLED_THEMES
            .iter()
            .filter_map(|(name, _)| name.strip_suffix(".css").map(|s| s.to_string()))
            .collect(),
    };

    names.sort_by(|a, b| match (a.as_str(), b.as_str()) {
        ("default", _) => std::cmp::Ordering::Less,
        (_, "default") => std::cmp::Ordering::Greater,
        _ => a.cmp(b),
    });
    names
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
LAUNCHER_FILE=\"${XDG_CONFIG_HOME:-$HOME/.config}/tmuxy/launcher\"
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
///   1. `~/.config/tmuxy/launcher` — a single line: the absolute path to
///      the .app/binary that launched us. Refreshed every GUI launch so
///      the shorthand always points at the most-recently-opened build
///      (handy when juggling Releases.app vs. a debug build).
///
///   2. `~/.local/bin/tmuxy` — the wrapper script. Only rewritten when
///      its content drifts from [`LAUNCHER_WRAPPER`], so we don't churn
///      the inode on every launch. The wrapper is `chmod +x`'d.
///
/// Errors are logged and otherwise swallowed; this is a best-effort install
/// convenience, not a hard prerequisite for app use.
pub fn refresh_launcher(exe_path: &std::path::Path) {
    let dir = config_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!(dir = %dir.display(), error = %e, "refresh_launcher: mkdir failed");
        return;
    }

    let launcher_file = dir.join("launcher");
    let exe_str = exe_path.to_string_lossy();
    if let Err(e) = std::fs::write(&launcher_file, format!("{}\n", exe_str)) {
        tracing::warn!(path = %launcher_file.display(), error = %e, "refresh_launcher: write failed");
        return;
    }

    let bin_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".local/bin");
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
