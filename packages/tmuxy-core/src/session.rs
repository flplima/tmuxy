use std::process::Command;
use std::sync::{OnceLock, RwLock};

use crate::error::TmuxError;

mod assets;
mod check;
mod config;
mod doctor;
pub mod keymap;
mod launcher;
#[cfg(feature = "native")]
pub mod scoped;
mod state;

pub use assets::*;
pub use check::*;
pub use config::*;
pub use doctor::*;
pub use launcher::*;
pub use state::*;

type Result<T> = std::result::Result<T, TmuxError>;

static TMUX_PATH: OnceLock<String> = OnceLock::new();

/// macOS GUI apps (.app bundles) inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// that excludes Homebrew, MacPorts and Nix, so the desktop app launched from
/// Finder/Spotlight would not find tmux without the explicit candidates.
fn find_tmux() -> String {
    if let Ok(path) = std::env::var(TMUX_BIN_ENV) {
        if std::path::Path::new(&path).exists() {
            return path;
        }
    }

    if let Ok(output) = Command::new("which").arg("tmux").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

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

    "tmux".to_string()
}

pub fn tmux_path() -> &'static str {
    TMUX_PATH.get_or_init(find_tmux)
}

/// The tmux socket of a **released build** when `TMUX_SOCKET` is unset, kept
/// apart from the user's own sessions on the default socket. The dev server
/// and the tests set `TMUX_SOCKET` to `tmuxy-dev` and `tmuxy-test`.
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
/// Otherwise the target comes from the environment (`TMUX_SOCKET`,
/// `TMUXY_SESSION`, `TMUXY_SSH`). The desktop app's `tmuxy connect` switches
/// a running app to another server, which every thread must see whole:
/// writing the three variables one by one could pair the old socket with the
/// new session, and `setenv` beside a `getenv` on another thread is undefined
/// behaviour.
static CONNECT_TARGET: RwLock<Option<ConnectTarget>> = RwLock::new(None);

/// Point every later tmux invocation at `target`.
pub fn set_connect_target(target: ConnectTarget) {
    *CONNECT_TARGET
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(target);
}

