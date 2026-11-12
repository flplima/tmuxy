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
    // The read never starts a server to answer.
    let idle = tmuxy_core::session::local_tmux_on(&server.socket)
        .args(["-N", "list-sessions"])
        .output()
        .unwrap();
    assert!(!idle.status.success());

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
/// One bound while the server ran (a plugin manager's, a `bind` typed at the
/// prompt) is neither tmux's nor a file's, and says so.
#[test]
fn a_running_server_adds_what_tmux_binds_by_itself() {
    let server = scratch::ScratchServer::with_session("keymap-live", 80, 24);
    server.tmux(&[
        "bind-key",
        "-T",
        "prefix",
        "F8",
        "display-message",
        "made at the prompt",
    ]);
    let out = keymap(&server.home, &server.socket, &["--table", "prefix", "F8"]);
    let made = text(&out).0;
    let bound = row(&made, "prefix", "F8").unwrap_or_else(|| panic!("{made}"));
    assert!(bound.contains("set while running"), "{bound}");
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

/// The user's own plugin (`tmuxy-plugin.toml`): its keys are listed as its,
/// one a file of theirs already binds is said to be held (their bindings
/// always win), and its actions and verbs are listed with the keys that run
/// them.
#[test]
fn keymap_lists_the_users_own_plugin_and_the_keys_it_could_not_have() {
    let server = scratch::ScratchServer::new("keymap-plugin");
    let home = &server.home;
    let config = home.join("config/tmuxy");
    std::fs::create_dir_all(config.join("bin")).unwrap();
    std::fs::write(config.join("tmuxy.conf"), "bind M-u display-message mine\n").unwrap();
    let script = config.join("bin/hello");
    std::fs::write(&script, "#!/bin/sh\necho hello\n").unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::write(
        config.join("tmuxy-plugin.toml"),
        r#"[plugin]
api = 1
name = "user"
version = "0.1.0"

[[actions]]
id = "hello"
title = "Say hello"
menu = "pane"
surface = "popup"
command = ["bin/hello"]

[[actions]]
id = "taken"
title = "Wants a held key"
surface = "popup"
command = ["bin/hello"]

[[cli]]
verb = "hello"
description = "Say hello in your shell"
command = ["bin/hello"]

[[keys]]
key = "M-h"
action = "hello"

[[keys]]
key = "M-u"
action = "taken"
"#,
    )
    .unwrap();

    let out = keymap(home, &server.socket, &[]);
    let (stdout, stderr) = text(&out);
    assert_eq!(out.status.code(), Some(0), "{stderr}");
    let key = row(&stdout, "prefix", "M-h").unwrap_or_else(|| panic!("{stdout}"));
    assert!(key.contains("plugin user"), "{key}");
    assert!(key.ends_with("plugin action user:hello"), "{key}");
    let held = row(&stdout, "prefix", "M-u").unwrap();
    assert!(held.contains("~/config/tmuxy/tmuxy.conf:1"), "{held}");
    assert!(stdout.contains(
        "Plugin keys not bound, held by something else:\n  prefix M-u  user:taken  held by ~/config/tmuxy/tmuxy.conf:1\n"
    ), "{stdout}");
    assert!(stdout.contains("Your actions and verbs (~/config/tmuxy/tmuxy-plugin.toml):\n"));
    assert!(
        stdout.contains("  action  hello  Say hello  (pane menu, popup)  key prefix M-h\n"),
        "{stdout}"
    );
    assert!(
        stdout.contains("  action  taken  Wants a held key  (popup)  key prefix M-u\n"),
        "{stdout}"
    );
    assert!(
        stdout.contains("  verb    tmuxy plugin hello  Say hello in your shell\n"),
        "{stdout}"
    );

    let out = keymap(home, &server.socket, &["--json"]);
    let answer: serde_json::Value = serde_json::from_str(&text(&out).0).unwrap();
    assert_eq!(answer["plugins"]["user"]["verbs"][0]["verb"], "hello");
    assert_eq!(answer["plugins"]["skipped"][0]["key"], "M-u");
    assert_eq!(
        answer["plugins"]["skipped"][0]["heldBy"]["layer"],
        "user-conf"
    );
}
