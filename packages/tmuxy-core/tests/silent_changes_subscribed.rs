//! What tmux changes without a notification reaches a control client anyway,
//! through the subscriptions the monitor sets at attach: a pane marked, a
//! pane's or a window's tmuxy option, the session's focus request. The write
//! goes through the client like any command, and the subscription is polled,
//! so it is reported whoever wrote it: the CLI in a shell pane, a plugin.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::io::{BufRead as _, Write as _};
use std::time::{Duration, Instant};

use tmuxy_core::constants::tmux_formats::{
    relists_windows, subscribe_pane_titles_command, subscribe_session_meta_command,
    subscribe_window_meta_command, PANE_TITLE_SUBSCRIPTION_NAME,
};
use tmuxy_core::control_mode::{ControlModeEvent, Parser};

/// What the subscriptions report after `write`, until `wanted` is seen or
/// ten seconds pass (tmux polls once a second; the bound is only for a
/// subscription that never fires, which fails).
fn reported_after(
    label: &str,
    write: &str,
    wanted: impl Fn(&ControlModeEvent) -> bool,
) -> Duration {
    let server = common::ScratchServer::new(label);
    server.tmux(&[
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "sub",
        "-x",
        "80",
        "-y",
        "24",
    ]);
    let mut client = tmuxy_core::session::local_tmux_on(&server.socket)
        .args(["-C", "attach", "-t", "sub"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let stdout = client.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let input = client.stdin.as_mut().unwrap();
    for command in [
        subscribe_pane_titles_command(),
        subscribe_window_meta_command(),
        subscribe_session_meta_command(),
    ] {
        writeln!(input, "{command}").unwrap();
    }
    // The first report of each subscription is its starting value: read
    // past them, a second's polling after the last one.
    let mut parser = Parser::new();
    let mut quiet_since = Instant::now();
    while quiet_since.elapsed() < Duration::from_millis(2500) {
        if let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
            if parser.parse_line(&line).is_some_and(|e| {
                matches!(
                    e,
                    ControlModeEvent::SubscriptionChanged { .. }
                        | ControlModeEvent::SessionSubscriptionChanged { .. }
                )
            }) {
                quiet_since = Instant::now();
            }
        }
    }
    writeln!(input, "{write}").unwrap();
    let written = Instant::now();
    let seen = loop {
        assert!(
            written.elapsed() < Duration::from_secs(10),
            "{write}: never reported"
        );
        let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        if parser.parse_line(&line).is_some_and(|e| wanted(&e)) {
            break written.elapsed();
        }
    };
    let _ = writeln!(input, "detach");
    let _ = client.wait();
    seen
}

fn pane_meta(event: &ControlModeEvent) -> bool {
    matches!(event, ControlModeEvent::SubscriptionChanged { name, .. } if name == PANE_TITLE_SUBSCRIPTION_NAME)
}

fn window_relist(event: &ControlModeEvent) -> bool {
    matches!(event, ControlModeEvent::SessionSubscriptionChanged { name, .. } if relists_windows(name))
}

#[test]
fn a_mark_and_the_pane_options_tmuxy_reads_are_reported() {
    for (label, write) in [
        ("sub-mark", "select-pane -m"),
        ("sub-ask", "set -p @tmuxy-ask question"),
        ("sub-widget", "set -p @tmuxy-pane-widget diff"),
    ] {
        let after = reported_after(label, write, pane_meta);
        assert!(after < Duration::from_secs(3), "{write}: {after:?}");
    }
}

#[test]
fn the_window_options_tmuxy_reads_and_the_focus_request_re_list_the_windows() {
    for (label, write) in [
        ("sub-sidebar", "set -w @tmuxy-sidebar-cols 30"),
        ("sub-collapsible", "set -w @tmuxy-collapsible 1"),
        ("sub-focus", "set @tmuxy-focus-request '%0'"),
    ] {
        let after = reported_after(label, write, window_relist);
        assert!(after < Duration::from_secs(3), "{write}: {after:?}");
    }
}
