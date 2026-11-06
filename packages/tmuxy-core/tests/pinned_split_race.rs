//! A pinned command keeps its pin under a concurrent `select-window`.
//!
//! The frontend pins every command to the tab the user is looking at:
//! `select-window -t @B ; select-pane -t %b ; split-window -h`. The desktop
//! transport used to run that list as an external subprocess and inject
//! `-t <session>` into the untargeted `split-window`. A session target is
//! resolved late, against the session's *current* window, so any other
//! client's `select-window` landing between the pin and the split moved the
//! split to the wrong tab — which tmuxy's own monitor does constantly.
//!
//! Sent byte-identical down the control-mode connection, the untargeted
//! `split-window` inherits the queue's current target from the pin and holds
//! it even while another client switches windows mid-list. This test forces
//! the race (a `run-shell sleep` inside the pinned list, an external
//! `select-window` during it) and expects the pin to hold. It fails against
//! the old path, which is the point.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::control_mode::MonitorCommand;

mod common;

async fn panes_in(monitor: &common::Monitor, window: &str) -> usize {
    monitor
        .ask(&format!("list-panes -t {window} -F '#{{pane_id}}'"))
        .await
        .output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count()
}

#[tokio::test]
async fn a_pinned_split_survives_a_concurrent_select_window() {
    let server = common::ScratchServer::new("pin-race");
    let monitor = server.attach("app", true).await;

    // Two windows. tmux's current window is the first; the pin names the second.
    monitor.ask("new-window -d").await;
    let listing = monitor
        .ask("list-windows -F '#{window_id} #{pane_id}'")
        .await;
    let rows: Vec<Vec<&str>> = listing
        .output
        .lines()
        .map(|l| l.split_whitespace().collect())
        .collect();
    assert_eq!(rows.len(), 2, "two windows: {}", listing.output);
    let (first_window, second_window, second_pane) = (rows[0][0], rows[1][0], rows[1][1]);
    monitor
        .ask(&format!("select-window -t {first_window}"))
        .await;
    assert_eq!(panes_in(&monitor, second_window).await, 1);

    // The pinned split, stalled between its pin and its split so the other
    // client is certain to land in between.
    let pinned = format!(
        "select-window -t {second_window} \\; select-pane -t {second_pane} \\; run-shell 'sleep 1' \\; split-window -h"
    );
    // As a client sends it: through the router, which writes the frontend's
    // `\;` as the `;` control mode reads.
    let tmuxy_core::command_router::Route::ControlMode(command) =
        tmuxy_core::command_router::route_command(&pinned, "tmuxy", None)
    else {
        panic!("the pinned split routes to control mode");
    };
    monitor.send(MonitorCommand::RunCommand { command }).await;
    // A position INSIDE the stalled list's one-second window, by design: the
    // other client has to act between the pin and the split, and nothing
    // observable marks that moment but the clock.
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Another client — the way tmuxy's own monitor, or a user switching tabs,
    // does all the time — moves the session's current window.
    common::tmux(&["select-window", "-t", first_window]).unwrap();

    // The stalled list finishes and the split lands somewhere.
    let monitor_ref = &monitor;
    common::wait_until(
        "the stalled split to land",
        Duration::from_secs(10),
        move || async move {
            panes_in(monitor_ref, second_window).await + panes_in(monitor_ref, first_window).await
                == 3
        },
    )
    .await;

    assert_eq!(
        panes_in(&monitor, second_window).await,
        2,
        "the split must land on the PINNED window"
    );
    assert_eq!(
        panes_in(&monitor, first_window).await,
        1,
        "and never on the window tmux happened to be on"
    );
}
