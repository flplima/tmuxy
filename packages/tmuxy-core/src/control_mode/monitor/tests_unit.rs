use super::*;

/// SEC-14: `GET /events?session=` lets a client pick the name, and an
/// unquoted one carrying `;` used to be parsed by control mode as a
/// second command — `?session=x ; run-shell "id>/tmp/p" ; resizew` ran it.
#[test]
fn a_session_name_carrying_a_semicolon_stays_one_command() {
    let cmd = initial_resize_command(r#"x ; run-shell "id>/tmp/p" ; resizew"#);
    assert_eq!(
        cmd,
        r#"resizew -t 'x ; run-shell "id>/tmp/p" ; resizew' -x 200 -y 50"#
    );
}

#[test]
fn a_session_name_carrying_a_quote_is_escaped_not_terminated() {
    assert!(initial_resize_command("it's").starts_with(r"resizew -t 'it'\''s' "));
}

/// tmux will not take a `resizew` on a window still set to size itself to
/// the latest client — it applies ours and then puts its own back. The
/// options are per WINDOW, so the ones set at attach covered exactly one.
#[test]
fn a_window_is_told_to_stop_sizing_itself_before_it_is_sized() {
    let cmds = window_sizing_commands(&WindowId::from_number(3), (41, 29));
    assert_eq!(
        cmds,
        [
            "setw -t @3 window-size manual".to_string(),
            "setw -t @3 aggressive-resize off".to_string(),
            "resizew -t @3 -x 41 -y 29".to_string(),
        ]
    );
    // The order is the point: tmux would re-apply its own size between a
    // resize and a later opt-out.
    assert!(cmds[2].starts_with("resizew"));
}

/// The bug this replaced: `resizew` is fire-and-forget, and recording the
/// SEND as the truth meant one dropped command left the client asking for
/// a size tmux never applied — `targetCols: 41` against `totalWidth: 200`,
/// for the life of the session, with the phone's terminal off screen.
#[test]
fn a_window_tmux_did_not_resize_is_asked_again() {
    // Asked once at report 3, and the report after it (4) still shows
    // the old grid: ask again.
    assert!(needs_resize(
        Some((200, 50)),
        (41, 29),
        Some(((41, 29), 1, 3)),
        4
    ));
}

/// The bug this replaced: this runs on every control-mode step, and a
/// step counted as an attempt. Three steps fit in the first thirty
/// milliseconds of an attach, before tmux had reported anything, and the
/// window was never asked again.
#[test]
fn a_window_is_not_asked_again_until_tmux_has_reported_since() {
    // Asked at report 3, still at report 3: nothing to judge yet.
    assert!(!needs_resize(None, (41, 29), Some(((41, 29), 1, 3)), 3));
    assert!(!needs_resize(
        Some((200, 50)),
        (41, 29),
        Some(((41, 29), 1, 3)),
        3
    ));
}

#[test]
fn a_window_tmux_did_resize_is_left_alone() {
    // However many commands it took, the grid IS the wanted one.
    assert!(!needs_resize(
        Some((41, 29),),
        (41, 29),
        Some(((41, 29), 3, 3)),
        4
    ));
    // ...even at the cap, which is about refusals, not successes.
    assert!(!needs_resize(
        Some((41, 29)),
        (41, 29),
        Some(((41, 29), 9, 3)),
        4
    ));
}

#[test]
fn a_size_tmux_keeps_refusing_stops_being_asked() {
    // Bounded, so a size tmux will not take cannot become a command on
    // every report for the rest of the session.
    assert!(needs_resize(
        Some((200, 50)),
        (41, 29),
        Some(((41, 29), 2, 3)),
        4
    ));
    assert!(!needs_resize(
        Some((200, 50)),
        (41, 29),
        Some(((41, 29), MAX_RESIZE_ATTEMPTS, 3)),
        4
    ));
}

#[test]
fn a_new_size_starts_its_own_attempts() {
    // The viewport changed again: the old size's exhausted count must not
    // suppress the new one, even before any further report.
    assert!(needs_resize(
        Some((200, 50)),
        (80, 24),
        Some(((41, 29), MAX_RESIZE_ATTEMPTS, 3)),
        3
    ));
}

#[test]
fn a_window_with_no_panes_yet_is_still_asked() {
    // `None` is "no pane of it seen yet", which is not "zero columns".
    assert!(needs_resize(None, (41, 29), None, 0));
}

#[test]
fn test_is_multi_step_run_shell_matches_pane_group_scripts() {
    // Real-world commands the frontend sends through SEND_TMUX_COMMAND.
    assert!(is_multi_step_run_shell(
        "run-shell \"$HOME/.local/share/tmuxy/bin/tmuxy/pane-group add %3 80 24\""
    ));
    assert!(is_multi_step_run_shell(
        "run-shell \"$HOME/.local/share/tmuxy/bin/tmuxy/pane-group close %3\""
    ));
    assert!(is_multi_step_run_shell(
        "run-shell \"$HOME/.local/share/tmuxy/bin/tmuxy/float-create lazygit\""
    ));
    // `tmuxy pane group …` quotes the script's path.
    assert!(is_multi_step_run_shell(
        "run-shell \"bash '/home/x/.local/share/tmuxy/bin/tmuxy/pane-group' next %3\""
    ));
    // Only the listed verbs are held; join is not one of them.
    assert!(!is_multi_step_run_shell(
        "run-shell \"$HOME/.local/share/tmuxy/bin/tmuxy/pane-group join %3 %1 0\""
    ));
}

#[test]
fn test_is_multi_step_run_shell_skips_one_shot_commands() {
    // Plain run-shell to one-shot helpers shouldn't arm settling.
    assert!(!is_multi_step_run_shell("run-shell \"echo hello\""));
    assert!(!is_multi_step_run_shell(
        "run-shell \"tmuxy/bin/tmuxy/reap-orphan-shells\""
    ));
    // Non-run-shell commands never arm.
    assert!(!is_multi_step_run_shell("splitw -h"));
    assert!(!is_multi_step_run_shell("splitw ; breakp"));
}

/// Keystrokes go out bare; everything else is wrapped so a `%error`
/// can be attributed and shown. A pinned keystroke is still a keystroke.
#[test]
fn only_keystrokes_skip_failure_reporting() {
    assert!(!reports_failure("send-keys -t %1 -l x"));
    assert!(!reports_failure(
        "select-window -t @1 ; select-pane -t %1 ; send-keys Enter"
    ));
    assert!(!reports_failure(
        "select-window -t @1 \\; select-pane -t %1 \\; send-keys Enter"
    ));
    assert!(reports_failure("split-window -h"));
    assert!(reports_failure(
        "select-window -t @1 ; select-pane -t %1 ; kill-pane"
    ));
    assert!(reports_failure("run-shell 'tmuxy pane float'"));
}

// =========================================================================
// RunState helper tests (Phase 3.6 follow-up).
//
// These exercise the pure functions extracted from `run()` directly,
// without spinning a tmux process. Time advancement is simulated by
// passing explicit `Instant` values — no tokio, no sleeps.
// =========================================================================

fn run_state_with_now(now: Instant) -> (MonitorConfig, RunState) {
    let cfg = MonitorConfig {
        throttle_interval: Duration::from_millis(32),
        ..MonitorConfig::default()
    };
    let rs = RunState::new(&cfg, now);
    (cfg, rs)
}

#[test]
fn a_pane_that_keeps_printing_does_not_starve_the_metadata_sync() {
    let (_, mut rs) = run_state_with_now(Instant::now());
    let start = tokio::time::Instant::now();
    rs.schedule_metadata_sync(start);
    // Output every 100 ms for a second: the sync stays due at the first deadline.
    for tick in 1..=10 {
        rs.schedule_metadata_sync(start + Duration::from_millis(100 * tick));
    }
    assert_eq!(rs.metadata_sync_at, Some(start + METADATA_SYNC_DELAY));
}

#[test]
fn compute_throttle_sleep_returns_long_sleep_when_nothing_pending() {
    let now = Instant::now();
    let (cfg, rs) = run_state_with_now(now);
    assert_eq!(rs.compute_throttle_sleep(&cfg, now), LONG_SLEEP);
}

#[test]
fn compute_throttle_sleep_zero_when_throttle_interval_already_passed() {
    let now = Instant::now();
    let (cfg, mut rs) = run_state_with_now(now);
    rs.pending_output_emit = true;
    rs.in_throttle_mode = true;
    // Pretend we last emitted >>throttle_interval ago.
    rs.last_output_emit = now - cfg.throttle_interval - Duration::from_millis(10);
    assert_eq!(
        rs.compute_throttle_sleep(&cfg, now),
        Duration::ZERO,
        "if the throttle window has elapsed, sleep should be zero"
    );
}

#[test]
fn compute_throttle_sleep_remaining_interval_when_recent_emit() {
    let now = Instant::now();
    let (cfg, mut rs) = run_state_with_now(now);
    rs.pending_output_emit = true;
    rs.in_throttle_mode = true;
    rs.last_output_emit = now - Duration::from_millis(10);
    let remaining = rs.compute_throttle_sleep(&cfg, now);
    assert!(remaining > Duration::ZERO);
    assert!(remaining <= cfg.throttle_interval);
}

#[test]
fn mark_emitted_resets_pending_trackers() {
    let now = Instant::now();
    let (_cfg, mut rs) = run_state_with_now(now);
    rs.pending_output_emit = true;
    rs.pending_output_first_at = Some(now);
    rs.last_output_event_at = Some(now);
    let later = now + Duration::from_millis(50);
    rs.mark_emitted(later);
    assert_eq!(rs.last_output_emit, later);
    assert!(!rs.pending_output_emit);
    assert_eq!(rs.pending_output_first_at, None);
    assert_eq!(rs.last_output_event_at, None);
}

#[test]
fn update_rate_enters_throttle_above_threshold() {
    let now = Instant::now();
    let (_, mut rs) = run_state_with_now(now);
    assert!(!rs.in_throttle_mode);
    // Push the counter past `throttle_threshold` within the same window.
    // The first call resets `rate_window_start` to `now`, so subsequent
    // calls accumulate. We loop one past the threshold to cross it.
    for _ in 0..=THROTTLE_THRESHOLD {
        rs.update_rate(now);
    }
    assert!(
        rs.in_throttle_mode,
        "exceeding throttle_threshold should flip the mode"
    );
}

#[test]
fn update_rate_exits_throttle_when_rate_drops() {
    let now = Instant::now();
    let (_, mut rs) = run_state_with_now(now);
    rs.in_throttle_mode = true;
    rs.rate_event_count = 0;
    rs.rate_window_start = now;
    // Advance the clock past the rate window so update_rate evaluates
    // the hysteresis on the previous window's count (zero) and exits.
    let after_window = now + RATE_WINDOW + Duration::from_millis(10);
    rs.update_rate(after_window);
    assert!(
        !rs.in_throttle_mode,
        "a fully-quiet rate window should exit throttle mode"
    );
}
