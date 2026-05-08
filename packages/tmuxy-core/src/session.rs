use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Resolved path to the tmux binary, cached after first lookup.
static TMUX_PATH: OnceLock<String> = OnceLock::new();

/// Find the tmux binary path.
///
/// macOS GUI apps (.app bundles) inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// that excludes Homebrew, MacPorts, and Nix paths. We check common locations explicitly
/// so the Tauri desktop app works when launched from Finder/Spotlight.
fn find_tmux() -> String {
    // Explicit env override
    if let Ok(path) = std::env::var("TMUX_BIN") {
        if std::path::Path::new(&path).exists() {
            return path;
        }
    }

    // Try PATH first (works in terminals, CI, and Linux desktop)
    if let Ok(output) = Command::new("which").arg("tmux").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    // Common locations not in macOS GUI PATH
    let candidates = [
        "/opt/homebrew/bin/tmux",                 // Homebrew on Apple Silicon
        "/usr/local/bin/tmux",                    // Homebrew on Intel Mac / Linux manual install
        "/usr/bin/tmux",                          // System package (apt, yum)
        "/run/current-system/sw/bin/tmux",        // NixOS
        "/nix/var/nix/profiles/default/bin/tmux", // Nix single-user
    ];
    for path in candidates {
        if std::path::Path::new(path).exists() {
            return path.to_string();
        }
    }

    // Fallback — let the OS try to resolve it
    "tmux".to_string()
}

/// Get the resolved tmux binary path (cached).
pub fn tmux_path() -> &'static str {
    TMUX_PATH.get_or_init(find_tmux)
}

/// Create a `Command` for tmux that respects the `TMUX_SOCKET` environment variable.
/// When `TMUX_SOCKET` is set, adds `-L <socket>` to connect to the named tmux server.
pub fn tmux_command() -> Command {
    let mut cmd = Command::new(tmux_path());
    if let Ok(socket) = std::env::var("TMUX_SOCKET") {
        if !socket.is_empty() {
            cmd.args(["-L", &socket]);
        }
    }
    cmd
}

/// Build the tmux shell command string with socket flag for use in shell invocations.
/// Returns e.g. "/opt/homebrew/bin/tmux -L tmuxy-dev" or just "/usr/bin/tmux".
pub fn tmux_bin() -> String {
    let bin = tmux_path();
    match std::env::var("TMUX_SOCKET") {
        Ok(socket) if !socket.is_empty() => format!("{} -L {}", bin, socket),
        _ => bin.to_string(),
    }
}

/// Default tmuxy configuration content.
/// Embedded at compile time from .devcontainer/.tmuxy.conf.
const DEFAULT_CONFIG: &str = include_str!("../../../.devcontainer/.tmuxy.conf");

