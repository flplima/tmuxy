use std::path::{Path, PathBuf};
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
///
/// This is the socket of a **released build**. The development and test
/// environments set `TMUX_SOCKET` to `tmuxy-dev` and `tmuxy-test` instead, so
/// a dev server or a test run never disturbs an installed tmuxy.
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
///
/// Nothing a client sends may be appended to this: over ssh the trailing
/// arguments are joined into one remote shell command line. A client's
/// command rides the control-mode connection instead.
pub fn tmux_command() -> Command {
    let argv = tmux_argv(false);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd
}

/// Run one tmux invocation for a command-line verb and return what it printed.
///
/// Safe where those verbs run: reads anywhere, and mutations only from inside
/// `tmux run-shell`, where tmux runs them in its own context rather than as a
/// second client racing the control-mode one (docs/TMUX.md). The CLI wraps
/// every mutating verb that way.
pub fn tmux_output(argv: &[String]) -> std::result::Result<String, String> {
    let output = tmux_command()
        .args(argv)
        .output()
        .map_err(|e| format!("tmux {}: {e}", argv.join(" ")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "tmux {}: {}",
            argv.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
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

/// The settings tmuxy cannot work without — command-aliases plus the handful of
/// tmux options the renderer, the scrollback and the session lifetime depend on.
/// App-owned and refreshed like the defaults.
///
/// Sourced twice: once from `tmuxy.defaults.conf`, and again immediately after
/// a user's own `~/.tmux.conf` when they have opted into it. The second pass is
/// what lets tmuxy adopt somebody's prefix, status line and plugins without
/// their config being able to take the app apart.
const DEFAULT_ESSENTIALS_CONF: &str = include_str!("../../../.devcontainer/.tmuxy.essentials.conf");

/// User-editable config template — written ONLY when `tmuxy.conf` does not
/// already exist. Sources `tmuxy.defaults.conf` first, then leaves space
/// for the user's customizations.
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
    ("tmuxy/ask", include_str!("../../../bin/tmuxy/ask")),
    (
        "tmuxy/queue-push",
        include_str!("../../../bin/tmuxy/queue-push"),
    ),
    (
        "tmuxy/queue-pop",
        include_str!("../../../bin/tmuxy/queue-pop"),
    ),
    (
        "tmuxy/queue-peek",
        include_str!("../../../bin/tmuxy/queue-peek"),
    ),
    (
        "tmuxy/queue-list",
        include_str!("../../../bin/tmuxy/queue-list"),
    ),
    (
        "tmuxy/queue-clear",
        include_str!("../../../bin/tmuxy/queue-clear"),
    ),
    (
        "tmuxy/float-create",
        include_str!("../../../bin/tmuxy/float-create"),
    ),
    ("tmuxy/nav", include_str!("../../../bin/tmuxy/nav")),
    (
        "tmuxy/reap-orphan-shells",
        include_str!("../../../bin/tmuxy/reap-orphan-shells"),
    ),
    (
        "tmuxy/pane-group-add",
        include_str!("../../../bin/tmuxy/pane-group-add"),
    ),
    (
        "tmuxy/pane-group-park",
        include_str!("../../../bin/tmuxy/pane-group-park"),
    ),
    (
        "tmuxy/pane-group-move",
        include_str!("../../../bin/tmuxy/pane-group-move"),
    ),
    (
        "tmuxy/pane-group-join",
        include_str!("../../../bin/tmuxy/pane-group-join"),
    ),
    (
        "tmuxy/pane-group-leave",
        include_str!("../../../bin/tmuxy/pane-group-leave"),
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
        "tmuxy/tmuxy-widget-browser",
        include_str!("../../../bin/tmuxy/tmuxy-widget-browser"),
    ),
    (
        "tmuxy/tmuxy-widget-session",
        include_str!("../../../bin/tmuxy/tmuxy-widget-session"),
    ),
    (
        "tmuxy/tmuxy-widget-tree",
        include_str!("../../../bin/tmuxy/tmuxy-widget-tree"),
    ),
];

#[cfg(test)]
mod bundled_scripts_tests {
    use super::BUNDLED_BIN_SCRIPTS;

    /// Every helper under `bin/tmuxy/` must be in the bundled list, or the
    /// packaged app ships a `tmuxy-cli` that dispatches to a file that was
    /// never mirrored to `~/.config/tmuxy/bin/` (the tree sidebar shipped that
    /// way once: `tmuxy widget tree` died with "No such file or directory").
    #[test]
    fn every_helper_script_is_bundled() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/tmuxy");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .expect("bin/tmuxy readable")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| format!("tmuxy/{}", e.file_name().to_string_lossy()))
            .collect();
        on_disk.sort();
        let mut bundled: Vec<String> = BUNDLED_BIN_SCRIPTS
            .iter()
            .map(|(rel, _)| rel.to_string())
            .filter(|rel| rel.starts_with("tmuxy/"))
            .collect();
        bundled.sort();
        assert_eq!(
            on_disk, bundled,
            "bin/tmuxy/* and BUNDLED_BIN_SCRIPTS disagree"
        );
    }
}

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

/// The user's `tmuxy.conf` in [`config_dir`], if it exists. Both hosts call
/// [`ensure_config`] at startup, before any monitor connects, so it is only
/// absent when that write failed.
pub fn get_config_path() -> Option<PathBuf> {
    let path = config_dir().join("tmuxy.conf");
    path.exists().then_some(path)
}

/// The shipped user conf sources its siblings by the default
/// `~/.config/tmuxy` path; when `XDG_CONFIG_HOME` relocates the config dir,
/// point those lines at the real location instead.
fn user_conf_template(dir: &std::path::Path) -> String {
    let default_dir = dirs::home_dir().map(|home| home.join(".config").join("tmuxy"));
    if default_dir.as_deref() == Some(dir) {
        DEFAULT_USER_CONF.to_string()
    } else {
        DEFAULT_USER_CONF.replace("~/.config/tmuxy", &dir.to_string_lossy())
    }
}

/// Write an app-owned config file, unless it is a symlink.
///
/// The symlink check is the devcontainer workflow: the config dir's files are
/// symlinked to the repo's checked-in copies so an edit there is live, and
/// writing through the link would rewrite the repo.
fn write_app_owned_conf(path: &Path, contents: &str) {
    let is_symlink = std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if is_symlink {
        return;
    }
    let needs_write = match std::fs::read_to_string(path) {
        Ok(existing) => existing != contents,
        Err(_) => true,
    };
    if !needs_write {
        return;
    }
    if let Err(e) = std::fs::write(path, contents) {
        warn!(?path, error = %e, "could not write app-owned config file");
    } else {
        info!(?path, "refreshed app-owned config file");
    }
}

/// Generate `tmuxy.user.conf`, the one-line bridge to a user's own
/// `~/.tmux.conf`.
///
/// Generated rather than hand-editable, and sourced from the END of
/// `tmuxy.defaults.conf`, because `tmuxy.conf` is written once and never again:
/// anything that has to reach people who already installed tmuxy must live in a
/// file the app refreshes on every launch.
///
/// Opting in sources the user's config and then re-applies
/// `tmuxy.essentials.conf` on top. That order is the whole design: their
/// prefix, status line and plugins win over tmuxy's taste, and tmuxy's
/// essentials win over anything of theirs that would stop the app working.
fn write_user_conf_bridge(dir: &Path) {
    let path = dir.join("tmuxy.user.conf");
    let enabled = read_managed_state().use_tmux_conf.unwrap_or(false);

    let contents = if enabled {
        "# Generated by tmuxy — do not edit; `tmuxy config use-tmux-conf off` undoes it.\n\
         #\n\
         # Your own config, then tmuxy's essentials re-applied on top. Your prefix,\n\
         # status line and plugins survive; the settings tmuxy needs to function are\n\
         # restored afterwards whatever your config did to them.\n\
         source-file -q ~/.tmux.conf\n\
         source-file ~/.config/tmuxy/tmuxy.essentials.conf\n"
            .to_string()
    } else {
        "# Generated by tmuxy — do not edit.\n\
         #\n\
         # tmuxy is not reading your ~/.tmux.conf. It starts tmux with its own config,\n\
         # so your prefix, status line and plugins are not loaded on tmuxy's socket.\n\
         #\n\
         # To use your own config here:  tmuxy config use-tmux-conf on\n\
         #\n\
         # That sources ~/.tmux.conf and then re-applies tmuxy.essentials.conf on top,\n\
         # so your settings win except where they would stop tmuxy working. Read\n\
         # tmuxy.essentials.conf to see exactly what that covers.\n"
            .to_string()
    };

    write_app_owned_conf(&path, &contents);
}

/// Ensure the shipped defaults and user config exist at
/// ~/.config/tmuxy/. Three files participate:
///
///   - `tmuxy.defaults.conf` — shipped baseline. **Overwritten every
///     launch** so improvements (new bindings, new options) land without
///     any user merge work. The user's `tmuxy.conf` sources this first.
///   - `tmuxy.conf` — user-editable. Created from the shipped template
///     only if it doesn't already exist. Sources defaults and leaves space
///     for overrides.
///   - `tmuxy.state.json` — app-managed state (theme, etc.). Not created
///     here; written by [`write_managed_state`] when the UI changes it, and
///     re-applied to tmux by the control-mode monitor on every connect
///     (see [`managed_state_commands`]).
pub fn ensure_config() -> PathBuf {
    let dir = config_dir();
    let user_path = dir.join("tmuxy.conf");
    let defaults_path = dir.join("tmuxy.defaults.conf");

    if let Err(e) = std::fs::create_dir_all(&dir) {
        warn!(?dir, error = %e, "could not create config dir");
        return user_path;
    }

    write_app_owned_conf(&defaults_path, DEFAULT_DEFAULTS_CONF);
    write_app_owned_conf(&dir.join("tmuxy.essentials.conf"), DEFAULT_ESSENTIALS_CONF);
    write_user_conf_bridge(&dir);

    // Create the user-editable conf only if it doesn't exist.
    if !user_path.exists() {
        if let Err(e) = std::fs::write(&user_path, user_conf_template(&dir)) {
            warn!(path = ?user_path, error = %e, "could not write default user config");
        } else {
            info!(path = ?user_path, "created tmuxy.conf");
        }
    }

    user_path
}

/// App-managed state persisted to `~/.config/tmuxy/tmuxy.state.json`.
///
/// The control-mode monitor re-applies it on every connect (see
/// [`managed_state_commands`]), so a theme picked through the UI survives a
/// tmux server restart (fully quitting the app, last session closing, etc.).
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct ManagedState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_mode: Option<String>,
    /// Whether the cursor blinks (`@tmuxy-cursor-blink`), when the user has
    /// chosen through the app rather than in `tmuxy.conf`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    /// Whether to source the user's own `~/.tmux.conf` on tmuxy's socket.
    ///
    /// Off by default, and deliberately not a tmux option: it decides what goes
    /// into the config chain, so it has to be known before that chain is read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_tmux_conf: Option<bool>,
}

