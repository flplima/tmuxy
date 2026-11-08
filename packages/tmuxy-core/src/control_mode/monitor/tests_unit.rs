use super::*;

fn run_state_with_now(now: Instant) -> (MonitorConfig, RunState) {
    let cfg = MonitorConfig {
        throttle_interval: Duration::from_millis(32),
        ..MonitorConfig::default()
    };
    let rs = RunState::new(&cfg, now);
    (cfg, rs)
}

/// A divider drag or a zoom-out cascade reports a layout change every few
/// milliseconds, and a busy pane's output arrives between them: the coalesced
/// layout still goes out `LAYOUT_DEBOUNCE` after the first change, not after
/// the last event.
#[test]
fn a_stream_of_layout_changes_still_emits_by_the_debounce_after_the_first() {
    let (_, mut rs) = run_state_with_now(Instant::now());
    let start = tokio::time::Instant::now();
    rs.schedule_layout_emit(start);
    for tick in 1..=10 {
        rs.schedule_layout_emit(start + Duration::from_millis(5 * tick));
    }
    assert_eq!(rs.layout_emit_at, Some(start + LAYOUT_DEBOUNCE));
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
    let after_window = now + RATE_WINDOW + Duration::from_millis(10);
    rs.update_rate(after_window);
    assert!(
        !rs.in_throttle_mode,
        "a fully-quiet rate window should exit throttle mode"
    );
}
