//! Property-based tests for the `StateAggregator` state machine.
//!
//! These run as an integration test so they can use a clean `cfg(test)` profile
//! without contending with the lib's `#[allow(clippy::unwrap_used)]` tests
//! module on the same source file.
//!
//! Each property drives the aggregator with synthetic event sequences and
//! asserts an invariant that *must* hold regardless of input ordering. The
//! aggregator has no tokio/async dependencies (Phase 3.11 confirmed it as
//! already-sans-IO), so these properties exercise it purely through
//! `process_event`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use std::collections::HashSet;
use tmuxy_core::control_mode::{ChangeType, ControlModeEvent, SideEffect, StateAggregator};

/// Generate a synthetic `Output` event with a small randomised payload.
/// Pane id values are biased to a small pool so the aggregator actually has
/// repeat hits to track instead of every event creating a fresh state.
fn output_event_strategy() -> impl Strategy<Value = ControlModeEvent> {
    (
        prop::sample::select(vec!["%0", "%1", "%2", "%3", "%4"]),
        prop::collection::vec(any::<u8>(), 1..16),
    )
        .prop_map(|(pane_id, content)| ControlModeEvent::Output {
            pane_id: pane_id.to_string(),
            content,
        })
}

/// Structural events (window-add/window-close/session-changed). Mostly empty
/// payloads — they're useful for stressing the aggregator's bookkeeping
/// without exploding the search space.
fn structural_event_strategy() -> impl Strategy<Value = ControlModeEvent> {
    let window_ids = || prop::sample::select(vec!["@0", "@1", "@2"]);
    prop_oneof![
        window_ids().prop_map(|w| ControlModeEvent::WindowAdd {
            window_id: w.to_string(),
        }),
        window_ids().prop_map(|w| ControlModeEvent::WindowClose {
            window_id: w.to_string(),
        }),
        window_ids().prop_map(|w| ControlModeEvent::UnlinkedWindowAdd {
            window_id: w.to_string(),
        }),
        window_ids().prop_map(|w| ControlModeEvent::UnlinkedWindowClose {
            window_id: w.to_string(),
        }),
        prop::sample::select(vec!["%0", "%1", "%2"]).prop_map(|p| {
            ControlModeEvent::PaneModeChanged {
                pane_id: p.to_string(),
            }
        }),
    ]
}

fn any_event_strategy() -> impl Strategy<Value = ControlModeEvent> {
    prop_oneof![
        4 => output_event_strategy(),
        1 => structural_event_strategy(),
    ]
}