/// The `set-option -g` commands that put every set field of `state` back into
/// tmux, so the running server's `show-options -gqv @tmuxy-theme` (etc.)
/// returns the persisted choice. The monitor sends them through the
/// control-mode connection right after sourcing the config, which is what
/// lets a UI choice win over a hand-set value in `tmuxy.conf`.
pub fn managed_state_commands(state: &ManagedState) -> Vec<String> {
    let blink = state.cursor_blink.map(|on| if on { "on" } else { "off" });
    [
        (tmux_options::THEME, state.theme.as_deref()),
        (tmux_options::THEME_MODE, state.theme_mode.as_deref()),
        (tmux_options::CURSOR_BLINK, blink),
    ]
    .into_iter()
    .filter_map(|(option, value)| {
        value.map(|v| format!("set-option -g {option} {}", crate::executor::tmux_quote(v)))
    })
    .collect()
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
    cursor_blink: Option<bool>,
    use_tmux_conf: Option<bool>,
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
    if let Some(b) = cursor_blink {
        state.cursor_blink = Some(b);
    }
    if let Some(b) = use_tmux_conf {
        state.use_tmux_conf = Some(b);
    }

    let body = serde_json::to_string_pretty(&state).map_err(std::io::Error::other)?;
    std::fs::write(&path, format!("{}\n", body))?;
    Ok(path)
}

