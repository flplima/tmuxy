//! Property-based tests for the `StateAggregator` state machine.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use proptest::prelude::*;
use std::collections::HashSet;
use tmuxy_core::control_mode::{Batch, ChangeType, ControlModeEvent, SideEffect, StateAggregator};
use tmuxy_core::{PaneId, WindowId};

mod common_aggregator_props;
use common_aggregator_props::*;

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
        ControlModeEvent::Output {
            pane_id: "%1".parse().unwrap(),
            content: b"\x1b]1337;File=inline=1;width=10;height=5:iVBORw0KGgo=\x07".to_vec(),
        },
        ControlModeEvent::PasteBufferChanged {
            buffer_name: "buffer0".to_string(),
        },
    ];
    let mut seen = HashSet::new();
    for ev in script {
        for effect in agg.step(signed(&agg, ev)).effects {
            seen.insert(effect_kind(&effect));
        }
    }
    for kind in [
        "Send(WindowSetup)",
        "Notify(Images)",
        "Notify(Clipboard)",
        "Send(Own)",
        "Reply",
        "Send(WindowRelist)",
        "Send(PaneRefresh)",
        "Send(Resume)",
        "Emit",
    ] {
        assert!(seen.contains(kind), "no event reached {kind}: {seen:?}");
    }
}

proptest! {
    /// `step` must never panic, whatever tmux and the panes send: nothing
    /// can catch one. The release profile is `panic = "abort"`, so a panic
    /// ends the whole server or desktop app, and in the browser it traps the
    /// wasm module. The events start from an attached session's panes, so
    /// output, captures and resizes down to a 0-cell side all reach the
    /// emulator.
    #[test]
    fn step_never_panics(runs in prop::collection::vec(emulator_event_strategy(), 1..40)) {
        let mut agg = seeded_aggregator();
        for ev in runs.into_iter().flatten() {
            let _ = agg.step(signed(&agg, ev));
        }
    }

    /// The window count is the windows added and not closed since: an add
    /// of a window already there is one window, and a close of one that does
    /// not exist is a no-op, not an error.
    #[test]
    fn window_count_matches_add_close_delta(
        adds in prop::collection::vec(prop::sample::select(vec!["@0", "@1", "@2", "@3"]), 0..10),
        closes in prop::collection::vec(prop::sample::select(vec!["@0", "@1", "@2", "@3"]), 0..10),
    ) {
        let mut agg = StateAggregator::new();
        for w in &adds {
            agg.step(ControlModeEvent::WindowAdd { window_id: w.parse().unwrap() });
        }
        let added: HashSet<&str> = adds.iter().copied().collect();
        prop_assert_eq!(agg.window_ids().len(), added.len());
        for w in &closes {
            agg.step(ControlModeEvent::WindowClose { window_id: w.parse().unwrap() });
        }
        let closed: HashSet<&str> = closes.iter().copied().collect();
        prop_assert_eq!(agg.window_ids().len(), added.difference(&closed).count());
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
        prop_assert!(agg.is_settling());
        agg.clear_settling();
        prop_assert!(!agg.is_settling());
    }

    /// State-delta consistency: every `Emit` effect must carry a non-None
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
                if let SideEffect::Emit(change) = effect {
                    prop_assert_ne!(*change, ChangeType::None,
                        "Emit must carry a real change type");
                    prop_assert_eq!(*change, result.change_type,
                        "Emit change must match step's reported change_type");
                }
            }
        }
    }

    /// Window-add ↔ capture-pane reconciliation: every WindowAdd step must
    /// emit the window re-list, and that effect type must arrive BEFORE
    /// any Emit in the same step (so the monitor issues list-panes
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
            matches!(e, SideEffect::Send { batch: Batch::WindowRelist, .. }));
        let emit_idx = result.effects.iter().position(|e|
            matches!(e, SideEffect::Emit(_)));
        prop_assert!(refresh_idx.is_some(),
            "WindowAdd must emit the window re-list");
        if let (Some(r), Some(e)) = (refresh_idx, emit_idx) {
            prop_assert!(r < e,
                "the window re-list ({}) must precede Emit ({}) in effect order",
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
            let result = agg.step(signed(&agg, ev));
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
        prop_assert_eq!(queued.len(), unique.len(),
            "first queue should match the number of distinct ids");
        let requeued = agg.queue_captures(&pane_ids);
        prop_assert!(requeued.is_empty(),
            "re-queueing the same ids should be a no-op");
    }

    /// When window emissions are suppressed, no SideEffect::Emit should
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
                matches!(e, SideEffect::Emit(_)));
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
    /// arrive inside the settling window, none of them emits, and `tick(now)`
    /// past the deadline clears `is_settling` (it returns at most one
    /// consolidated emission by its type).
    #[test]
    fn settling_window_emits_at_most_once_and_clears(
        // Up to 12 window-typed events inside the settling window. We seed
        // the aggregator with matching WindowAdds beforehand so each Close
        // produces a real ChangeType::Window.
        window_ids in prop::collection::vec(
            prop::sample::select(vec!["@0", "@1", "@2", "@3"]).prop_map(|w| w.parse::<WindowId>().unwrap()),
            0..12,
        ),
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
                !result.effects.iter().any(|e| matches!(e, SideEffect::Emit(_))),
                "a window event inside the settling window escaped: {:?}",
                result.effects
            );
        }

        // Advance to well past the safety ceiling and tick once.
        let post_deadline = t0 + std::time::Duration::from_secs(2);
        agg.tick(post_deadline);

        prop_assert!(!agg.is_settling(),
            "tick past deadline must clear settling");
    }
}

