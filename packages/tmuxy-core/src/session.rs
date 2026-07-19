use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use tracing::{info, warn};

use crate::constants::tmux_options;
use crate::error::TmuxError;

type Result<T> = std::result::Result<T, TmuxError>;

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

/// The named tmux server socket tmuxy talks to when `TMUX_SOCKET` is unset.
/// A dedicated socket keeps tmuxy's server fully isolated from the user's
/// own tmux sessions on the default socket.
pub const DEFAULT_TMUX_SOCKET: &str = "tmuxy";

/// Resolve the tmux socket: `TMUX_SOCKET` when set and non-empty, otherwise
/// the dedicated [`DEFAULT_TMUX_SOCKET`]. The value is a socket *name*
/// (tmux `-L`) unless it contains a `/`, in which case it's a full socket
/// *path* (tmux `-S`) — see [`tmux_socket_args`].
pub fn tmux_socket() -> String {
    match std::env::var("TMUX_SOCKET") {
        Ok(socket) if !socket.is_empty() => socket,
        _ => DEFAULT_TMUX_SOCKET.to_string(),
    }
}

/// The socket flag pair for tmux invocations: `["-L", <name>]` for a socket
/// name, or `["-S", <path>]` when `TMUX_SOCKET` holds a path (contains `/`).
/// Passing the flag unconditionally also overrides an inherited `$TMUX`, so
/// tmuxy behaves the same whether or not it was launched from inside a tmux
/// pane — and never touches the user's default tmux server.
pub fn tmux_socket_args() -> [String; 2] {
    let socket = tmux_socket();
    let flag = if socket.contains('/') { "-S" } else { "-L" };
    [flag.to_string(), socket]
}

/// The SSH tunnel tmuxy runs tmux through, read from `TMUXY_SSH`. When set and
/// non-empty, every tmux invocation is wrapped as `ssh <tail> tmux …` so the
/// desktop app can attach its control-mode monitor to a tmux server on a remote
/// host. The value is a whitespace-separated ssh argv *tail* — options plus the
/// destination, e.g. `-p 2222 user@host` or just `user@host`. Empty/unset means
/// local (the normal case, and always the case for the web server).
pub fn ssh_target() -> Option<Vec<String>> {
    match std::env::var("TMUXY_SSH") {
        Ok(s) if !s.trim().is_empty() => Some(s.split_whitespace().map(String::from).collect()),
        _ => None,
    }
}

/// Build the argv to invoke tmux, honoring an optional SSH tunnel
/// ([`ssh_target`]). `pty` selects whether the ssh hop allocates a remote tty
/// (`-tt`) — required for `-CC` control mode, but harmful for one-off reads
/// (it echoes CRs into captured output), so pass `false` for those.
///
/// Returns e.g.:
///   local:  `["/opt/homebrew/bin/tmux", "-L", "tmuxy"]`
///   ssh:    `["ssh", "-tt", "user@host", "tmux", "-L", "tmuxy"]`
///
/// The remote tmux is invoked as bare `tmux` (resolved by the remote login
/// shell's PATH) — the local [`tmux_path`] absolute path is meaningless there.
pub fn tmux_argv(pty: bool) -> Vec<String> {
    match ssh_target() {
        Some(ssh) => {
            let mut v = vec!["ssh".to_string()];
            if pty {
                v.push("-tt".to_string());
            }
            v.extend(ssh);
            v.push("tmux".to_string());
            v.extend(tmux_socket_args());
            v
        }
        None => {
            let mut v = vec![tmux_path().to_string()];
            v.extend(tmux_socket_args());
            v
        }
    }
}

/// Create a `Command` for tmux targeting the resolved socket (and SSH tunnel,
/// if any). Used for one-off reads/writes — no remote tty (`pty = false`).
pub fn tmux_command() -> Command {
    let argv = tmux_argv(false);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd
}

/// Build the tmux shell command string with the socket flag for use in shell
/// invocations. Returns e.g. "/opt/homebrew/bin/tmux -L tmuxy", or when tunneled
/// "ssh user@host tmux -L tmuxy".
pub fn tmux_bin() -> String {
    tmux_argv(false).join(" ")
}

/// Shipped defaults — overwritten on every app launch so users get new
/// defaults (new bindings, new options) without merge work. Users never
/// edit this file; their overrides live in `tmuxy.conf` which sources
/// this one first.
const DEFAULT_DEFAULTS_CONF: &str = include_str!("../../../.devcontainer/.tmuxy.defaults.conf");

