//! The verbs behind `tmuxy run`, `tmuxy tab create` and `tmuxy config init`
//! against a real tmux: what they print and exit with is the CLI's contract
//! (`tmuxy --help`), and the CLI scripts only forward to them.
//!
//! Needs a `tmux` binary; the socket name is unique per process, and no
//! control-mode client is attached.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Server {
    socket: String,
    home: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = Command::new("tmux")
            .args(["-L", &self.socket, "kill-server"])
            .output();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

impl Server {
    fn start(name: &str) -> Self {
        let socket = format!("tmuxy-cli-verbs-{name}-{}", std::process::id());
        let home = std::env::temp_dir().join(&socket);
        std::fs::create_dir_all(&home).unwrap();
        let server = Self { socket, home };
        server.tmux(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "work",
            "-x",
            "100",
            "-y",
            "30",
        ]);
        server
    }

    fn tmux(&self, args: &[&str]) -> String {
        let out = Command::new("tmux")
            .args(["-L", &self.socket])
            .args(args)
            .output()
            .expect("tmux runs");
        assert!(
            out.status.success(),
            "tmux {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
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
