//! The verbs behind `tmuxy run`, `tmuxy tab create` and `tmuxy config init`
//! against a real tmux: what they print and exit with is the CLI's contract
//! (`tmuxy --help`), and the CLI scripts only forward to them.
//!
//! Needs a `tmux` binary; the socket name is unique per process, and no
//! control-mode client is attached.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::process::{Command, Output};

#[path = "../../tmuxy-core/tests/common/scratch.rs"]
mod scratch;

struct Server(scratch::ScratchServer);

impl std::ops::Deref for Server {
    type Target = scratch::ScratchServer;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Server {
    fn start(name: &str) -> Self {
        Self(scratch::ScratchServer::with_session(
            &format!("cli-verbs-{name}"),
            100,
            30,
        ))
    }

    fn pane(&self) -> String {
        self.tmux(&["display-message", "-p", "-t", "work:0", "#{pane_id}"])
    }

    fn verb(&self, args: &[&str]) -> Output {
        verb_in(&self.home, &self.socket, Some(&self.pane()), args)
    }
}

fn verb_in(home: &Path, socket: &str, pane: Option<&str>, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tmuxy-server"));
    command
        .args(args)
        .env("TMUX_SOCKET", socket)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("TMUXY_STATE_DIR", home.join("state"))
        .env_remove("TMUX")
        .env_remove("TMUXY_DATA_DIR")
        .env_remove("TMUX_PANE");
    if let Some(pane) = pane {
        command.env("TMUX_PANE", pane);
    }
    command.output().expect("tmuxy-server runs")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn run_relays_the_commands_output_and_status_and_refuses_what_it_does_not_pass_on() {
    let s = Server::start("run");
    let listed = s.verb(&["run", "--", "list-sessions", "-F", "#{session_name}"]);
    assert_eq!(listed.status.code(), Some(0), "{}", stderr(&listed));
    assert_eq!(stdout(&listed), "work\n");

    // One argument is the whole command; a format reaches tmux, not run-shell.
    let one = s.verb(&[
        "run",
        "--",
        r##"display-message -p "#{session_name} it's""##,
    ]);
    assert_eq!(stdout(&one), "work it's\n");

    let failed = s.verb(&["run", "--json", "--", "kill-session", "-t", "nope"]);
    assert_eq!(failed.status.code(), Some(1));
    let answer: serde_json::Value = serde_json::from_str(&stdout(&failed)).unwrap();
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["code"], 1);
    assert_eq!(answer["status"], 1);
    assert!(
        answer["error"].as_str().unwrap().contains("nope"),
        "{answer}"
    );

    let keys = s.verb(&["run", "--", "send-keys", "-t", "%0", "id", "Enter"]);
    assert_eq!(keys.status.code(), Some(1));
    assert!(stderr(&keys).contains("refused"), "{}", stderr(&keys));

    let resize = s.verb(&["run", "--json", "--", "resizew", "-x", "3"]);
    assert_eq!(resize.status.code(), Some(1));
    assert!(stdout(&resize).contains("resize-window is blocked"));

    let usage = s.verb(&["run", "--"]);
    assert_eq!(usage.status.code(), Some(2));
    assert!(stderr(&usage).contains("Usage: tmuxy run <tmux-command>"));
}

#[test]
fn a_new_tab_is_a_named_window_in_the_callers_session_and_new_window_makes_one() {
    let s = Server::start("tab");
    s.tmux(&["new-session", "-d", "-s", "other"]);
    let made = s.verb(&["new-tab", "--", "logs"]);
    assert_eq!(made.status.code(), Some(0), "{}", stderr(&made));
    let id = stdout(&made).trim().to_string();
    assert!(id.starts_with('@'), "{id}");
    assert_eq!(
        s.tmux(&[
            "display-message",
            "-p",
            "-t",
            &id,
            "#{session_name} #{window_name}"
        ]),
        "work logs"
    );

    let json = s.verb(&["new-tab", "--json", "--"]);
    let answer: serde_json::Value = serde_json::from_str(&stdout(&json)).unwrap();
    assert!(
        answer["tabId"].as_str().unwrap().starts_with('@'),
        "{answer}"
    );

    let intercepted = s.verb(&["run", "--", "new-window", "-n", "bar"]);
    assert_eq!(intercepted.status.code(), Some(0));
    assert!(stderr(&intercepted).contains("new-window intercepted"));
    let names = s.tmux(&["list-windows", "-t", "work", "-F", "#{window_name}"]);
    assert!(names.lines().any(|n| n == "bar"), "{names}");
}

#[test]
fn with_no_server_a_verb_says_so_and_exits_4() {
    let home = std::env::temp_dir().join(format!("tmuxy-cli-verbs-none-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let socket = format!("tmuxy-cli-verbs-none-{}", std::process::id());
    let out = verb_in(&home, &socket, None, &["run", "--", "list-panes"]);
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(out.status.code(), Some(4), "{}", stderr(&out));
    assert!(stderr(&out).contains("no tmux server on socket"));
}

/// The starter is comments only (tmuxy sources its own layers around it),
/// and a file already there — a dangling link included, a dotfiles checkout
/// not cloned yet — is never written over or through.
#[test]
fn config_init_writes_the_starter_once_and_never_through_a_link() {
    let home = std::env::temp_dir().join(format!("tmuxy-cli-verbs-init-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let socket = "tmuxy-cli-verbs-init-unused";
    let conf = home.join("config/tmuxy/tmuxy.conf");

    let made = verb_in(&home, socket, None, &["config", "init", "--json"]);
    assert_eq!(made.status.code(), Some(0), "{}", stderr(&made));
    let answer: serde_json::Value = serde_json::from_str(&stdout(&made)).unwrap();
    assert_eq!(answer["file"], conf.display().to_string());
    let starter = std::fs::read_to_string(&conf).unwrap();
    assert!(
        starter.contains("# tmuxy.conf: your overrides"),
        "{starter}"
    );
    assert!(starter
        .lines()
        .all(|l| l.trim().is_empty() || l.trim().starts_with('#')));

    std::fs::write(&conf, "set -g prefix C-Space\n").unwrap();
    let again = verb_in(&home, socket, None, &["config", "init"]);
    assert_eq!(again.status.code(), Some(1));
    assert!(stderr(&again).contains("already exists"));
    assert_eq!(
        std::fs::read_to_string(&conf).unwrap(),
        "set -g prefix C-Space\n"
    );

    std::fs::remove_file(&conf).unwrap();
    let target = home.join("dotfiles/tmuxy.conf");
    std::os::unix::fs::symlink(&target, &conf).unwrap();
    let linked = verb_in(&home, socket, None, &["config", "init"]);
    assert_eq!(linked.status.code(), Some(1));
    assert!(!target.exists());
    let _ = std::fs::remove_dir_all(&home);
}

/// A stand-in `ssh` that runs the remote command here (so "the host" is this
/// machine's tmux) and logs every call; `FAKE_SSH_FAIL` is a host that will
/// not let us in, `FAKE_SSH_LIST_FAIL` a tmux that cannot list its sessions.
fn fake_ssh(dir: &Path) -> String {
    let ssh = dir.join("ssh");
    std::fs::write(
        &ssh,
        r#"#!/bin/bash
echo "$*" >> "$FAKE_SSH_LOG"
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; --) shift; break ;; *) break ;; esac; done
shift
if [ -n "${FAKE_SSH_FAIL:-}" ]; then echo "Permission denied (publickey)." >&2; exit 255; fi
case "$*" in *list-sessions*) if [ -n "${FAKE_SSH_LIST_FAIL:-}" ]; then echo "$FAKE_SSH_LIST_FAIL" >&2; exit 1; fi ;; esac
exec sh -c "$*"
"#,
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    format!(
        "{}:{}",
        dir.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

fn session_connect(s: &Server, args: &[&str], env: &[(&str, &str)]) -> Output {
    let path = fake_ssh(&s.home);
    let mut command = Command::new(env!("CARGO_BIN_EXE_tmuxy-server"));
    command
        .arg("session-connect")
        .args(args)
        .env("TMUX_SOCKET", &s.socket)
        .env("HOME", &s.home)
        .env("XDG_CONFIG_HOME", s.home.join("config"))
        .env("XDG_DATA_HOME", s.home.join("data"))
        .env("TMUXY_STATE_DIR", s.home.join("state"))
        .env("PATH", path)
        .env("FAKE_SSH_LOG", s.home.join("ssh.log"))
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .env_remove("TMUXY_DATA_DIR")
        .stdin(std::process::Stdio::null());
    for (name, value) in env {
        command.env(name, value);
    }
    command.output().expect("tmuxy-server runs")
}

fn published(s: &Server) -> String {
    s.tmux(&["show-environment", "-g", "TMUXY_CONNECT"])
}

#[test]
fn session_connect_checks_the_host_stage_by_stage_then_saves_and_requests_it() {
    let s = Server::start("connect");
    s.tmux(&["new-session", "-d", "-s", "__tmuxy_stash"]);
    let out = session_connect(&s, &["ssh felipe@prod", "--socket", &s.socket], &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let lines: Vec<String> = stdout(&out).lines().map(String::from).collect();
    assert_eq!(lines[0], "✓ ssh felipe@prod");
    assert!(
        lines[1].starts_with("✓ tmux ")
            && lines[1].ends_with(&format!(" on the socket {}", s.socket))
    );
    assert_eq!(lines[2..], ["✓ listing sessions", "✓ attach"]);
    // The listing reached the remote shell quoted: its format is no comment.
    let request = published(&s);
    assert!(request.contains(r#""session":"work""#), "{request}");
    assert!(request.contains(r#""ssh":"felipe@prod""#), "{request}");
    let saved = std::fs::read_to_string(s.home.join("state/servers.json")).unwrap();
    assert!(saved.contains("felipe@prod"), "{saved}");
}

#[test]
fn a_stage_that_fails_prints_what_failed_and_requests_nothing() {
    let s = Server::start("connect-fail");
    let refused = session_connect(&s, &["badhost"], &[("FAKE_SSH_FAIL", "1")]);
    assert_eq!(refused.status.code(), Some(1));
    assert!(stderr(&refused).contains("✗ ssh badhost\nPermission denied (publickey)."));

    // A listing that fails for any reason but "no server yet" stops the flow.
    let listing = session_connect(
        &s,
        &["felipe@prod", "--json"],
        &[("FAKE_SSH_LIST_FAIL", "open terminal failed: not a terminal")],
    );
    assert_eq!(listing.status.code(), Some(1));
    let answer: serde_json::Value = serde_json::from_str(&stdout(&listing)).unwrap();
    assert_eq!(answer["ok"], false);
    assert!(answer["error"]
        .as_str()
        .unwrap()
        .starts_with("listing sessions: open terminal failed"));
    assert!(s
        .tmux(&["show-environment", "-g"])
        .lines()
        .all(|l| !l.starts_with("TMUXY_CONNECT=")));
}

/// ssh runs a ProxyCommand as a local command: an option where the host
/// goes is refused before ssh runs, as is a socket or session name tmuxy
/// will not put on a command line.
#[test]
fn a_destination_or_name_that_is_not_one_is_a_bad_command_line() {
    let s = Server::start("connect-bad");
    for args in [
        &["ssh -oProxyCommand=touch%20/tmp/owned"][..],
        &[" -oProxyCommand=id"],
        &["host;id"],
        &["a b"],
        &["localhost", "--socket", "../escape"],
        &["felipe@prod", "--socket", "sock;id"],
        &["felipe@prod", "--session", "x;y"],
    ] {
        let out = session_connect(&s, args, &[]);
        assert_eq!(out.status.code(), Some(2), "{args:?}: {}", stderr(&out));
    }
    assert!(!s.home.join("ssh.log").exists(), "ssh ran");
}

/// Any local socket is listed, not only the one this tmuxy serves: its first
/// session is attached when none is named.
#[test]
fn a_local_socket_of_its_own_is_listed_too() {
    let s = Server::start("connect-local");
    let other = Server::start("connect-other");
    other.tmux(&["rename-session", "-t", "work", "dev"]);
    let out = session_connect(&s, &["localhost", "--socket", &other.socket], &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(stdout(&out).starts_with("✓ localhost\n"));
    assert!(published(&s).contains(r#""session":"dev""#));
}

#[test]
fn connect_requests_the_first_session_of_the_socket_or_tmuxy() {
    let s = Server::start("reconnect");
    let other = Server::start("reconnect-other");
    let out = s.verb(&["connect", "--socket", &other.socket]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(stdout(&out).contains(&format!("socket '{}' (session 'work')", other.socket)));

    let none = s.verb(&["connect", "--json", "--socket", "tmuxy-cli-verbs-nobody"]);
    let answer: serde_json::Value = serde_json::from_str(&stdout(&none)).unwrap();
    assert_eq!(answer["session"], "tmuxy");

    // A socket tmux answers about with an error other than "no server" is a
    // failure, never a request for a `tmuxy` session that may not be there.
    let tmux = s.home.join("mismatched-tmux");
    std::fs::write(
        &tmux,
        format!(
            "#!/bin/sh\ncase \"$*\" in *{}*) echo 'protocol version mismatch (client 8, server 7)' >&2; exit 1 ;; esac\nexec {} \"$@\"\n",
            other.socket,
            tmuxy_core::session::tmux_path()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&tmux, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_tmuxy-server"));
    let mismatched = command
        .args(["connect", "--json", "--socket", &other.socket])
        .env("TMUX_BIN", &tmux)
        .env("TMUX_SOCKET", &s.socket)
        .env("HOME", &s.home)
        .env("TMUXY_STATE_DIR", s.home.join("state"))
        .env_remove("TMUX")
        .output()
        .unwrap();
    assert_eq!(mismatched.status.code(), Some(1), "{}", stdout(&mismatched));
    let answer: serde_json::Value = serde_json::from_str(&stdout(&mismatched)).unwrap();
    assert_eq!(
        answer["error"],
        "listing sessions: protocol version mismatch (client 8, server 7)"
    );

    let bad = s.verb(&["connect", "--socket", "../x"]);
    assert_eq!(bad.status.code(), Some(2));
}

/// Piped into `head`, a verb ends when the reader does, as a shell tool
/// does: killed by SIGPIPE, saying nothing. It panicked on its next write.
#[cfg(unix)]
#[test]
fn a_verb_whose_reader_is_gone_ends_quietly() {
    use std::os::unix::process::ExitStatusExt;

    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    let out = Command::new(env!("CARGO_BIN_EXE_tmuxy-server"))
        .arg("skill")
        .stdout(writer)
        .output()
        .expect("tmuxy-server runs");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "");
    assert_eq!(out.status.signal(), Some(libc::SIGPIPE));
}