/// The target a tmux invocation resolves: the calling task's own when it
/// runs for a window that chose one ([`scoped`]), else the one
/// [`set_connect_target`] installed, if any.
pub fn connect_target() -> Option<ConnectTarget> {
    #[cfg(feature = "native")]
    if let Some(target) = scoped::task_target() {
        return Some(target);
    }
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

/// Whether `socket` is a socket's path (tmux `-S`) rather than a name in
/// tmux's socket directory (`-L`): it contains a `/`.
pub fn is_socket_path(socket: &str) -> bool {
    socket.contains('/')
}

/// `["-L", <name>]`, or `["-S", <path>]` for a [`is_socket_path`].
/// Passing the flag always also overrides an inherited `$TMUX`, so tmuxy
/// launched from inside a tmux pane never talks to that pane's server.
pub fn socket_args(socket: &str) -> [&str; 2] {
    [if is_socket_path(socket) { "-S" } else { "-L" }, socket]
}

/// [`socket_args`] for the [`tmux_socket`].
pub fn tmux_socket_args() -> [String; 2] {
    socket_args(&tmux_socket()).map(String::from)
}

/// The local tmux on `socket`, whatever the [`connect_target`] says: for a
/// look at a server other than the one tmuxy is attached to.
pub fn local_tmux_on(socket: &str) -> Command {
    let mut command = Command::new(tmux_path());
    command.args(socket_args(socket));
    command
}

/// The SSH tunnel tmuxy runs tmux through: the [`connect_target`]'s, else
/// `TMUXY_SSH`, a whitespace-separated ssh argv *tail* (options plus the
/// destination, e.g. `-p 2222 user@host`). Every tmux invocation is then
/// wrapped as `ssh <tail> tmux …`. `None`: local.
pub fn ssh_target() -> Option<Vec<String>> {
    let raw = match connect_target() {
        Some(target) => target.ssh,
        None => std::env::var("TMUXY_SSH").ok(),
    };
    ssh_argv(raw.as_deref())
}

fn ssh_argv(raw: Option<&str>) -> Option<Vec<String>> {
    let tail = raw?.trim();
    (!tail.is_empty()).then(|| tail.split_whitespace().map(String::from).collect())
}

/// The argv to invoke tmux, through the [`ssh_target`] if any. `pty` makes
/// the ssh hop allocate a remote tty (`-tt`): required for `-CC` control mode,
/// harmful for one-off reads (it echoes CRs into captured output). The remote
/// tmux is a bare `tmux`, resolved by the remote login shell's PATH.
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

/// A tmux `Command` for one-off reads and writes (no remote tty).
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

/// What tmux says when there is no server to talk to: none running on the
/// socket, or a socket file that is gone. Generated into the CLI's `_options`
/// for its `_no_server_in` (`tmuxy-cli/bin/tmuxy/_contract`).
pub const NO_SERVER_SIGNS: [&str; 2] = ["no server running", "error connecting to"];

/// Whether what tmux said is one of the [`NO_SERVER_SIGNS`].
pub fn is_no_server(message: &str) -> bool {
    NO_SERVER_SIGNS.iter().any(|sign| message.contains(sign))
}

/// tmux on tmuxy's server, as a shell command line: what a job `run-shell`
/// starts calls to reach the server that started it.
pub fn tmux_shell_line() -> String {
    let [flag, socket] = tmux_socket_args();
    crate::argv::shell_line(&[tmux_path(), &flag, &socket])
}

/// [`tmux_argv`] joined with spaces, e.g. `ssh user@host tmux -L tmuxy`.
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

/// Whether `dest` is an ssh destination and nothing more: `[user@]host`, a
/// port after a colon allowed ([`split_ssh_port`]), never an option. A
/// connect request's host is written into the tmux server's environment by
/// anything that reaches it, and ssh runs a `-oProxyCommand=…` as a local
/// command.
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

/// `dest` without the port its last `:` names, and that port: ssh takes no
/// port in a destination, so a `host:2222` reaches it as `-p 2222 host`. A
/// colon that is part of the host (an IPv6 address) or followed by no port
/// number leaves the destination whole.
pub fn split_ssh_port(dest: &str) -> (&str, Option<u16>) {
    match dest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => match port.parse() {
            Ok(port) => (host, Some(port)),
            Err(_) => (dest, None),
        },
        _ => (dest, None),
    }
}

/// Whether `socket` is a tmux socket name or path tmuxy will hand to tmux:
/// no whitespace, quotes or shell syntax, since over ssh it reaches the
/// remote shell as text.
pub fn is_safe_socket(socket: &str) -> bool {
    !socket.is_empty()
        && !socket.starts_with('-')
        && !socket.contains("..")
        && (!is_socket_path(socket) || socket.starts_with('/'))
        && socket.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b'@' | b'+')
        })
}

/// Whether `name` is a session name the server will write into a command line.
///
/// A client names its session in `?session=`, and that name goes into
/// control-mode commands and into `run-shell` strings that tmux format-expands
/// before a shell sees them. Rather than escape for each context, the name is
/// held to letters, digits and `_ - @ +`: tmux forbids `.` and `:` anyway, and
/// nothing in the alphabet means anything to a format string, a shell or a
/// command parser.
pub fn is_safe_session_name(name: &str) -> bool {
    SessionName::parse(name).is_some()
}

/// A session name that passed [`is_safe_session_name`]: the only kind that
/// reaches a tmux command line. Made through [`SessionName::parse`] alone, so
/// a function taking one needs no check of its own.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionName(String);