/// User-editable config template — written ONLY when `tmuxy.conf` does not
/// already exist. Sources `tmuxy.defaults.conf` first, then leaves space
/// for the user's customizations, then sources `tmuxy.state.conf` for
/// app-managed values (theme, opacity overrides set via the UI).
const DEFAULT_USER_CONF: &str = include_str!("../../../.devcontainer/.tmuxy.conf");

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
    (
        "tmuxy/event-emit",
        include_str!("../../../bin/tmuxy/event-emit"),
    ),
    (
        "tmuxy/event-list",
        include_str!("../../../bin/tmuxy/event-list"),
    ),
    (
        "tmuxy/event-wait",
        include_str!("../../../bin/tmuxy/event-wait"),
    ),
    (
        "tmuxy/float-create",
        include_str!("../../../bin/tmuxy/float-create"),
    ),
    ("tmuxy/nav", include_str!("../../../bin/tmuxy/nav")),
    (
        "tmuxy/pane-group-add",
        include_str!("../../../bin/tmuxy/pane-group-add"),
    ),
    (
        "tmuxy/pane-group-close",
        include_str!("../../../bin/tmuxy/pane-group-close"),
    ),
    (
        "tmuxy/pane-group-next",
        include_str!("../../../bin/tmuxy/pane-group-next"),
    ),
    (
        "tmuxy/pane-group-prev",
        include_str!("../../../bin/tmuxy/pane-group-prev"),
    ),
    (
        "tmuxy/pane-group-switch",
        include_str!("../../../bin/tmuxy/pane-group-switch"),
    ),
    ("tmuxy/stack", include_str!("../../../bin/tmuxy/stack")),
    (
        "tmuxy/session-connect",
        include_str!("../../../bin/tmuxy/session-connect"),
    ),
    (
        "tmuxy/session-switch",
        include_str!("../../../bin/tmuxy/session-switch"),
    ),
    (
        "tmuxy/tmuxy-widget",
        include_str!("../../../bin/tmuxy/tmuxy-widget"),
    ),
    (
        "tmuxy/tmuxy-widget-image",
        include_str!("../../../bin/tmuxy/tmuxy-widget-image"),
    ),
    (
        "tmuxy/tmuxy-widget-markdown",
        include_str!("../../../bin/tmuxy/tmuxy-widget-markdown"),
    ),
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