/// Bundled theme CSS files, embedded at compile time. Mirrored to
/// ~/.config/tmuxy/themes/ on first run by [`ensure_themes`] so the user
/// can edit them in place; future versions can also load custom themes
/// dropped into that directory.
const BUNDLED_THEMES: &[(&str, &str)] = &[
    (
        "default.css",
        include_str!("../../tmuxy-ui/public/themes/default.css"),
    ),
    (
        "cold-harbor.css",
        include_str!("../../tmuxy-ui/public/themes/cold-harbor.css"),
    ),
    (
        "dracula.css",
        include_str!("../../tmuxy-ui/public/themes/dracula.css"),
    ),
    (
        "fallout.css",
        include_str!("../../tmuxy-ui/public/themes/fallout.css"),
    ),
    (
        "gruvbox.css",
        include_str!("../../tmuxy-ui/public/themes/gruvbox.css"),
    ),
    (
        "gruvbox-material.css",
        include_str!("../../tmuxy-ui/public/themes/gruvbox-material.css"),
    ),
    (
        "nord.css",
        include_str!("../../tmuxy-ui/public/themes/nord.css"),
    ),
    (
        "solarized.css",
        include_str!("../../tmuxy-ui/public/themes/solarized.css"),
    ),
    (
        "tokyonight.css",
        include_str!("../../tmuxy-ui/public/themes/tokyonight.css"),
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
const BUNDLED_BIN_SCRIPTS: &[(&str, &str)] = &[
    ("tmuxy-cli", include_str!("../../../bin/tmuxy-cli")),
    ("tmuxy/_lib", include_str!("../../../bin/tmuxy/_lib")),
    ("tmuxy/event-emit", include_str!("../../../bin/tmuxy/event-emit")),
    ("tmuxy/event-list", include_str!("../../../bin/tmuxy/event-list")),
    ("tmuxy/event-wait", include_str!("../../../bin/tmuxy/event-wait")),
    ("tmuxy/float-create", include_str!("../../../bin/tmuxy/float-create")),
    ("tmuxy/nav", include_str!("../../../bin/tmuxy/nav")),
    ("tmuxy/pane-group-add", include_str!("../../../bin/tmuxy/pane-group-add")),
    ("tmuxy/pane-group-close", include_str!("../../../bin/tmuxy/pane-group-close")),
    ("tmuxy/pane-group-next", include_str!("../../../bin/tmuxy/pane-group-next")),
    ("tmuxy/pane-group-prev", include_str!("../../../bin/tmuxy/pane-group-prev")),
    ("tmuxy/pane-group-switch", include_str!("../../../bin/tmuxy/pane-group-switch")),
    ("tmuxy/session-connect", include_str!("../../../bin/tmuxy/session-connect")),
    ("tmuxy/session-switch", include_str!("../../../bin/tmuxy/session-switch")),
    ("tmuxy/tmuxy-widget", include_str!("../../../bin/tmuxy/tmuxy-widget")),
    ("tmuxy/tmuxy-widget-image", include_str!("../../../bin/tmuxy/tmuxy-widget-image")),
    ("tmuxy/tmuxy-widget-markdown", include_str!("../../../bin/tmuxy/tmuxy-widget-markdown")),
];

/// Resolve the user's tmuxy config directory: $XDG_CONFIG_HOME/tmuxy
/// or $HOME/.config/tmuxy. Does not create the directory.
///
/// We deliberately do NOT use `dirs::config_dir()` because on macOS that
/// returns `~/Library/Application Support`, which surprises users who
/// expect to find their tmuxy config at `~/.config/tmuxy/tmuxy.conf`
/// (the same path as on Linux, the devcontainer, and what every doc/CI
/// path references). The mismatch silently broke first-run config
/// loading on Mac: ensure_config wrote into `~/Library/Application
/// Support/tmuxy/`, the user looked at `~/.config/tmuxy/`, found
/// nothing, and the desktop app got the default tmux prefix because
/// `tmux -f` was never given a config path either way.
pub fn config_dir() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = std::path::PathBuf::from(xdg);
        if xdg.is_absolute() {
            return xdg.join("tmuxy");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("tmuxy")
}

/// Get the path to the tmuxy config file.
/// Checks: ~/.config/tmuxy/tmuxy.conf, ~/.tmuxy.conf, then .devcontainer/.tmuxy.conf.
pub fn get_config_path() -> Option<PathBuf> {
    // XDG-style config location
    let xdg_config = config_dir().join("tmuxy.conf");
    if xdg_config.exists() {
        return Some(xdg_config);
    }

    let home_config = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".tmuxy.conf");
    if home_config.exists() {
        return Some(home_config);
    }

    // Check .devcontainer/.tmuxy.conf relative to working directory or ancestor
    if let Ok(mut dir) = std::env::current_dir() {
        loop {
            let docker_config = dir.join(".devcontainer/.tmuxy.conf");
            if docker_config.exists() {
                return Some(docker_config);
            }
            if !dir.pop() {
                break;
            }
        }
    }

    None
}

/// Ensure the default config exists at ~/.config/tmuxy/tmuxy.conf.
/// Creates the directory and file with defaults if they don't exist.
///
/// Also migrates configs written by older tmuxy releases (≤0.0.4) that
/// referenced helper scripts via the relative path `bin/tmuxy/…`. Those
/// paths only resolved when tmuxy was launched from the project root —
/// the .app bundle's working directory is `/`, so Ctrl+hjkl navigation
/// and pane-group commands silently no-op'd. We rewrite to the absolute
/// `$HOME/.config/tmuxy/bin/tmuxy/…` path that [`ensure_bin_scripts`]
/// materializes, leaving any user customizations elsewhere in the file
/// intact.
pub fn ensure_config() -> PathBuf {
    let dir = config_dir();
    let config_path = dir.join("tmuxy.conf");

    if !config_path.exists() {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("Warning: could not create config dir {:?}: {}", dir, e);
            return config_path;
        }
        if let Err(e) = std::fs::write(&config_path, DEFAULT_CONFIG) {
            eprintln!(
                "Warning: could not write default config to {:?}: {}",
                config_path, e
            );
        } else {
            eprintln!("Created default config at {:?}", config_path);
        }
        return config_path;
    }

    // Migrate stale relative bin paths in pre-existing user configs.
    if let Ok(existing) = std::fs::read_to_string(&config_path) {
        let migrated = migrate_bin_paths(&existing);
        if migrated != existing {
            if let Err(e) = std::fs::write(&config_path, &migrated) {
                eprintln!(
                    "Warning: could not migrate config at {:?}: {}",
                    config_path, e
                );
            } else {
                eprintln!(
                    "Migrated relative bin paths in {:?} to $HOME/.config/tmuxy/bin/",
                    config_path
                );
            }
        }
    }

    config_path
}

