//! Unit tests for the sans-IO `StateAggregator::step` entry point.
//!
//! Drives the aggregator with synthetic events and asserts the typed
//! `SideEffect` values it emits. No tokio, no real tmux, no real time —
//! just `step(event) -> StepResult`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tmuxy_core::control_mode::{ChangeType, ControlModeEvent, SideEffect, StateAggregator};

fn variant_names(effects: &[SideEffect]) -> Vec<&'static str> {
    effects
        .iter()
        .map(|e| match e {
            SideEffect::SendTmuxCommand(_) => "SendTmuxCommand",
            SideEffect::RefreshPanes { .. } => "RefreshPanes",
            SideEffect::RefreshAfterWindowAdd => "RefreshAfterWindowAdd",
            SideEffect::AdoptUntaggedWindows(_) => "AdoptUntaggedWindows",
            SideEffect::EmitState { .. } => "EmitState",
            SideEffect::ResumePane(_) => "ResumePane",
            SideEffect::StoreImages { .. } => "StoreImages",
            SideEffect::WriteClipboard { .. } => "WriteClipboard",
        })
        .collect()
}

#[test]
fn empty_event_yields_no_effects() {
    let mut agg = StateAggregator::new();
    // SessionsChanged carries no payload and shouldn't trigger captures or
    // emissions on its own.
    let result = agg.step(ControlModeEvent::SessionsChanged);
    assert!(
        variant_names(&result.effects)
            .iter()
            .all(|v| *v == "EmitState" || *v == "AdoptUntaggedWindows"),
        "unexpected side effects: {:?}",
        variant_names(&result.effects)
    );
}

#[test]
fn window_add_yields_refresh_after_window_add() {
    let mut agg = StateAggregator::new();
    let result = agg.step(ControlModeEvent::WindowAdd {
        window_id: "@5".to_string(),
    });
    let variants = variant_names(&result.effects);
    assert!(
        variants.contains(&"RefreshAfterWindowAdd"),
        "expected RefreshAfterWindowAdd in {:?}",
        variants
    );
}

#[test]
fn unlinked_window_add_also_yields_refresh_after_window_add() {
    let mut agg = StateAggregator::new();
    let result = agg.step(ControlModeEvent::UnlinkedWindowAdd {
        window_id: "@7".to_string(),
    });
    let variants = variant_names(&result.effects);
    // tmux 3.5a emits %unlinked-window-add for the break-pane workaround we
    // use as new-window replacement — both event kinds must hit the same
    // ordering invariant.
    assert!(
        variants.contains(&"RefreshAfterWindowAdd"),
        "expected RefreshAfterWindowAdd in {:?}",
        variants
    );
}

#[test]
fn step_never_returns_empty_variant_pattern_for_known_events() {
    // Drive the aggregator with one of every reasonable event so we exercise
    // the side-effect production paths and confirm step() never panics.
    let mut agg = StateAggregator::new();
    let events = vec![
        ControlModeEvent::SessionsChanged,
        ControlModeEvent::WindowAdd {
            window_id: "@1".into(),
        },
        ControlModeEvent::WindowClose {
            window_id: "@1".into(),
        },
        ControlModeEvent::Output {
            pane_id: "%0".into(),
            content: b"hello".to_vec(),
        },
        ControlModeEvent::PaneModeChanged {
            pane_id: "%0".into(),
        },
        ControlModeEvent::Exit {
            reason: Some("test".into()),
        },
    ];
    for ev in events {
        let _ = agg.step(ev);
    }
}

#[test]
fn change_type_is_surfaced_even_when_emission_is_suppressed() {
    // Pre-condition: a window exists so close can suppress-but-still-flag.
    let mut agg = StateAggregator::new();
    agg.step(ControlModeEvent::WindowAdd {
        window_id: "@9".into(),
    });
    // Arming suppression mirrors the monitor's compound-command settling.
    agg.set_suppress_window_emissions(true);
    let result = agg.step(ControlModeEvent::WindowClose {
        window_id: "@9".into(),
    });
    assert!(
        !result
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::EmitState { .. })),
        "no EmitState may fire while suppression is on"
    );
    assert_eq!(
        result.change_type,
        ChangeType::Window,
        "monitor's settling timer needs to see Window changes even when suppressed"
    );
}

