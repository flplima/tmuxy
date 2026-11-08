//! The settings the frontend cannot work without are enforced on connect.
//!
//! The attach (`enforced_settings` in `control_mode/monitor_core/attach.rs`)
//! sets a handful of tmux options on the attached session every time a
//! monitor connects, and the aggregator's window setup
//! (`window_setup_commands`) the window options on each window it lists,
//! whatever the user's `tmux.conf` says. They are invariants, not preferences: without
//! `pane-border-status top` a pane at y=0 loses a row of content to the header
//! tmuxy draws over the border row; without `mouse on` clicking a pane does not
//! focus it; without `allow-passthrough` hyperlinks and images never reach the
//! client. A config that turns any of them off used to win, and the UI came up
//! subtly broken with nothing to point at.
//!
//! The options are read back through the monitor's own reply channel — the only
//! way to read from tmux while a control-mode client is attached.
//!
//! Needs a `tmux` binary; the socket name is unique per process.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

mod common;

async fn option(monitor: &common::Monitor, name: &str) -> String {
    let reply = monitor.ask(&format!("show-options -t app -v {name}")).await;
    assert_eq!(reply.error, None, "show-options {name} succeeded");
    reply.output.trim_end_matches('\n').to_string()
}

#[tokio::test]
async fn connecting_enforces_the_settings_the_layout_depends_on() {
    let server = common::ScratchServer::process_wide("enforced-settings");

    common::tmux(&["new-session", "-d", "-s", "app", "sleep", "60"]).unwrap();

    // A session configured exactly the wrong way round, the way a user's
    // tmux.conf leaves it. Every one of these must be overridden on connect.
    // tmux 3.2 has no `allow-passthrough` (it passes the sequences through
    // unconditionally), so there is nothing to turn off or read back there.
    let version = common::tmux(&["-V"]).unwrap();
    let has_passthrough =
        tmuxy_core::tmux_check::parse_version(&version).is_none_or(|found| found >= (3, 3));
    let mut switches = vec!["mouse", "focus-events", "allow-rename", "set-titles"];
    if has_passthrough {
        switches.push("allow-passthrough");
    }
    common::tmux(&["set-option", "-t", "app", "pane-border-status", "off"]).unwrap();
    for key in &switches {
        common::tmux(&["set-option", "-t", "app", key, "off"]).unwrap();
    }
    common::tmux(&["set-window-option", "-t", "app", "aggressive-resize", "on"]).unwrap();
    // A second window, not the current one at attach: window options set
    // without a target reach only the current window, so these are set on
    // each window by id.
    let second = common::tmux(&[
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        "app:",
        "sleep",
        "60",
    ])
    .unwrap();
    let second = second.trim();

    let monitor = server.attach("app", false).await;

    // The load-bearing one: PaneLayout reserves the border row for its header,
    // so a pane at y=0 renders one row short when this is not `top`. It is a
    // window option, set on each window as the monitor first lists it, a step
    // after the connect: keep asking until then.
    common::wait_until(
        "pane-border-status top",
        Duration::from_secs(10),
        || async { option(&monitor, "pane-border-status").await == "top" },
    )
    .await;

    // The border row is blank so nothing of tmux's own shows through the header.
    assert!(
        option(&monitor, "pane-border-format")
            .await
            .trim()
            .is_empty(),
        "the border row is drawn empty"
    );

    for key in &switches {
        assert_eq!(option(&monitor, key).await, "on", "{key} is enforced on");
    }

    let mut per_window = vec!["allow-rename"];
    if has_passthrough {
        per_window.push("allow-passthrough");
    }
    for key in per_window {
        let reply = monitor
            .ask(&format!("show-options -w -t {second} -v {key}"))
            .await;
        assert_eq!(
            (reply.error, reply.output.trim()),
            (None, "on"),
            "{key} is on in a window that was not the current one"
        );
    }

    let aggressive = monitor
        .ask("show-window-options -t app -v aggressive-resize")
        .await;
    assert_eq!(aggressive.error, None);
    assert_eq!(
        aggressive.output.trim(),
        "off",
        "tmuxy manages sizing itself"
    );

    assert_eq!(
        monitor.errors(),
        Vec::<String>::new(),
        "no setting was rejected"
    );
}
