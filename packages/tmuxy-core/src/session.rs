use std::process::Command;
use std::sync::{OnceLock, RwLock};

use crate::error::TmuxError;

mod assets;
mod config;

pub use assets::*;
pub use config::*;

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

/// The tmux server and session every tmux invocation targets: a socket (a
/// name, or a path when it contains a `/`), a session, and the ssh argv tail
/// of the host the server runs on — `None` for this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectTarget {
    pub socket: String,
    pub session: String,
    pub ssh: Option<String>,
}

/// The target set at runtime, when one has been.
///
/// A process normally serves one target for its whole life, read from the
/// environment (`TMUX_SOCKET`, `TMUXY_SESSION`, `TMUXY_SSH`) at launch — the
/// web server and the CLI never change it. The desktop app does: `tmuxy
/// connect` points a running app at another server, and that switch has to
/// be seen whole by every tmux invocation on every thread. Writing the three
/// environment variables one by one was neither — a command issued mid-switch
/// could pair the old socket with the new session, and `setenv` beside a
/// `getenv` on another thread is undefined behaviour — so the switch lands
/// here, in one write, and the resolvers below read it before the environment.
static CONNECT_TARGET: RwLock<Option<ConnectTarget>> = RwLock::new(None);

/// Point every later tmux invocation at `target`.
pub fn set_connect_target(target: ConnectTarget) {
    *CONNECT_TARGET
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(target);
}

/// The target [`set_connect_target`] installed, if any.
pub fn connect_target() -> Option<ConnectTarget> {
    CONNECT_TARGET
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Resolve the tmux socket: the [`connect_target`], else `TMUX_SOCKET` when
/// set and non-empty, otherwise the dedicated [`DEFAULT_TMUX_SOCKET`]. The
/// value is a socket *name* (tmux `-L`) unless it contains a `/`, in which
/// case it's a full socket *path* (tmux `-S`) — see [`tmux_socket_args`].
pub fn tmux_socket() -> String {
    if let Some(target) = connect_target() {
        return target.socket;
    }
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

/// The SSH tunnel tmuxy runs tmux through: the [`connect_target`]'s, else
/// `TMUXY_SSH`. When set and non-empty, every tmux invocation is wrapped as
/// `ssh <tail> tmux …` so the desktop app can attach its control-mode monitor
/// to a tmux server on a remote host. The value is a whitespace-separated ssh
/// argv *tail* — options plus the destination, e.g. `-p 2222 user@host` or
/// just `user@host`. Empty/unset means local (the normal case, and always the
/// case for the web server).
pub fn ssh_target() -> Option<Vec<String>> {
    let raw = match connect_target() {
        Some(target) => target.ssh,
        None => std::env::var("TMUXY_SSH").ok(),
    };
    ssh_argv(raw.as_deref())
}

/// An ssh argv tail split into arguments; `None` when there is nothing in it.
fn ssh_argv(raw: Option<&str>) -> Option<Vec<String>> {
    let tail = raw?.trim();
    (!tail.is_empty()).then(|| tail.split_whitespace().map(String::from).collect())
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
pub fn tmux_output(argv: &[String]) -> Result<String> {
    let failed = |message: String| TmuxError::Command {
        command: argv.join(" "),
        message,
    };
    let output = tmux_command()
        .args(argv)
        .output()
        .map_err(|e| failed(e.to_string()))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(failed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

/// Build the tmux shell command string with the socket flag for use in shell
/// invocations. Returns e.g. "/opt/homebrew/bin/tmux -L tmuxy", or when tunneled
/// "ssh user@host tmux -L tmuxy".
pub fn tmux_bin() -> String {
    tmux_argv(false).join(" ")
}

/// The session tmuxy targets: the [`connect_target`]'s, else `TMUXY_SESSION`,
/// else the default.
/// A `TMUXY_SESSION` that is not a safe name ([`is_safe_session_name`]) is
/// ignored: the name goes into command lines.
pub fn session_name() -> String {
    connect_target()
        .map(|target| target.session)
        .or_else(|| {
            std::env::var("TMUXY_SESSION")
                .ok()
                .filter(|s| is_safe_session_name(s))
        })
        .unwrap_or_else(|| crate::DEFAULT_SESSION_NAME.to_string())
}

/// Whether `dest` is an ssh destination and nothing more: `[user@]host`,
/// never an option. A `TMUXY_CONNECT_SSH` is written into the tmux server's
/// environment by anything that can reach it, and ssh runs a
/// `-oProxyCommand=…` as a local command.
pub fn is_ssh_destination(dest: &str) -> bool {
    let word = |s: &str, extra: &[u8]| {
        !s.is_empty()
            && s.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') || extra.contains(&b)
            })
    };
    if dest.starts_with('-') {
        return false;
    }
    match dest.split_once('@') {
        Some((user, host)) => word(user, b"") && word(host, b":") && !host.starts_with('-'),
        None => word(dest, b":"),
    }
}

/// Whether `socket` is a tmux socket name or path tmuxy will hand to tmux:
/// no whitespace, quotes or shell syntax, since over ssh it reaches the
/// remote shell as text.
pub fn is_safe_socket(socket: &str) -> bool {
    !socket.is_empty()
        && !socket.starts_with('-')
        && socket.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b'@' | b'+')
        })
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
    SessionName::parse(name).is_some()
}

/// A session name that passed [`is_safe_session_name`]: the only kind that
/// reaches a tmux command line. Made through [`SessionName::parse`] alone, so
/// a function taking one needs no check of its own.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionName(String);

impl SessionName {
    /// `name` as a session name, or `None` when it is outside the alphabet.
    pub fn parse(name: &str) -> Option<Self> {
        let safe = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'@' | b'+'));
        safe.then(|| Self(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::fmt::Display for SessionName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::ops::Deref for SessionName {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

/// Whether tmux has a session called `name`, from a read-only `has-session`.
pub fn session_exists(name: &SessionName) -> Result<bool> {
    let output = tmux_command()
        .args(["has-session", "-t", name.as_str()])
        .output()?;
    tracing::debug!(session = %name, exit = ?output.status.code(), "has-session");
    Ok(output.status.success())
}

/// How many sessions the server has, from a read-only `list-sessions`; zero
/// when there is no server to ask.
pub fn session_count() -> usize {
    tmux_command()
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map_or(0, |output| {
            String::from_utf8_lossy(&output.stdout).lines().count()
        })
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
mod tests;