impl SessionName {
    pub fn parse(name: &str) -> Option<Self> {
        let safe = !name.is_empty()
            && !name.starts_with('-')
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

/// `name` as a `-t` target that matches that session alone. A bare name also
/// matches a session it is a unique prefix of (tmux's `cmd-find.c`), so
/// `work` with only `workbench` running would find `workbench`; `=` asks for
/// the exact name.
pub fn exact_session_target(name: &str) -> String {
    format!("={name}")
}

/// Whether tmux has a session called exactly `name`, from a read-only
/// `has-session`.
pub fn session_exists(name: &SessionName) -> Result<bool> {
    let output = tmux_command()
        .args(["has-session", "-t", &exact_session_target(name)])
        .output()?;
    tracing::debug!(session = %name, exit = ?output.status.code(), "has-session");
    Ok(output.status.success())
}

/// [`session_exists`] as every tmuxy caller answers it: a name outside the
/// session alphabet names no session, and a tmux that cannot be asked at all
/// is taken to have it — a snapshot is restored, and a session created, only
/// for one known to be gone, never on a guess.
pub fn session_known(name: &str) -> bool {
    SessionName::parse(name).is_some_and(|name| session_exists(&name).unwrap_or(true))
}

/// Names of every session the tmux server currently holds, from a read-only
/// `list-sessions`; empty when there is no server to ask.
pub fn session_names() -> Vec<String> {
    tmux_command()
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map_or_else(Vec::new, |output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
}

/// The socket name tmux itself uses when nobody says otherwise: the server a
/// person's own `tmux` command talks to.
pub const USERS_OWN_SOCKET: &str = "default";

/// Whether `socket` is the user's own server: that name, or the path of
/// the socket file with that name in one of tmux's socket directories
/// (`TMUX_SOCKET=/tmp/tmux-1000/default` reaches the same server).
pub fn is_users_own_socket(socket: &str, socket_dirs: &[std::path::PathBuf]) -> bool {
    if !is_socket_path(socket) {
        return socket == USERS_OWN_SOCKET;
    }
    let path = std::path::Path::new(socket);
    path.file_name()
        .is_some_and(|name| name == USERS_OWN_SOCKET)
        && path.parent().is_some_and(|dir| {
            let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
            socket_dirs.contains(&dir)
        })
}

pub fn on_users_own_server() -> bool {
    let socket = tmux_socket();
    if !is_socket_path(&socket) {
        return socket == USERS_OWN_SOCKET;
    }
    is_users_own_socket(&socket, &tmux_socket_dirs())
}

/// Candidate `tmux-<uid>` directories owned/readable by the current user.
pub fn tmux_socket_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(custom) = std::env::var("TMUXY_SOCKET_DIR") {
        let p = std::path::PathBuf::from(custom);
        if p.is_dir() {
            dirs.push(std::fs::canonicalize(&p).unwrap_or(p));
            return dirs;
        }
    }
    let mut roots = Vec::new();
    if let Ok(tmpdir) = std::env::var("TMUX_TMPDIR") {
        if !tmpdir.is_empty() {
            roots.push(std::path::PathBuf::from(tmpdir));
        }
    }
    roots.push(std::path::PathBuf::from("/tmp"));
    roots.push(std::path::PathBuf::from("/private/tmp"));

    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            if !name_str.starts_with("tmux-") {
                continue;
            }
            let path = entry.path();
            // Tmux creates `tmux-$UID` mode 0700, so `read_dir` succeeds only
            // for the current user's socket directory. Canonicalize so `/tmp`
            // and `/private/tmp` on macOS do not scan the same directory twice.
            if std::fs::read_dir(&path).is_ok() {
                let canonical = std::fs::canonicalize(&path).unwrap_or(path);
                if !dirs.contains(&canonical) {
                    dirs.push(canonical);
                }
            }
        }
    }
    dirs
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tests_check;
#[cfg(test)]
mod tests_doctor;
#[cfg(test)]
mod tests_keymap;
#[cfg(test)]
mod tests_layout;
#[cfg(test)]
mod tests_own_socket;
#[cfg(test)]
mod tests_state;