/// Ensure the shipped defaults and user config exist at
/// ~/.config/tmuxy/. Three files participate:
///
///   - `tmuxy.defaults.conf` — shipped baseline. **Overwritten every
///     launch** so improvements (new bindings, new options) land without
///     any user merge work. The user's `tmuxy.conf` sources this first.
///   - `tmuxy.conf` — user-editable. Created from the shipped template
///     only if it doesn't already exist. Sources defaults, leaves space
///     for overrides, then sources state.
///   - `tmuxy.state.conf` — app-managed state (theme, etc.). Not created
///     here; written by [`write_managed_state`] when the UI changes it.
///     The user conf sources this last with `-q` so a missing file is OK.
///
/// Also migrates configs written by older tmuxy releases (≤0.0.4) that
/// referenced helper scripts via the relative path `bin/tmuxy/…`.
pub fn ensure_config() -> PathBuf {
    let dir = config_dir();
    let user_path = dir.join("tmuxy.conf");
    let defaults_path = dir.join("tmuxy.defaults.conf");

    if let Err(e) = std::fs::create_dir_all(&dir) {
        warn!(?dir, error = %e, "could not create config dir");
        return user_path;
    }

    // Always refresh the defaults file — it's app-owned, not user-owned.
    // Skip the rewrite if it's a symlink so the dev-container workflow
    // (symlink to the repo's checked-in defaults) keeps working.
    let defaults_is_symlink = std::fs::symlink_metadata(&defaults_path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !defaults_is_symlink {
        let needs_defaults_write = match std::fs::read_to_string(&defaults_path) {
            Ok(existing) => existing != DEFAULT_DEFAULTS_CONF,
            Err(_) => true,
        };
        if needs_defaults_write {
            if let Err(e) = std::fs::write(&defaults_path, DEFAULT_DEFAULTS_CONF) {
                warn!(
                    file = ?defaults_path.file_name().unwrap_or_default(),
                    error = %e,
                    "could not write defaults file"
                );
            } else {
                info!(path = ?defaults_path, "refreshed tmuxy.defaults.conf");
            }
        }
    }

    // Create the user-editable conf only if it doesn't exist.
    if !user_path.exists() {
        if let Err(e) = std::fs::write(&user_path, DEFAULT_USER_CONF) {
            warn!(path = ?user_path, error = %e, "could not write default user config");
        } else {
            info!(path = ?user_path, "created tmuxy.conf");
        }
        return user_path;
    }

    // Migrate stale relative bin paths in pre-existing user configs. Skip
    // when the path is a symlink (devcontainer workflow) so we don't write
    // through to the repo-checked-in file.
    let user_is_symlink = std::fs::symlink_metadata(&user_path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !user_is_symlink {
        if let Ok(existing) = std::fs::read_to_string(&user_path) {
            let migrated = migrate_bin_paths(&existing);
            let migrated = repair_doubled_bin_paths(&migrated);
            let migrated = migrate_tab_bindings(&migrated);
            if migrated != existing {
                if let Err(e) = std::fs::write(&user_path, &migrated) {
                    warn!(path = ?user_path, error = %e, "could not migrate config");
                } else {
                    info!(path = ?user_path, "migrated tmuxy.conf");
                }
            }
        }
    }

    user_path
}

/// App-managed state persisted to `~/.config/tmuxy/tmuxy.state.json`.
///
/// Read on startup by [`apply_managed_state`] which translates each set field
/// into a `set-option -g` against tmux, so a theme picked through the UI
/// survives a tmux server restart (fully quitting the app, last session
/// closing, etc.).
///
/// Unknown JSON keys are tolerated and preserved on write — this is the
/// forwards-compatibility hatch when older binaries read state files written
/// by newer ones. Add new fields freely; just don't rename existing ones
/// without a migration.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct ManagedState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_mode: Option<String>,
    /// Preserve unknown keys across roundtrips so a newer build's state file
    /// isn't truncated when read+written by an older one.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Path to the JSON state file inside the user's config dir. Does not check
/// for existence — callers handle missing files.
pub fn managed_state_path() -> PathBuf {
    config_dir().join("tmuxy.state.json")
}

/// Read the managed state from disk. Returns a default (all-None) struct if
/// the file is missing or unparseable rather than erroring — losing app
/// state should never crash startup.
pub fn read_managed_state() -> ManagedState {
    let path = managed_state_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ManagedState::default();
    };
    match serde_json::from_str::<ManagedState>(&text) {
        Ok(state) => state,
        Err(e) => {
            warn!(?path, error = %e, "could not parse managed state file, using defaults");
            ManagedState::default()
        }
    }
}

/// Update one field in the JSON state file. Reads the existing file (if
/// any) so unspecified fields are preserved; pass `Some` for whichever
/// fields you're updating, `None` to leave them as-is.
pub fn write_managed_state(
    theme: Option<&str>,
    theme_mode: Option<&str>,
) -> std::io::Result<PathBuf> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let path = managed_state_path();

    let mut state = read_managed_state();
    if let Some(t) = theme {
        state.theme = Some(t.to_string());
    }
    if let Some(m) = theme_mode {
        state.theme_mode = Some(m.to_string());
    }

    let body = serde_json::to_string_pretty(&state).map_err(std::io::Error::other)?;
    std::fs::write(&path, format!("{}\n", body))?;
    Ok(path)
}

/// Push every set field in the JSON state file into tmux as a global option,
/// so the running server's `show-options -gqv @tmuxy-theme` (etc.) returns
/// the persisted value. Called once during session init — failure on any
/// individual `set-option` is logged but doesn't abort startup.
/// The session tmuxy targets: `TMUXY_SESSION` env or the default.
/// One resolution point — the Tauri app used to carry two private copies
/// plus an inline third in gui.rs.
pub fn session_name() -> String {
    std::env::var("TMUXY_SESSION").unwrap_or_else(|_| crate::DEFAULT_SESSION_NAME.to_string())
}

pub fn apply_managed_state(session_name: &str) {
    let state = read_managed_state();
    let pairs: [(Option<&str>, &str); 2] = [
        (state.theme.as_deref(), tmux_options::THEME),
        (state.theme_mode.as_deref(), tmux_options::THEME_MODE),
    ];
    for (value, option) in pairs {
        let Some(v) = value else { continue };
        if let Err(e) = crate::executor::execute_tmux_command(&[
            "set-option",
            "-t",
            session_name,
            "-g",
            option,
            v,
        ]) {
            warn!(%option, value = %v, error = %e, "failed to apply managed state option");
        }
    }
}

/// Repair `$HOME/.config/tmuxy/$HOME/.config/tmuxy/bin/tmuxy/…` doubled
/// paths produced by the non-idempotent v0.0.5→v0.0.6 migration. Collapses
/// any number of repeated `$HOME/.config/tmuxy/` prefixes down to one.
fn repair_doubled_bin_paths(config: &str) -> String {
    let doubled = "$HOME/.config/tmuxy/$HOME/.config/tmuxy/";
    let single = "$HOME/.config/tmuxy/";
    let mut result = config.to_string();
    while result.contains(doubled) {
        result = result.replace(doubled, single);
    }
    result
}