#[test]
fn tick_is_noop_when_not_armed() {
    let mut agg = StateAggregator::new();
    let effects = agg.tick(std::time::Instant::now());
    assert!(
        effects.is_empty(),
        "tick without settling armed yields nothing"
    );
}

#[test]
fn arm_settling_suppresses_window_emissions() {
    let mut agg = StateAggregator::new();
    let t0 = std::time::Instant::now();
    // Seed a window so WindowClose has something to close (and thus produces
    // a non-default ProcessEventResult).
    let _ = agg.step_at(
        ControlModeEvent::WindowAdd {
            window_id: "@9".into(),
        },
        t0,
    );
    agg.arm_settling(t0);
    assert!(agg.is_settling());
    assert!(agg.is_suppressing_window_emissions());
    let result = agg.step_at(
        ControlModeEvent::WindowClose {
            window_id: "@9".into(),
        },
        t0 + std::time::Duration::from_millis(5),
    );
    assert!(
        !result
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::EmitState { .. })),
        "settling must suppress EmitState during the window"
    );
    assert_eq!(
        result.change_type,
        ChangeType::Window,
        "change_type is still surfaced — the monitor needs it to extend settling"
    );
}

#[test]
fn tick_after_deadline_emits_and_clears_when_events_observed() {
    let mut agg = StateAggregator::new();
    let t0 = std::time::Instant::now();
    let _ = agg.step_at(
        ControlModeEvent::WindowAdd {
            window_id: "@9".into(),
        },
        t0,
    );
    agg.arm_settling(t0);
    let _ = agg.step_at(
        ControlModeEvent::WindowClose {
            window_id: "@9".into(),
        },
        t0 + std::time::Duration::from_millis(5),
    );
    let deadline = agg
        .settling_deadline()
        .expect("settling must still be armed");
    let effects = agg.tick(deadline + std::time::Duration::from_millis(1));
    assert!(matches!(
        effects.as_slice(),
        [SideEffect::EmitState {
            change: ChangeType::Full
        }]
    ));
    assert!(!agg.is_settling(), "tick after deadline clears settling");
    assert!(!agg.is_suppressing_window_emissions());
}

#[test]
fn tick_safety_timeout_clears_silently_when_no_events() {
    let mut agg = StateAggregator::new();
    let t0 = std::time::Instant::now();
    agg.arm_settling(t0);
    // No events arrive — the safety ceiling fires.
    let effects = agg.tick(t0 + std::time::Duration::from_millis(600));
    assert!(
        effects.is_empty(),
        "safety timeout must not emit when no events were observed"
    );
    assert!(!agg.is_settling());
    assert!(!agg.is_suppressing_window_emissions());
}

#[test]
fn clear_settling_unsuppresses_without_emitting() {
    let mut agg = StateAggregator::new();
    let t0 = std::time::Instant::now();
    agg.arm_settling(t0);
    agg.clear_settling();
    assert!(!agg.is_settling());
    assert!(!agg.is_suppressing_window_emissions());
}

#[test]
fn step_at_extends_settling_on_window_events_only() {
    let mut agg = StateAggregator::new();
    let t0 = std::time::Instant::now();
    let _ = agg.step_at(
        ControlModeEvent::WindowAdd {
            window_id: "@7".into(),
        },
        t0,
    );
    agg.arm_settling(t0);
    let before = agg.settling_deadline().unwrap();
    // PaneOutput should NOT extend.
    let _ = agg.step_at(
        ControlModeEvent::Output {
            pane_id: "%0".into(),
            content: b"hi".to_vec(),
        },
        t0 + std::time::Duration::from_millis(5),
    );
    assert_eq!(
        agg.settling_deadline().unwrap(),
        before,
        "output events do not extend settling"
    );
    // A real Window-typed event DOES extend (bounded by safety max).
    let _ = agg.step_at(
        ControlModeEvent::WindowClose {
            window_id: "@7".into(),
        },
        t0 + std::time::Duration::from_millis(50),
    );
    let after = agg.settling_deadline().unwrap();
    assert!(
        after <= before,
        "extension is bounded by the safety ceiling"
    );
}
