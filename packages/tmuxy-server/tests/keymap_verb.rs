//! `tmuxy keymap` as the server binary answers it, against a real tmux: the
//! file and line of each binding, the user's replacements, and the bindings
//! tmux makes by itself when a server answers.
//!
//! Needs a `tmux` binary. The server is a scratch one of the test's own; its
//! config is tmux's alone (`-f /dev/null`), so what it lists beyond tmux's
//! defaults is what the test bound there.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;
use std::process::{Command, Output};

#[path = "../../tmuxy-core/tests/common/scratch.rs"]
mod scratch;

/// The keymap verb with `home` as the user's home and `socket` as tmuxy's,
/// and nothing of a live tmux session in its environment.
fn keymap(home: &Path, socket: &str, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_tmuxy-server"))
        .arg("keymap")
        .args(args)
        .env("TMUX_SOCKET", socket)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("TMUXY_STATE_DIR", home.join("state"))
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .env_remove("TMUXY_DATA_DIR")
        .output()
        .expect("tmuxy-server runs")
}

fn text(out: &Output) -> (String, String) {
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// The line of `text` whose first two columns are `table` and `key`.
fn row<'a>(text: &'a str, table: &str, key: &str) -> Option<&'a str> {
    text.lines().find(|line| {
        let mut words = line.split_whitespace();
        words.next() == Some(table) && words.next() == Some(key)
    })
}

/// The promise of the task: `tmuxy keymap` shows where `prefix t` comes
/// from, and a line of the user's that replaces a default says so, with the
/// default it replaced.
#[test]
fn keymap_says_where_a_key_comes_from_and_what_the_users_file_replaced() {
    let server = scratch::ScratchServer::new("keymap-files");
    let home = &server.home;
    let conf = home.join("config/tmuxy/tmuxy.conf");
    std::fs::create_dir_all(conf.parent().unwrap()).unwrap();
    std::fs::write(
        &conf,
        "# mine\nbind c new-window\nset -g prefix C-Space\nbind -n C-Space display-message x\n",
    )
    .unwrap();

    // No server on this socket: the files alone.
    let out = keymap(home, &server.socket, &[]);
    let (stdout, stderr) = text(&out);
    assert_eq!(out.status.code(), Some(0), "{stderr}");
    let tab = row(&stdout, "prefix", "t").unwrap_or_else(|| panic!("{stdout}"));
    assert!(tab.contains("tmuxy.defaults.conf:"), "{tab}");
    assert!(tab.ends_with("switch-client -T tab"), "{tab}");
    let mine = row(&stdout, "prefix", "c").unwrap();
    assert!(mine.contains("~/config/tmuxy/tmuxy.conf:2"), "{mine}");
    assert!(stdout.starts_with("Prefix: C-Space  (~/config/tmuxy/tmuxy.conf:3)"));
    assert!(stdout.contains("Replaced by a later line:"));
    assert!(
        stdout.contains("rebound at ~/config/tmuxy/tmuxy.conf:2"),
        "{stdout}"
    );
    assert!(
        stdout.contains("C-Space is the prefix (~/config/tmuxy/tmuxy.conf:3)"),
        "{stdout}"
    );
    assert!(stdout.contains("No tmux server answered"));

    // One key, as JSON: the full path and the line.
    let out = keymap(home, &server.socket, &["--table", "prefix", "t", "--json"]);
    let answer: serde_json::Value = serde_json::from_str(&text(&out).0).unwrap();
    assert_eq!(answer["ok"], true);
    let bindings = answer["bindings"].as_array().unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0]["source"]["layer"], "defaults");
    assert!(bindings[0]["source"]["file"]
        .as_str()
        .unwrap()
        .ends_with("tmuxy.defaults.conf"));
    assert!(bindings[0]["source"]["line"].as_u64().unwrap() > 0);
    assert_eq!(answer["serverRead"], false);

    let none = keymap(home, &server.socket, &["--table", "prefix", "F11"]);
    assert_eq!(none.status.code(), Some(1));
    assert!(text(&none)
        .1
        .contains("nothing binds F11 in the prefix table"));
}

/// tmux's own bindings are in no file: listed as tmux's, from the server.
#[test]
fn a_running_server_adds_what_tmux_binds_by_itself() {
    let server = scratch::ScratchServer::with_session("keymap-live", 80, 24);
    let out = keymap(&server.home, &server.socket, &["--table", "prefix"]);
    let (stdout, stderr) = text(&out);
    assert_eq!(out.status.code(), Some(0), "{stderr}");
    let detach = row(&stdout, "prefix", "d").unwrap_or_else(|| panic!("{stdout}"));
    assert!(detach.contains(" tmux "), "{detach}");
    assert!(detach.ends_with("detach-client"), "{detach}");
    assert!(!stdout.contains("No tmux server answered"));
    // The files still say where theirs come from.
    assert!(row(&stdout, "prefix", "t")
        .unwrap()
        .contains("tmuxy.defaults.conf:"));
}