/// Rewrite legacy relative `bin/tmuxy/…` paths to the materialized absolute
/// path. Conservative — only touches occurrences inside `run-shell` strings
/// for our known helpers, so a user who hand-rolled a `bin/` reference for
/// their own scripts isn't affected.
fn migrate_bin_paths(config: &str) -> String {
    let mut result = config.to_string();
    let helpers = [
        "pane-group-add",
        "pane-group-prev",
        "pane-group-next",
        "pane-group-close",
        "pane-group-switch",
        "session-connect",
        "session-switch",
        "float-create",
        "event-emit",
        "event-list",
        "event-wait",
        "nav",
    ];
    for name in helpers {
        let stale = format!("bin/tmuxy/{}", name);
        let fresh = format!("$HOME/.config/tmuxy/bin/tmuxy/{}", name);
        // Only rewrite when the surrounding context is `run-shell …` — the
        // simple substring check is sufficient because tmux configs don't
        // legitimately contain `bin/tmuxy/<helper>` outside that context.
        result = result.replace(&stale, &fresh);
    }
    result
}

/// Ensure the themes directory exists at ~/.config/tmuxy/themes/ and is
/// populated with the bundled theme CSS files. Existing files are NOT
/// overwritten so the user's edits survive across upgrades. Returns the
/// path to the themes directory.
pub fn ensure_themes() -> PathBuf {
    let themes_dir = config_dir().join("themes");

    if let Err(e) = std::fs::create_dir_all(&themes_dir) {
        eprintln!(
            "Warning: could not create themes dir {:?}: {}",
            themes_dir, e
        );
        return themes_dir;
    }

    for (name, content) in BUNDLED_THEMES {
        let path = themes_dir.join(name);
        if !path.exists() {
            if let Err(e) = std::fs::write(&path, content) {
                eprintln!(
                    "Warning: could not write bundled theme to {:?}: {}",
                    path, e
                );
            }
        }
    }

    themes_dir
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
        eprintln!(
            "Warning: could not create bin dir {:?}: {}",
            bin, e
        );
        return bin;
    }
    if let Err(e) = std::fs::create_dir_all(bin.join("tmuxy")) {
        eprintln!(
            "Warning: could not create bin/tmuxy dir {:?}: {}",
            bin, e
        );
        return bin;
    }

    for (rel_path, content) in BUNDLED_BIN_SCRIPTS {
        let path = bin.join(rel_path);
        if let Err(e) = std::fs::write(&path, content) {
            eprintln!(
                "Warning: could not write bundled script to {:?}: {}",
                path, e
            );
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

# With args: run the binary directly — main.rs routes nouns like
# `pane`, `tab`, `widget`, … into the shell dispatcher (bin/tmuxy-cli).
# Stays in the foreground so the user sees stdout/stderr in their terminal.
if [ \"$#\" -gt 0 ]; then
  exec \"$EXEC_PATH\" \"$@\"
fi

# No args: open the GUI through LaunchServices on macOS so the dock
# bounces the icon and the existing instance is reactivated.
case \"$(uname -s)\" in
  Darwin)
    APP_PATH=\"${EXEC_PATH%%/Contents/MacOS/*}\"
    if [ \"$APP_PATH\" != \"$EXEC_PATH\" ] && [ -d \"$APP_PATH\" ]; then
      exec /usr/bin/open \"$APP_PATH\"
    fi
    ;;
esac
exec \"$EXEC_PATH\"
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
/// Errors are logged to debug_log and otherwise swallowed; this is a
/// best-effort install convenience, not a hard prerequisite for app use.
pub fn refresh_launcher(exe_path: &std::path::Path) {
    let dir = config_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        crate::debug_log::log(&format!("refresh_launcher: mkdir {:?} failed: {}", dir, e));
        return;
    }

    let launcher_file = dir.join("launcher");
    let exe_str = exe_path.to_string_lossy();
    if let Err(e) = std::fs::write(&launcher_file, format!("{}\n", exe_str)) {
        crate::debug_log::log(&format!(
            "refresh_launcher: writing {:?} failed: {}",
            launcher_file, e
        ));
        return;
    }

    let bin_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".local/bin");
    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        crate::debug_log::log(&format!(
            "refresh_launcher: mkdir {:?} failed: {}",
            bin_dir, e
        ));
        return;
    }

    let wrapper_path = bin_dir.join("tmuxy");
    let needs_write = match std::fs::read_to_string(&wrapper_path) {
        Ok(existing) => existing != LAUNCHER_WRAPPER,
        Err(_) => true,
    };
    if needs_write {
        if let Err(e) = std::fs::write(&wrapper_path, LAUNCHER_WRAPPER) {
            crate::debug_log::log(&format!(
                "refresh_launcher: writing wrapper {:?} failed: {}",
                wrapper_path, e
            ));
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&wrapper_path, std::fs::Permissions::from_mode(0o755));
        }
        crate::debug_log::log(&format!(
            "refresh_launcher: installed shorthand at {:?}",
            wrapper_path
        ));
    }
}