/// Append the Ctrl+Tab / Ctrl+Shift+Tab root bindings to an existing user
/// config if they're missing. New default configs already include them; this
/// is for users upgrading from a release that predated those bindings.
fn migrate_tab_bindings(config: &str) -> String {
    let has_ctab = config.contains("bind -n C-Tab ");
    let has_cstab = config.contains("bind -n C-S-Tab ");
    if has_ctab && has_cstab {
        return config.to_string();
    }
    let mut result = config.to_string();
    if !result.ends_with('\n') {
        result.push('\n');
    }
    result.push_str("\n# Tab navigation (Ctrl+Tab / Ctrl+Shift+Tab) — added by tmuxy upgrade\n");
    if !has_ctab {
        result.push_str("bind -n C-Tab next-window\n");
    }
    if !has_cstab {
        result.push_str("bind -n C-S-Tab previous-window\n");
    }
    result
}

/// Rewrite legacy relative `bin/tmuxy/…` paths to the materialized absolute
/// path. Conservative — only touches occurrences inside `run-shell` strings
/// for our known helpers, so a user who hand-rolled a `bin/` reference for
/// their own scripts isn't affected.
///
/// Idempotent: if the config already contains the fresh path prefix, the
/// migration is skipped entirely. Without this guard the substring `replace`
/// would recursively rewrite the already-migrated path on every launch —
/// e.g. v0.0.5→v0.0.6 upgrades produced
/// `$HOME/.config/tmuxy/$HOME/.config/tmuxy/bin/tmuxy/nav`, which silently
/// broke Ctrl+hjkl pane navigation and pane-group actions on macOS.
fn migrate_bin_paths(config: &str) -> String {
    if config.contains("$HOME/.config/tmuxy/bin/tmuxy/") {
        return config.to_string();
    }
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

/// Theme files that were once bundled but have since been removed. On launch
/// we delete these from the user's themes dir so the Theme menu (which lists
/// the contents of the directory) doesn't keep showing orphaned options.
/// A user who customized one of these files loses their copy — by design;
/// themes are managed, not user-data.
const RETIRED_THEMES: &[&str] = &["gruvbox-material.css"];

/// Ensure the themes directory exists at ~/.config/tmuxy/themes/ and is
/// populated with the bundled theme CSS files. Existing files are NOT
/// overwritten so the user's edits survive across upgrades. Returns the
/// path to the themes directory.
pub fn ensure_themes() -> PathBuf {
    let themes_dir = config_dir().join("themes");

    if let Err(e) = std::fs::create_dir_all(&themes_dir) {
        warn!(dir = ?themes_dir, error = %e, "could not create themes dir");
        return themes_dir;
    }

    for (name, content) in BUNDLED_THEMES {
        let path = themes_dir.join(name);
        if !path.exists() {
            if let Err(e) = std::fs::write(&path, content) {
                warn!(?path, error = %e, "could not write bundled theme");
            }
        }
    }

    for name in RETIRED_THEMES {
        let path = themes_dir.join(name);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(&path) {
                warn!(?path, error = %e, "could not remove retired theme");
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

pub fn session_exists(session_name: &str) -> Result<bool> {
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

pub fn create_session(session_name: &str) -> Result<()> {
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
        return Err(TmuxError::other(format!(
            "tmux new-session failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        )));
    }

    // Tag the freshly-created window so the frontend sees a 'tab' window
    // from the first state emission. The control-mode auto-adopt path is
    // a fallback for sessions tmuxy didn't create; here we know there's
    // exactly one window and it should be a tab.
    let target = format!("{}:0", session_name);
    let _ = tmux_command()
        .args([
            "set-option",
            "-w",
            "-t",
            &target,
            tmux_options::WINDOW_TYPE,
            crate::WindowType::Tab.as_str(),
        ])
        .output();

    Ok(())
}

/// Source the tmuxy config file (server-global — tmux `source-file` is not
/// session-scoped, which is why this takes no session parameter).
pub fn source_config() -> Result<()> {
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

pub fn create_or_attach(session_name: &str) -> Result<()> {
    if !session_exists(session_name)? {
        create_session(session_name)?;
    } else {
        // Source config for existing session
        let _ = source_config();
    }
    // Re-apply persisted app state (theme, etc.). Runs whether the session
    // was just created or already existed — in both cases tmux's globals
    // may have been reset (fresh server) or carry stale values from a prior
    // tmuxy build. Failure is logged inside the helper, not returned.
    apply_managed_state(session_name);
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn migrate_bin_paths_rewrites_stale_relative_paths() {
        let input =
            r#"set -s command-alias[110] 'tmuxy-nav-left=run-shell "bash bin/tmuxy/nav left"'"#;
        let out = migrate_bin_paths(input);
        assert!(out.contains("$HOME/.config/tmuxy/bin/tmuxy/nav"));
        assert!(!out.contains("\"bash bin/tmuxy/nav"));
    }

    #[test]
    fn migrate_bin_paths_is_idempotent() {
        // Regression: v0.0.5 wrote configs with the fresh path already in place.
        // v0.0.6's substring `replace` found `bin/tmuxy/nav` inside the fresh
        // path and produced `$HOME/.config/tmuxy/$HOME/.config/tmuxy/bin/tmuxy/nav`,
        // breaking Ctrl+hjkl on every upgrade.
        let input = r#"run-shell "bash $HOME/.config/tmuxy/bin/tmuxy/nav left""#;
        let out = migrate_bin_paths(input);
        assert_eq!(out, input);
        assert!(!out.contains("$HOME/.config/tmuxy/$HOME"));
    }

    #[test]
    fn repair_doubled_bin_paths_collapses_repeated_prefixes() {
        let doubled = "run-shell \"bash $HOME/.config/tmuxy/$HOME/.config/tmuxy/bin/tmuxy/nav\"";
        let out = repair_doubled_bin_paths(doubled);
        assert_eq!(out, "run-shell \"bash $HOME/.config/tmuxy/bin/tmuxy/nav\"");
    }

    #[test]
    fn repair_doubled_bin_paths_handles_triple_mangling() {
        let triple = "$HOME/.config/tmuxy/$HOME/.config/tmuxy/$HOME/.config/tmuxy/bin/tmuxy/nav";
        let out = repair_doubled_bin_paths(triple);
        assert_eq!(out, "$HOME/.config/tmuxy/bin/tmuxy/nav");
    }

    #[test]
    fn migrate_tab_bindings_appends_when_missing() {
        let input = "set -g prefix C-a\n";
        let out = migrate_tab_bindings(input);
        assert!(out.contains("bind -n C-Tab next-window"));
        assert!(out.contains("bind -n C-S-Tab previous-window"));
    }

    #[test]
    fn migrate_tab_bindings_is_idempotent() {
        let input =
            "set -g prefix C-a\nbind -n C-Tab next-window\nbind -n C-S-Tab previous-window\n";
        let out = migrate_tab_bindings(input);
        assert_eq!(out, input);
    }

    #[test]
    fn parse_option_from_config_reads_set_g_lines() {
        let cfg = "# comment\nset -g @tmuxy-opacity 0.8\nset -g @tmuxy-vibrancy under-window\n";
        // Re-implementing here so we don't reach into the gui crate; the parser
        // logic in tauri-app/src/gui.rs is exercised independently in its own
        // build, but having the regression here lives next to migrate_bin_paths.
        let opacity_line = cfg
            .lines()
            .find(|l| l.contains("@tmuxy-opacity"))
            .expect("opacity line");
        assert!(opacity_line.ends_with("0.8"));
    }

    #[test]
    fn managed_state_serde_roundtrips() {
        let state = ManagedState {
            theme: Some("dracula".into()),
            theme_mode: Some("dark".into()),
            extra: serde_json::Map::new(),
        };
        let json = serde_json::to_string(&state).unwrap();
        let parsed: ManagedState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.theme.as_deref(), Some("dracula"));
        assert_eq!(parsed.theme_mode.as_deref(), Some("dark"));
    }

    #[test]
    fn managed_state_preserves_unknown_keys_across_roundtrip() {
        // Newer-tmuxy fields should survive an old-tmuxy read+write so we don't
        // truncate state when an old binary touches a new file.
        let input = r#"{"theme":"gruvbox","future_field":"keep me","nested":{"a":1}}"#;
        let parsed: ManagedState = serde_json::from_str(input).unwrap();
        let out = serde_json::to_string(&parsed).unwrap();
        assert!(out.contains("\"future_field\":\"keep me\""));
        assert!(out.contains("\"nested\""));
        assert!(out.contains("\"theme\":\"gruvbox\""));
    }

    #[test]
    fn managed_state_skips_unset_fields_on_serialize() {
        let state = ManagedState::default();
        let json = serde_json::to_string(&state).unwrap();
        // Empty struct must not write nulls — older readers might choke on them.
        assert_eq!(json, "{}");
    }
}