/// The session tmuxy targets: `TMUXY_SESSION` env or the default.
pub fn session_name() -> String {
    std::env::var("TMUXY_SESSION").unwrap_or_else(|_| crate::DEFAULT_SESSION_NAME.to_string())
}

/// Whether `name` is a session name the server will write into a command line.
///
/// SEC-14. A client names its session in `?session=`, and that name goes into
/// control-mode commands and into `run-shell` strings that tmux format-expands
/// before a shell sees them. Rather than escape for each of those contexts,
/// the name is held to letters, digits and `_ - @ +` — every name tmuxy itself
/// creates fits, tmux forbids `.` and `:` in any case, and nothing in the
/// alphabet means anything to a format string, a shell or a command parser.
pub fn is_safe_session_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'@' | b'+'))
}

#[cfg(test)]
mod name_tests {
    use super::*;

    #[test]
    fn the_server_command_is_published_quoted_with_its_subcommand() {
        assert_eq!(
            server_command_env_for(Path::new("/Apps/my tmuxy/tmuxy"), Some("server")),
            [
                "set-environment -g TMUXY_SERVER_BIN '/Apps/my tmuxy/tmuxy'",
                "set-environment -g TMUXY_SERVER_SUBCOMMAND 'server'",
            ]
        );
        assert_eq!(
            server_command_env_for(Path::new("/bin/tmuxy-server"), None)[1],
            "set-environment -g -u TMUXY_SERVER_SUBCOMMAND"
        );
    }