/// What a pane can make a block say: anything, and in particular every
/// marker's words — bare, with a made-up token, with an id — and tmux-shaped
/// rows. Pane output reaches the aggregator inside capture and query blocks.
fn hostile_block() -> impl Strategy<Value = String> {
    let marker = || {
        prop::sample::select(vec![
            "TMUXY_CAP_BEGIN",
            "TMUXY_CAP_END",
            "TMUXY_RPY_BEGIN",
            "TMUXY_RPY_END",
            "TMUXY_BUF_BEGIN",
            "TMUXY_BUF_END",
            "TMUXY_LS_BEGIN",
            "TMUXY_LS_END",
        ])
    };
    prop_oneof![
        ".{0,40}",
        (marker(), 0u64..4).prop_map(|(m, id)| format!("{m} {id}")),
        marker().prop_map(str::to_string),
        (marker(), "[0-9a-f]{32}", 0u64..4).prop_map(|(m, token, id)| format!("{m} {token} {id}")),
        Just("%7,0,0,0,80,24,0,0,1,zsh,,0,0,0,0,@7,,0,0,0,0,0,10".to_string()),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// A13: the block after a capture's BEGIN is that pane's capture whatever
    /// the pane shows, and the capture is no longer pending once it lands —
    /// a pane showing `TMUXY_CAP_END` once left its capture pending forever,
    /// and every client's first state waited on it.
    #[test]
    fn a_capture_lands_on_its_pane_whatever_the_pane_shows(content in hostile_block()) {
        let mut agg = seeded_aggregator();
        // The seed's own steps sent %1's capture, and asked for it again
        // while it was in flight (the list, then the window focus): once
        // the block lands as %1's, that second capture follows it.
        let pane: PaneId = "%1".parse().unwrap();
        agg.step(signed(&agg, response("TMUXY_CAP_BEGIN 1")));
        let landed = agg.step(response(&content));
        prop_assert_eq!(landed.change_type, ChangeType::Output, "the block is a capture");
        let follow_up = format!("capture-pane -t {pane} ");
        prop_assert!(
            landed.effects.iter().any(|e| matches!(e,
                SideEffect::Send { batch: Batch::PaneRefresh, commands }
                    if commands.iter().any(|c| c.contains(&follow_up)))),
            "the block was %1's capture, so %1 is free for the next: {:?}", landed.effects
        );
        agg.step(signed(&agg, response("TMUXY_CAP_END")));
    }

    /// A13: a reply is everything between its own markers. No block a pane
    /// prints into a query — marker words included — opens another reply,
    /// closes this one early, or hands it to another caller.
    #[test]
    fn a_reply_is_what_lies_between_its_own_markers(
        id in 1u64..4,
        body in prop::collection::vec(hostile_block(), 0..6),
    ) {
        let mut agg = seeded_aggregator();
        let mut blocks = vec![signed(&agg, response(&format!("TMUXY_RPY_BEGIN {id}")))];
        blocks.extend(body.iter().map(|b| response(b)));
        blocks.push(signed(&agg, response(&format!("TMUXY_RPY_END {id}"))));
        let mut replies = Vec::new();
        for block in blocks {
            for effect in agg.step(block).effects {
                if let SideEffect::Reply { id, output, error } = effect {
                    replies.push((id, output, error));
                }
            }
        }
        let expected = body
            .iter()
            .filter(|b| !b.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        prop_assert_eq!(replies, vec![(id, expected, None)]);
    }
}