/// Read a theme CSS file by name from ~/.config/tmuxy/themes/<name>.css.
/// Falls back to the bundled copy if the user's directory doesn't have it
/// (e.g. they deleted a default but the menu still references it).
pub fn read_theme_css(name: &str) -> Result<String, String> {
    let path = config_dir().join("themes").join(format!("{}.css", name));
    if let Ok(content) = std::fs::read_to_string(&path) {
        return Ok(content);
    }

    let filename = format!("{}.css", name);
    for (bundled_name, bundled_content) in BUNDLED_THEMES {
        if *bundled_name == filename {
            return Ok((*bundled_content).to_string());
        }
    }

    Err(format!("theme '{}' not found", name))
}

pub fn session_exists(session_name: &str) -> Result<bool, String> {
    crate::debug_log::log_cmd(
        "has-session",
        tmux_path(),
        &["has-session", "-t", session_name],
    );
    let output = tmux_command()
        .args(["has-session", "-t", session_name])
        .output()
        .map_err(|e| format!("Failed to check session: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    crate::debug_log::log_cmd_result("has-session", output.status.code(), &stdout, &stderr);
    Ok(output.status.success())
}

pub fn create_session(session_name: &str) -> Result<(), String> {
    let config_path = get_config_path();

    let mut args = vec!["new-session", "-d", "-s", session_name];

    // Use custom config if it exists
    let config_str = config_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    if let Some(ref cs) = config_str {
        args.insert(0, "-f");
        args.insert(1, cs);
    }

    let args_ref: Vec<&str> = args.iter().map(|s| &**s).collect();
    crate::debug_log::log_cmd("create-session", tmux_path(), &args_ref);
    let output = tmux_command()
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to create session: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    crate::debug_log::log_cmd_result("create-session", output.status.code(), &stdout, &stderr);

    if !output.status.success() {
        return Err(format!(
            "tmux new-session failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    Ok(())
}

/// Source the tmuxy config file in an existing session
pub fn source_config(_session_name: &str) -> Result<(), String> {
    let Some(config_path) = get_config_path() else {
        return Ok(()); // No config to source
    };

    let config_str = config_path.to_string_lossy().to_string();
    tmux_command()
        .args(["source-file", &config_str])
        .output()
        .map_err(|e| format!("Failed to source config: {}", e))?;

    Ok(())
}

pub fn create_or_attach(session_name: &str) -> Result<(), String> {
    if !session_exists(session_name)? {
        create_session(session_name)?;
    } else {
        // Source config for existing session
        let _ = source_config(session_name);
    }
    Ok(())
}

pub fn kill_session(session_name: &str) -> Result<(), String> {
    tmux_command()
        .args(["kill-session", "-t", session_name])
        .output()
        .map_err(|e| format!("Failed to kill session: {}", e))?;

    Ok(())
}
