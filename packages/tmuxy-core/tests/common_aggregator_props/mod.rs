use proptest::prelude::*;
use tmuxy_core::control_mode::{
    ControlModeEvent, SideEffect, StateAggregator, BUFFER_BEGIN_MARKER, BUFFER_END_MARKER,
    CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER, REPLY_BEGIN_MARKER, REPLY_END_MARKER,
};

/// Generate a synthetic `Output` event with a small randomised payload.
/// Pane id values are biased to a small pool so the aggregator actually has
/// repeat hits to track instead of every event creating a fresh state.
pub fn output_event_strategy() -> impl Strategy<Value = ControlModeEvent> {
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
pub fn structural_event_strategy() -> impl Strategy<Value = ControlModeEvent> {
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

pub fn any_event_strategy() -> impl Strategy<Value = ControlModeEvent> {
    prop_oneof![
        4 => output_event_strategy(),
        1 => structural_event_strategy(),
    ]
}

/// A `%begin`/`%end` block as the parser hands it over.
pub fn response(output: &str) -> ControlModeEvent {
    ControlModeEvent::CommandResponse {
        timestamp: 0,
        command_num: 0,
        output: output.to_string(),
        success: true,
    }
}

/// `event` as `agg`'s connection would carry it: a block that starts with a
/// marker's name (what the strategies here generate, unsigned) gets `agg`'s
/// token after the name, as the aggregator's own marker commands print it.
pub fn signed(agg: &StateAggregator, event: ControlModeEvent) -> ControlModeEvent {
    let ControlModeEvent::CommandResponse {
        timestamp,
        command_num,
        output,
        success,
    } = event
    else {
        return event;
    };
    let markers = [
        REPLY_BEGIN_MARKER,
        REPLY_END_MARKER,
        CAPTURE_BEGIN_MARKER,
        CAPTURE_END_MARKER,
        BUFFER_BEGIN_MARKER,
        BUFFER_END_MARKER,
    ];
    let output = markers
        .iter()
        .find_map(|marker| {
            let rest = output.strip_prefix(marker)?;
            (rest.is_empty() || rest.starts_with([' ', '\n']))
                .then(|| format!("{}{rest}", agg.markers().tag(marker)))
        })
        .unwrap_or(output);
    ControlModeEvent::CommandResponse {
        timestamp,
        command_num,
        output,
        success,
    }
}

/// A pane the aggregator knows (`%0`, `%1`, `%2` in window `@0`, `%2` in copy
/// mode), the window active with `%0` focused — what an attached monitor has
/// after its initial sync, and what the output, clipboard, image, paste
/// buffer, pause and refresh paths all gate on.
pub fn seeded_aggregator() -> StateAggregator {
    let mut agg = StateAggregator::new();
    agg.step(ControlModeEvent::WindowAdd {
        window_id: "@0".parse().unwrap(),
    });
    agg.step(response(
        "%0,0,0,0,80,12,0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,\n\
         %1,1,0,13,80,11,0,0,0,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,\n\
         %2,2,40,13,40,11,0,0,0,sleep,,1,0,0,0,@0, ,0,0,0,,,,0,,,,,,",
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
/// blocks, its markers unsigned — feed them through `signed`): plain and clipboard-writing output, window adds and closes (the
/// adopt and the re-list), focus changes, reply markers, the pane-title
/// subscription (a pane refresh) and flow control (a resume).
pub fn seam_event_strategy() -> impl Strategy<Value = Vec<ControlModeEvent>> {
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
        1 => known_pane().prop_map(|p| vec![ControlModeEvent::Output {
            pane_id: p.parse().unwrap(),
            content: b"\x1b]1337;File=inline=1;width=10;height=5:iVBORw0KGgo=\x07".to_vec(),
        }]),
        1 => Just(vec![ControlModeEvent::PasteBufferChanged {
            buffer_name: "buffer0".to_string(),
        }]),
    ]
}

/// The effect's variant, for the coverage check.
pub fn effect_kind(effect: &SideEffect) -> &'static str {
    match effect {
        SideEffect::AdoptUntaggedWindows(_) => "AdoptUntaggedWindows",
        SideEffect::StoreImages { .. } => "StoreImages",
        SideEffect::WriteClipboard { .. } => "WriteClipboard",
        SideEffect::SendTmuxCommand(_) => "SendTmuxCommand",
        SideEffect::CommandReply { .. } => "CommandReply",
        SideEffect::RefreshAfterWindowAdd => "RefreshAfterWindowAdd",
        SideEffect::RefreshPanes { .. } => "RefreshPanes",
        SideEffect::ResumePane(_) => "ResumePane",
        SideEffect::EmitState { .. } => "EmitState",
    }
}

/// Where an effect sits in the order A1 documents.
pub fn effect_rank(effect: &SideEffect) -> u8 {
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
