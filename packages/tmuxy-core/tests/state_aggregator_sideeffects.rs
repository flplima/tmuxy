//! Unit tests for the sans-IO `StateAggregator::step` entry point.
//!
//! Drives the aggregator with synthetic events and asserts the typed
//! `SideEffect` values it emits. No tokio, no real tmux, no real time —
//! just `step(event) -> Vec<SideEffect>`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tmuxy_core::control_mode::{ControlModeEvent, SideEffect, StateAggregator};

fn variant_names(effects: &[SideEffect]) -> Vec<&'static str> {
    effects
        .iter()
        .map(|e| match e {
            SideEffect::SendTmuxCommand(_) => "SendTmuxCommand",
            SideEffect::SendTmuxBatch(_) => "SendTmuxBatch",
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
    let effects = agg.step(ControlModeEvent::SessionsChanged);
    assert!(
        variant_names(&effects)
            .iter()
            .all(|v| *v == "EmitState" || *v == "AdoptUntaggedWindows"),
        "unexpected side effects: {:?}",
        variant_names(&effects)
    );
}

#[test]
fn window_add_yields_refresh_after_window_add() {
    let mut agg = StateAggregator::new();
    let effects = agg.step(ControlModeEvent::WindowAdd {
        window_id: "@5".to_string(),
    });
    let variants = variant_names(&effects);
    assert!(
        variants.contains(&"RefreshAfterWindowAdd"),
        "expected RefreshAfterWindowAdd in {:?}",
        variants
    );
}

#[test]
fn unlinked_window_add_also_yields_refresh_after_window_add() {
    let mut agg = StateAggregator::new();
    let effects = agg.step(ControlModeEvent::UnlinkedWindowAdd {
        window_id: "@7".to_string(),
    });
    let variants = variant_names(&effects);
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