    #[test]
    fn session_names_are_held_to_the_alphabet() {
        for ok in ["tmuxy", "tmuxy_test_1727", "a-b", "me@host", "c++", "x"] {
            assert!(is_safe_session_name(ok), "{ok:?} should be accepted");
        }
        for bad in [
            "",
            "a b",
            "a'b",
            "a;b",
            "a#(id)",
            "a.b",
            "a:b",
            "a\nb",
            "a\u{7f}b",
            "ünïcode",
        ] {
            assert!(!is_safe_session_name(bad), "{bad:?} should be refused");
        }
    }
}

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

    themes_dir
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

fn server_command_env_for(exe: &Path, subcommand: Option<&str>) -> Vec<String> {
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

pub fn session_exists(session_name: &str) -> Result<bool> {
    let output = tmux_command()
        .args(["has-session", "-t", session_name])
        .output()
        .map_err(|e| format!("Failed to check session: {}", e))?;
    tracing::debug!(session = session_name, exit = ?output.status.code(), "has-session");
    Ok(output.status.success())
}

/// The socket name tmux itself uses when nobody says otherwise — the server a
/// person's own `tmux` command talks to.
///
/// tmuxy stays off it by default (see `DEFAULT_TMUX_SOCKET`).
pub const USERS_OWN_SOCKET: &str = "default";

/// Whether the socket in play is the user's OWN tmux server rather than one of
/// tmuxy's.
pub fn on_users_own_server() -> bool {
    tmux_socket() == USERS_OWN_SOCKET
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {

    use super::*;

    #[test]
    fn managed_state_serde_roundtrips() {
        let state = ManagedState {
            theme: Some("dracula".into()),
            theme_mode: Some("dark".into()),
            cursor_blink: Some(false),
            use_tmux_conf: Some(true),
        };
        let json = serde_json::to_string(&state).unwrap();
        let parsed: ManagedState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.theme.as_deref(), Some("dracula"));
        assert_eq!(parsed.theme_mode.as_deref(), Some("dark"));
        assert_eq!(parsed.cursor_blink, Some(false));
        assert_eq!(parsed.use_tmux_conf, Some(true));

        // An older build's file has no such key; the choice is simply unmade.
        // `use_tmux_conf` unset must read as OFF rather than as "no opinion" —
        // sourcing someone's config is not a thing to start doing on an upgrade.
        let old: ManagedState = serde_json::from_str(r#"{"theme":"nord"}"#).unwrap();
        assert_eq!(old.cursor_blink, None);
        assert_eq!(old.use_tmux_conf, None);
        assert!(!old.use_tmux_conf.unwrap_or(false));
    }

    #[test]
    fn managed_state_skips_unset_fields_on_serialize() {
        let state = ManagedState::default();
        let json = serde_json::to_string(&state).unwrap();
        // Empty struct must not write nulls — older readers might choke on them.
        assert_eq!(json, "{}");
    }

    #[test]
    fn managed_state_commands_set_only_the_chosen_options() {
        assert!(managed_state_commands(&ManagedState::default()).is_empty());

        let state = ManagedState {
            theme: Some("tokyo night".into()),
            theme_mode: None,
            cursor_blink: Some(false),
            use_tmux_conf: Some(true),
        };
        assert_eq!(
            managed_state_commands(&state),
            vec![
                "set-option -g @tmuxy-theme 'tokyo night'".to_string(),
                "set-option -g @tmuxy-cursor-blink 'off'".to_string(),
            ]
        );
    }

    #[test]
    fn user_conf_template_points_at_a_relocated_config_dir() {
        let relocated = std::path::Path::new("/tmp/xdg/tmuxy");
        let conf = user_conf_template(relocated);
        assert!(conf.contains("source-file /tmp/xdg/tmuxy/tmuxy.defaults.conf"));
        assert!(!conf.contains("~/.config/tmuxy"));

        let default_dir = dirs::home_dir().unwrap().join(".config").join("tmuxy");
        assert_eq!(user_conf_template(&default_dir), DEFAULT_USER_CONF);
    }
}
