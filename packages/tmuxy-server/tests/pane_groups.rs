//! `tmuxy-server group <verb>` against a real tmux: the commands
//! `tmuxy_core::groups` plans have to do what the plans say, in tmux's own
//! terms — a member parked in the stash session, a swap that brings it back,
//! the `pane-died` hook that promotes a sibling when a member exits by itself.
//!
//! Needs a `tmux` binary; the socket name is unique per process, and no
//! control-mode client is attached, so the binary's tmux calls are as safe
//! here as they are inside `run-shell`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

const STASH: &str = "__tmuxy_stash";

struct Server {
    socket: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = Command::new("tmux")
            .args(["-L", &self.socket, "kill-server"])
            .output();
    }
}

impl Server {
    fn start(name: &str) -> Self {
        let server = Self {
            socket: format!("tmuxy-pane-groups-{name}-{}", std::process::id()),
        };
        server.tmux(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "work",
            "-x",
            "120",
            "-y",
            "40",
        ]);
        // What a monitor publishes on attach, for the hook's run-shell.
        server.tmux(&["set-environment", "-g", "TMUXY_SERVER_BIN", bin()]);
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

    fn group(&self, args: &[&str]) -> Output {
        Command::new(bin())
            .arg("group")
            .args(args)
            .env("TMUX_SOCKET", &self.socket)
            .env("TMUXY_SCRIPTS_DIR", scripts_dir())
            .env_remove("TMUX")
            .output()
            .expect("tmuxy-server runs")
    }

    fn ok(&self, args: &[&str]) -> String {
        let out = self.group(args);
        assert!(
            out.status.success(),
            "group {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// The active pane of the group's window (window 0 of `work`; a member
    /// leaving as a tab becomes another window).
    fn visible(&self) -> String {
        self.tmux(&["display-message", "-p", "-t", "work:0", "#{pane_id}"])
    }

    fn option(&self, pane: &str, name: &str) -> String {
        self.tmux(&["show-options", "-pqv", "-t", pane, name])
    }

    fn session_of(&self, pane: &str) -> String {
        self.tmux(&["display-message", "-p", "-t", pane, "#{session_name}"])
    }

    /// Wait for `check` to hold — the hook path runs on tmux's schedule.
    fn eventually(&self, what: &str, check: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !check() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_tmuxy-server")
}

fn scripts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bin/tmuxy")
}

#[test]
fn a_group_lives_its_whole_life_through_the_group_verb() {
    let s = Server::start("life");
    let p1 = s.visible();

    // add: p1 opens a group named after it; the new pane takes its slot and
    // p1 is parked in the stash, both armed.
    s.ok(&["add", &p1, "120", "40"]);
    let p2 = s.visible();
    assert_ne!(p2, p1);
    let gid = format!("g{}", &p1[1..]);
    assert_eq!(s.option(&p1, "@tmuxy-group-id"), gid);
    assert_eq!(s.option(&p2, "@tmuxy-group-id"), gid);
    assert_eq!(s.session_of(&p1), STASH);
    for pane in [&p1, &p2] {
        assert_eq!(s.option(pane, "remain-on-exit"), "on");
        let hooks = s.tmux(&["show-hooks", "-p", "-t", pane]);
        assert!(hooks.contains("pane-group-close"), "{hooks}");
    }

    s.ok(&["add", &p2, "120", "40"]);
    let p3 = s.visible();

    // next/prev wrap through the order p1, p2, p3.
    s.ok(&["next", &p3]);
    assert_eq!(s.visible(), p1);
    s.ok(&["prev", &p1]);
    assert_eq!(s.visible(), p3);
    // Without wrapping there is nothing after the last member.
    assert_eq!(s.group(&["next", "--no-wrap", &p3]).status.code(), Some(3));
    s.ok(&["prev", "--no-wrap", &p3]);
    assert_eq!(s.visible(), p2);

    // move: every member's place is written.
    s.ok(&["move", &p3, "0"]);
    assert_eq!(s.option(&p3, "@tmuxy-group-pos"), "0");
    assert_eq!(s.option(&p1, "@tmuxy-group-pos"), "1");
    assert_eq!(s.option(&p2, "@tmuxy-group-pos"), "2");

    // join: a loose pane split beside the slot becomes a parked member.
    let p4 = s.tmux(&["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", &p2]);
    s.ok(&["join", &p4, &p2, "1"]);
    assert_eq!(s.option(&p4, "@tmuxy-group-id"), gid);
    assert_eq!(s.session_of(&p4), STASH);
    assert_eq!(s.option(&p4, "@tmuxy-group-pos"), "1");

    // leave --tab: a tab of its own in the group's session, ungrouped.
    s.ok(&["leave", &p4, "--tab"]);
    assert_eq!(s.session_of(&p4), "work");
    assert_eq!(s.option(&p4, "@tmuxy-group-id"), "");
    assert_eq!(s.option(&p4, "remain-on-exit"), "");

    // switch, then close the member on screen: the next in order takes over.
    s.ok(&["switch", &p3]);
    assert_eq!(s.visible(), p3);
    s.ok(&["close", &p3]);
    assert_eq!(s.visible(), p1);

    // A member that exits by itself goes through the same close, by its hook.
    s.tmux(&["respawn-pane", "-k", "-t", &p1, "true"]);
    s.eventually("the hook to promote p2", || s.visible() == p2);

    // Down to one member: no group any more.
    assert_eq!(s.option(&p2, "@tmuxy-group-id"), "");
    assert_eq!(s.option(&p2, "remain-on-exit"), "");
}

#[test]
fn park_brings_a_member_back_out_of_view_and_prints_it() {
    let s = Server::start("park");
    let anchor = s.visible();
    s.tmux(&["set-option", "-p", "-t", &anchor, "@tmuxy-group-id", "g7"]);
    let parked = s.ok(&["park", "work:0.0", "g7", "/tmp", "1"]);
    assert!(parked.starts_with('%'), "{parked}");
    assert_eq!(s.session_of(&parked), STASH);
    assert_eq!(s.option(&parked, "@tmuxy-group-id"), "g7");
    assert_eq!(s.option(&parked, "@tmuxy-group-pos"), "1");
    assert_eq!(s.option(&anchor, "remain-on-exit"), "on");
    assert_eq!(s.visible(), anchor);
}

#[test]
fn the_scripts_reach_the_verb_and_keep_its_refusals() {
    let s = Server::start("refusals");
    let pane = s.visible();
    let out = Command::new("bash")
        .arg(scripts_dir().join("pane-group-join"))
        .args([&pane, &pane])
        .env("TMUX_SOCKET", &s.socket)
        .env("TMUXY_SERVER_BIN", bin())
        .env_remove("TMUXY_SERVER_SUBCOMMAND")
        .env_remove("TMUX")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "pane-group-join: a pane cannot join itself"
    );

    let out = s.group(&["move", &pane, "0"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        format!("pane-group-move: {pane} is not in a group")
    );

    let out = s.group(&["close", "not-a-pane"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "pane-group-close: not a pane id: \"not-a-pane\""
    );
}