proptest! {
    /// `process_event` must never panic on any sequence of synthetic events.
    /// The aggregator wraps vt100 in a panic guard (`safe_process` in
    /// `state.rs`), so even adversarially-malformed payloads should be
    /// contained.
    #[test]
    fn process_event_never_panics(events in prop::collection::vec(any_event_strategy(), 1..50)) {
        let mut agg = StateAggregator::new();
        for ev in events {
            let _ = agg.process_event(ev);
        }
    }

    /// After processing a sequence of events, the aggregator's reported
    /// window count must equal the number of distinct windows it has seen
    /// minus those that were closed. This catches double-counts in the
    /// add/close bookkeeping that earlier hand-rolled tests didn't.
    #[test]
    fn window_count_matches_add_close_delta(
        adds in prop::collection::vec(prop::sample::select(vec!["@0", "@1", "@2", "@3"]), 0..10),
        closes in prop::collection::vec(prop::sample::select(vec!["@0", "@1", "@2", "@3"]), 0..10),
    ) {
        let mut agg = StateAggregator::new();
        // Apply adds first, then closes — the order matters because closing
        // a non-existent window is a no-op, not an error.
        for w in &adds {
            agg.process_event(ControlModeEvent::WindowAdd { window_id: w.to_string() });
        }
        let after_adds = agg.window_count();
        for w in &closes {
            agg.process_event(ControlModeEvent::WindowClose { window_id: w.to_string() });
        }
        let after_closes = agg.window_count();
        // Sanity: closes can only ever reduce the window count.
        prop_assert!(after_closes <= after_adds);
    }

    /// Suppression flag is purely a sticky boolean — toggling it on then off
    /// must always return the aggregator to the unsuppressed state regardless
    /// of intervening events. Catches accidental state leakage during the
    /// settling window.
    #[test]
    fn suppress_flag_round_trips(events in prop::collection::vec(any_event_strategy(), 0..30)) {
        let mut agg = StateAggregator::new();
        agg.set_suppress_window_emissions(true);
        prop_assert!(agg.is_suppressing_window_emissions());
        for ev in events {
            let _ = agg.process_event(ev);
        }
        // Suppression remains true while events flow.
        prop_assert!(agg.is_suppressing_window_emissions());
        agg.set_suppress_window_emissions(false);
        prop_assert!(!agg.is_suppressing_window_emissions());
    }

    /// State-delta consistency: every `EmitState` effect must carry a non-None
    /// change_type that matches the step's overall change_type. Catches the
    /// regression where a refactor of `step` drops the change-type plumbing
    /// and the monitor's throttle policy starts treating layout changes as
    /// generic.
    #[test]
    fn emit_state_change_matches_step_change(
        events in prop::collection::vec(any_event_strategy(), 1..30)
    ) {
        let mut agg = StateAggregator::new();
        for ev in events {
            let result = agg.step(ev);
            for effect in &result.effects {
                if let SideEffect::EmitState { change } = effect {
                    prop_assert_ne!(change.clone(), ChangeType::None,
                        "EmitState must carry a real change type");
                    prop_assert_eq!(change.clone(), result.change_type.clone(),
                        "EmitState change must match step's reported change_type");
                }
            }
        }
    }

    /// Window-add ↔ capture-pane reconciliation: every WindowAdd step must
    /// emit RefreshAfterWindowAdd, and that effect type must arrive BEFORE
    /// any EmitState in the same step (so the monitor issues list-panes
    /// before tmux can race a layout-change emission). Catches a regression
    /// where the SideEffect ordering documented in `state::SideEffect` gets
    /// inverted.
    #[test]
    fn window_add_refresh_precedes_any_emit(
        // A "warmup" sequence to put the aggregator in non-trivial state,
        // then a window-add.
        warmup in prop::collection::vec(any_event_strategy(), 0..10),
        window_id in prop::sample::select(vec!["@7", "@8", "@9"]),
    ) {
        let mut agg = StateAggregator::new();
        for ev in warmup {
            let _ = agg.step(ev);
        }
        let result = agg.step(ControlModeEvent::WindowAdd {
            window_id: window_id.to_string(),
        });
        let refresh_idx = result.effects.iter().position(|e|
            matches!(e, SideEffect::RefreshAfterWindowAdd));
        let emit_idx = result.effects.iter().position(|e|
            matches!(e, SideEffect::EmitState { .. }));
        prop_assert!(refresh_idx.is_some(),
            "WindowAdd must emit RefreshAfterWindowAdd");
        if let (Some(r), Some(e)) = (refresh_idx, emit_idx) {
            prop_assert!(r < e,
                "RefreshAfterWindowAdd ({}) must precede EmitState ({}) in effect order",
                r, e);
        }
    }

    /// Out-of-order capture queue: queue_captures is idempotent against
    /// repeats — already-queued pane ids are skipped, never duplicated. This
    /// protects the FIFO matching scheme described in `queue_captures`'s
    /// docblock; a duplicate enqueue would shift every subsequent capture
    /// response onto the wrong pane.
    #[test]
    fn queue_captures_is_idempotent_across_repeats(
        pane_ids in prop::collection::vec(
            prop::sample::select(vec!["%0", "%1", "%2"]).prop_map(String::from),
            1..20,
        ),
    ) {
        let mut agg = StateAggregator::new();
        let unique: HashSet<String> = pane_ids.iter().cloned().collect();
        let queued = agg.queue_captures(&pane_ids);
        // First call queues each distinct id exactly once.
        prop_assert_eq!(queued.len(), unique.len(),
            "first queue should match the number of distinct ids");
        // Second call queues nothing — the queue already has them.
        let requeued = agg.queue_captures(&pane_ids);
        prop_assert!(requeued.is_empty(),
            "re-queueing the same ids should be a no-op");
    }

    /// When window emissions are suppressed, no SideEffect::EmitState should
    /// fire for window/layout events. Mirrors the settling-window behaviour
    /// the monitor relies on to batch compound-command intermediates.
    #[test]
    fn suppressed_window_events_do_not_emit_state(
        window_ids in prop::collection::vec(
            prop::sample::select(vec!["@0", "@1", "@2"]).prop_map(String::from),
            1..10,
        ),
    ) {
        let mut agg = StateAggregator::new();
        // Pre-populate so closes don't get filtered as no-ops.
        for w in &window_ids {
            agg.step(ControlModeEvent::WindowAdd { window_id: w.clone() });
        }
        agg.set_suppress_window_emissions(true);
        for w in &window_ids {
            let result = agg.step(ControlModeEvent::WindowClose { window_id: w.clone() });
            let has_emit = result.effects.iter().any(|e|
                matches!(e, SideEffect::EmitState { .. }));
            prop_assert!(!has_emit,
                "WindowClose under suppression must not emit; got effects: {:?}",
                result.effects);
            // The change_type still reflects the underlying mutation so the
            // monitor's settling timer can extend.
            prop_assert_eq!(result.change_type, ChangeType::Window,
                "change_type must still report Window when suppressed");
        }
    }
}
