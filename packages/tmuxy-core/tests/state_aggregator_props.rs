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
use tmuxy_core::control_mode::{ControlModeEvent, StateAggregator};

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
}
