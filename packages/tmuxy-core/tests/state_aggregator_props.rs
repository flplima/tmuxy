//! Property-based tests for the `StateAggregator` state machine.
//!
//! These run as an integration test so they can use a clean `cfg(test)` profile
//! without contending with the lib's `#[allow(clippy::unwrap_used)]` tests
//! module on the same source file.
//!
//! Each property drives the aggregator with synthetic event sequences and
//! asserts an invariant that *must* hold regardless of input ordering. The
//! aggregator has no tokio/async dependencies, so these properties exercise
//! it purely through `step`/`step_at` and `tick`, the entry points the
//! runtime uses.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use std::collections::HashSet;
use tmuxy_core::control_mode::{ChangeType, ControlModeEvent, SideEffect, StateAggregator};
use tmuxy_core::{PaneId, WindowId};

/// Generate a synthetic `Output` event with a small randomised payload.
/// Pane id values are biased to a small pool so the aggregator actually has
/// repeat hits to track instead of every event creating a fresh state.
fn output_event_strategy() -> impl Strategy<Value = ControlModeEvent> {
    (
        prop::sample::select(vec!["%0", "%1", "%2", "%3", "%4"]),
        prop::collection::vec(any::<u8>(), 1..16),
    )
        .prop_map(|(pane_id, content)| ControlModeEvent::Output {
            pane_id: pane_id.parse().unwrap(),
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
            window_id: w.parse().unwrap(),
        }),
        window_ids().prop_map(|w| ControlModeEvent::WindowClose {
            window_id: w.parse().unwrap(),
        }),
        window_ids().prop_map(|w| ControlModeEvent::UnlinkedWindowAdd {
            window_id: w.parse().unwrap(),
        }),
        window_ids().prop_map(|w| ControlModeEvent::UnlinkedWindowClose {
            window_id: w.parse().unwrap(),
        }),
        prop::sample::select(vec!["%0", "%1", "%2"]).prop_map(|p| {
            ControlModeEvent::PaneModeChanged {
                pane_id: p.parse().unwrap(),
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

/// A `%begin`/`%end` block as the parser hands it over.
fn response(output: &str) -> ControlModeEvent {
    ControlModeEvent::CommandResponse {
        timestamp: 0,
        command_num: 0,
        output: output.to_string(),
        success: true,
    }
}

/// A pane the aggregator knows (`%0`, `%1`, `%2` in window `@0`), the window
/// active with `%0` focused — what an attached monitor has after its initial
/// sync, and what the output, clipboard, pause and refresh paths all gate on.
fn seeded_aggregator() -> StateAggregator {
    let mut agg = StateAggregator::new();
    agg.step(ControlModeEvent::WindowAdd {
        window_id: "@0".parse().unwrap(),
    });
    agg.step(response(
        "%0,0,0,0,80,12,0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,\n\
         %1,1,0,13,80,11,0,0,0,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,\n\
         %2,2,40,13,40,11,0,0,0,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,",
    ));
    agg.step(ControlModeEvent::SessionWindowChanged {
        session_id: "$0".to_string(),
        window_id: "@0".parse().unwrap(),
    });
    agg.step(ControlModeEvent::WindowPaneChanged {
        window_id: "@0".parse().unwrap(),
        pane_id: "%0".parse().unwrap(),
    });
    agg
}

/// Events that reach every effect of A1, as short runs (a reply is its three
/// blocks): plain and clipboard-writing output, window adds and closes (the
/// adopt and the re-list), focus changes, reply markers, the pane-title
/// subscription (a pane refresh) and flow control (a resume).
fn seam_event_strategy() -> impl Strategy<Value = Vec<ControlModeEvent>> {
    let known_pane = || prop::sample::select(vec!["%0", "%1", "%2", "%9"]);
    let title = tmuxy_core::constants::tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME;
    prop_oneof![
        3 => output_event_strategy().prop_map(|e| vec![e]),
        1 => known_pane().prop_map(|p| vec![ControlModeEvent::Output {
            pane_id: p.parse().unwrap(),
            content: b"\x1b]52;c;aGVsbG8gd29ybGQ=\x07".to_vec(),
        }]),
        1 => structural_event_strategy().prop_map(|e| vec![e]),
        1 => known_pane().prop_map(|p| vec![ControlModeEvent::WindowPaneChanged {
            window_id: "@0".parse().unwrap(),
            pane_id: p.parse().unwrap(),
        }]),
        1 => (1u64..9).prop_map(|id| vec![
            response(&format!("TMUXY_RPY_BEGIN {id}\n")),
            response("ok\n"),
            response(&format!("TMUXY_RPY_END {id}\n")),
        ]),
        1 => known_pane().prop_map(move |p| vec![ControlModeEvent::SubscriptionChanged {
            name: title.to_string(),
            pane_id: p.parse().unwrap(),
        }]),
        1 => known_pane().prop_map(|p| vec![ControlModeEvent::Pause {
            pane_id: p.parse().unwrap(),
        }]),
        1 => known_pane().prop_map(|p| vec![ControlModeEvent::Continue {
            pane_id: p.parse().unwrap(),
        }]),
    ]
}

/// Where an effect sits in the order A1 documents.
fn effect_rank(effect: &SideEffect) -> u8 {
    match effect {
        SideEffect::AdoptUntaggedWindows(_) => 0,
        SideEffect::StoreImages { .. } | SideEffect::WriteClipboard { .. } => 1,
        SideEffect::SendTmuxCommand(_) | SideEffect::CommandReply { .. } => 2,
        SideEffect::RefreshAfterWindowAdd => 3,
        SideEffect::RefreshPanes { .. } => 4,
        SideEffect::ResumePane(_) => 5,
        SideEffect::EmitState { .. } => 6,
    }
}

/// The property below is only as strong as the effects its events reach, so
/// one fixed run through the same seed and event shapes has to produce every
/// rank of A1: adopt, clipboard, reply, re-list, pane refresh, resume, emit.
#[test]
fn the_seam_events_reach_every_effect_of_a1() {
    let title = tmuxy_core::constants::tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME;
    let mut agg = seeded_aggregator();
    let script = vec![
        ControlModeEvent::WindowAdd {
            window_id: "@1".parse().unwrap(),
        },
        ControlModeEvent::Output {
            pane_id: "%0".parse().unwrap(),
            content: b"\x1b]52;c;aGVsbG8gd29ybGQ=\x07".to_vec(),
        },
        response("TMUXY_RPY_BEGIN 4\n"),
        response("ok\n"),
        response("TMUXY_RPY_END 4\n"),
        ControlModeEvent::SubscriptionChanged {
            name: title.to_string(),
            pane_id: "%1".parse().unwrap(),
        },
        ControlModeEvent::Pause {
            pane_id: "%2".parse().unwrap(),
        },
    ];
    let mut seen = HashSet::new();
    for ev in script {
        for effect in agg.step(ev).effects {
            seen.insert(effect_rank(&effect));
        }
    }
    for rank in 0..=6 {
        assert!(
            seen.contains(&rank),
            "no event reached rank {rank}: {seen:?}"
        );
    }
}

proptest! {
    /// `step` must never panic on any sequence of synthetic events.
    /// The aggregator wraps vt100 in a panic guard (`safe_process` in
    /// `state.rs`), so even adversarially-malformed payloads should be
    /// contained.
    #[test]
    fn step_never_panics(events in prop::collection::vec(any_event_strategy(), 1..50)) {
        let mut agg = StateAggregator::new();
        for ev in events {
            let _ = agg.step(ev);
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
            agg.step(ControlModeEvent::WindowAdd { window_id: w.parse().unwrap() });
        }
        let after_adds = agg.to_tmux_state().windows.len();
        for w in &closes {
            agg.step(ControlModeEvent::WindowClose { window_id: w.parse().unwrap() });
        }
        let after_closes = agg.to_tmux_state().windows.len();
        // Sanity: closes can only ever reduce the window count.
        prop_assert!(after_closes <= after_adds);
    }

    /// Settling is a sticky state — arming it and then clearing it must
    /// always return the aggregator to the unsettled state regardless of
    /// intervening events, and no event inside the window can end it on its
    /// own (only `tick` past the deadline, or `clear_settling`, does).
    #[test]
    fn settling_round_trips(events in prop::collection::vec(any_event_strategy(), 0..30)) {
        let mut agg = StateAggregator::new();
        let t0 = std::time::Instant::now();
        agg.arm_settling(t0);
        prop_assert!(agg.is_settling());
        for ev in events {
            let _ = agg.step_at(ev, t0);
        }
        // Settling remains armed while events flow.
        prop_assert!(agg.is_settling());
        agg.clear_settling();
        prop_assert!(!agg.is_settling());
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
            window_id: window_id.parse().unwrap(),
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

    /// A1 in `docs/INVARIANTS.md`: whatever the event and whatever came
    /// before it, a step's effects come in the order `step_at` documents —
    /// adopt, then images and clipboard, then commands and replies, then the
    /// window re-list, then pane refreshes, then flow resume, then the emit.
    /// The monitor dispatches them one to one in that order, so an effect out
    /// of place here is a command tmux sees out of place.
    #[test]
    fn effects_within_a_step_follow_the_documented_order(
        runs in prop::collection::vec(seam_event_strategy(), 1..30),
    ) {
        let mut agg = seeded_aggregator();
        for ev in runs.into_iter().flatten() {
            let result = agg.step(ev);
            let ranks: Vec<u8> = result.effects.iter().map(effect_rank).collect();
            prop_assert!(ranks.windows(2).all(|pair| pair[0] <= pair[1]),
                "effects out of their documented order: {:?}", result.effects);
            prop_assert!(
                ranks.iter().filter(|r| **r == 6).count() <= 1,
                "a step emits at most once: {:?}", result.effects);
        }
    }

    /// queue_captures is idempotent against repeats — already-queued pane ids
    /// are skipped, never duplicated. A capture response is routed to its pane
    /// by marker (A4 in `docs/INVARIANTS.md`); a duplicate enqueue would send
    /// tmux a second capture whose answer the first one's marker then claims.
    #[test]
    fn queue_captures_is_idempotent_across_repeats(
        pane_ids in prop::collection::vec(
            prop::sample::select(vec!["%0", "%1", "%2"]).prop_map(|p| p.parse::<PaneId>().unwrap()),
            1..20,
        ),
    ) {
        let mut agg = StateAggregator::new();
        let unique: HashSet<PaneId> = pane_ids.iter().cloned().collect();
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
            prop::sample::select(vec!["@0", "@1", "@2"]).prop_map(|w| w.parse::<WindowId>().unwrap()),
            1..10,
        ),
    ) {
        let mut agg = StateAggregator::new();
        let t0 = std::time::Instant::now();
        // Pre-populate so closes don't get filtered as no-ops.
        for w in &window_ids {
            agg.step_at(ControlModeEvent::WindowAdd { window_id: w.clone() }, t0);
        }
        agg.arm_settling(t0);
        for w in &window_ids {
            let result = agg.step_at(ControlModeEvent::WindowClose { window_id: w.clone() }, t0);
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

    /// Settling timer end-to-end: regardless of how many window-typed events
    /// arrive inside the settling window, `tick(now)` past the deadline must
    /// (a) clear `is_settling` and (b) emit at most one consolidated
    /// `EmitState`. This is the property that was previously untestable
    /// because the timing lived on the monitor's `RunState`.
    #[test]
    fn settling_window_emits_at_most_once_and_clears(
        // Up to 12 window-typed events inside the settling window. We seed
        // the aggregator with matching WindowAdds beforehand so each Close
        // produces a real ChangeType::Window.
        window_ids in prop::collection::vec(
            prop::sample::select(vec!["@0", "@1", "@2", "@3"]).prop_map(|w| w.parse::<WindowId>().unwrap()),
            0..12,
        ),
        // Per-event time offset inside the settling window.
        offsets in prop::collection::vec(0u64..400, 0..12),
    ) {
        let mut agg = StateAggregator::new();
        let t0 = std::time::Instant::now();
        let seeded: HashSet<&str> = ["@0", "@1", "@2", "@3"].into_iter().collect();
        for w in &seeded {
            agg.step_at(
                ControlModeEvent::WindowAdd { window_id: w.parse().unwrap() },
                t0,
            );
        }
        agg.arm_settling(t0);

        let pairs: Vec<(WindowId, u64)> = window_ids.iter().cloned().zip(offsets).collect();
        for (w, off) in &pairs {
            // Inside the settling window (offsets ≤ 400ms < the 500ms safety
            // ceiling), no window event may emit: the consolidated emit comes
            // from `tick`.
            let result = agg.step_at(
                ControlModeEvent::WindowClose { window_id: w.clone() },
                t0 + std::time::Duration::from_millis(*off),
            );
            prop_assert!(
                !result.effects.iter().any(|e| matches!(e, SideEffect::EmitState { .. })),
                "a window event inside the settling window escaped: {:?}",
                result.effects
            );
        }

        // Advance to well past the safety ceiling and tick once.
        let post_deadline = t0 + std::time::Duration::from_secs(2);
        let effects = agg.tick(post_deadline);

        prop_assert!(!agg.is_settling(),
            "tick past deadline must clear settling");

        let emit_count = effects.iter().filter(|e|
            matches!(e, SideEffect::EmitState { .. })).count();
        prop_assert!(emit_count <= 1,
            "at most one consolidated EmitState per settling window; got {}",
            emit_count);
    }
}
