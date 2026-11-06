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

mod tmux_common;

struct Server(tmux_common::ScratchTmux);

impl std::ops::Deref for Server {
    type Target = tmux_common::ScratchTmux;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Server {
    fn start(name: &str) -> Self {
        let server = Self(tmux_common::ScratchTmux::start(
            &format!("pane-groups-{name}"),
            120,
            40,
        ));
        // The pair `session::server_command_env` publishes, with the
        // subcommand unset since `tmuxy-server` takes its verbs directly. A
        // shell inside the desktop app exports TMUXY_SERVER_SUBCOMMAND=server,
        // which this test's tmux server would hand to every hook, which would
        // then run `tmuxy-server server group close`, no command at all.
        server.tmux(&["set-environment", "-g", "TMUXY_SERVER_BIN", bin()]);
        server.tmux(&["set-environment", "-g", "-u", "TMUXY_SERVER_SUBCOMMAND"]);
        server
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tmuxy-cli/bin/tmuxy")
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
        assert!(hooks.contains("pane-group close"), "{hooks}");
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
        .arg(scripts_dir().join("pane-group"))
        .args(["join", &pane, &pane])
        .env("TMUX_SOCKET", &s.socket)
        .env("TMUXY_SERVER_BIN", bin())
        .env_remove("TMUXY_SERVER_SUBCOMMAND")
        .env_remove("TMUX")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "pane-group join: a pane cannot join itself"
    );

    let out = s.group(&["move", &pane, "0"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        format!("pane-group move: {pane} is not in a group")
    );

    let out = s.group(&["close", "not-a-pane"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "pane-group close: not a pane id: \"not-a-pane\""
    );
}

/// `all` gathers the tab into the anchor's group, in tab order; `ungroup`
/// brings every member back as a split in the tab and the group is gone.
#[test]
fn all_gathers_the_tab_and_ungroup_spreads_it_back() {
    let s = Server::start("all");
    let p1 = s.visible();
    let p2 = s.tmux(&["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", &p1]);
    let p3 = s.tmux(&["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", &p1]);

    s.ok(&["all", &p1]);
    let gid = s.option(&p1, "@tmuxy-group-id");
    assert!(!gid.is_empty());
    for pane in [&p2, &p3] {
        assert_eq!(s.option(pane, "@tmuxy-group-id"), gid, "{pane}");
        assert_eq!(s.session_of(pane), STASH, "{pane}");
    }
    assert_eq!(
        s.tmux(&["list-panes", "-t", "work:0", "-F", "#{pane_id}"]),
        p1
    );

    s.ok(&["ungroup", &p1]);
    let shown = s.tmux(&["list-panes", "-t", "work:0", "-F", "#{pane_id}"]);
    for pane in [&p1, &p2, &p3] {
        assert!(
            shown.lines().any(|p| p == pane.as_str()),
            "{pane} in {shown}"
        );
        assert_eq!(s.option(pane, "@tmuxy-group-id"), "", "{pane}");
    }

    // A pane in no group has nothing to spread.
    s.ok(&["ungroup", &p1]);
}
