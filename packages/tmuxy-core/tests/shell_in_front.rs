//! The shell check Ctrl+C at an empty prompt runs in tmux
//! (`tmux_formats::shell_in_front`): routed as the UI sends it, and read by
//! the tmux this runs on. The nightly matrix runs it on each supported
//! version, so a format a version cannot read fails there.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::{Duration, Instant};

use tmuxy_core::command_router::{route_command, Route};
use tmuxy_core::constants::tmux_formats::shell_in_front;

/// What the check says of `pane`, once its program is `command`: polled,
/// since a pane's program is exec'd after the pane exists. The duration is a
/// ceiling, never a wait.
fn check_once_running(server: &common::ScratchServer, pane: &str, command: &str) -> String {
    let started = Instant::now();
    loop {
        let running = server.tmux(&[
            "display-message",
            "-p",
            "-t",
            pane,
            "#{pane_current_command}",
        ]);
        if running == command {
            return server.tmux(&["display-message", "-p", "-t", pane, &shell_in_front()]);
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{pane} never ran {command} (runs {running})"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_shell_in_front_is_told_from_a_program_and_a_login_shell_counts() {
    let server = common::ScratchServer::with_session("shell-front", 80, 24);
    let split = |command: &str| {
        server.tmux(&[
            "split-window",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-t",
            "work",
            command,
        ])
    };
    let sleeping = split("sleep 60");
    // A login shell's argv[0] is `-bash`; tmux drops the `-`.
    let login = split("bash -c 'exec -a -bash bash --norc --noprofile'");
    // Not `sh`: macOS's /bin/sh runs bash, so tmux names it `bash` there.
    let zsh = split("exec zsh -f");

    assert_eq!(check_once_running(&server, &sleeping, "sleep"), "0");
    assert_eq!(check_once_running(&server, &login, "bash"), "1");
    assert_eq!(check_once_running(&server, &zsh, "zsh"), "1");
}

/// The UI's `InterruptOrEof` line (`commands.ts`) reaches tmux as written,
/// the check and both sends on one line, so no rewrite can take a send out
/// of the check.
#[test]
fn the_ctrl_c_line_is_routed_whole() {
    let line = format!(
        "if-shell -F -t %7 '{}' {{ send-keys -t %7 C-d }} {{ send-keys -t %7 C-c }}",
        shell_in_front()
    );
    assert_eq!(
        route_command(&line, "tmuxy", None),
        Route::ControlMode(line.clone())
    );
}
