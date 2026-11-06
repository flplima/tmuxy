use proptest::prelude::*;
use tmuxy_core::control_mode::{
    Batch, ControlModeEvent, Notice, SideEffect, StateAggregator, BUFFER_BEGIN_MARKER,
    BUFFER_END_MARKER, CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER, LIST_BEGIN_MARKER,
    LIST_END_MARKER, REPLY_BEGIN_MARKER, REPLY_END_MARKER,
};

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

/// Bytes a shell can print, weighted towards what drives the emulator's
/// edge cases: cursor motion and erases with out-of-range counts, scroll
/// regions, wide and combining characters at the right edge, DEC
/// double-width lines, OSC 66 text sizing and stray escapes, mixed with
/// arbitrary bytes.
pub fn terminal_bytes_strategy() -> impl Strategy<Value = Vec<u8>> {
    let count = || {
        prop_oneof![
            Just(0u32),
            1u32..4,
            Just(999),
            Just(u32::from(u16::MAX) + 1)
        ]
    };
    let fragment = prop_oneof![
        3 => prop::collection::vec(any::<u8>(), 0..8),
        3 => (count(), count(), prop::sample::select(b"ABCDEFGHJKLMPSTXZ@`abdefghlmnqrstu".to_vec()))
            .prop_map(|(a, b, f)| format!("\x1b[{a};{b}{}", f as char).into_bytes()),
        1 => (count(), prop::sample::select(b"hlJK".to_vec()))
            .prop_map(|(a, f)| format!("\x1b[?{a}{}", f as char).into_bytes()),
        1 => prop::sample::select(vec![
            "\x1b#3", "\x1b#4", "\x1b#5", "\x1b#6", "\x1b#8", "\x1bM", "\x1bD", "\x1bE",
            "\x1b7", "\x1b8", "\x1bc", "\x1b[r", "\r", "\n", "\t", "\x08",
        ])
        .prop_map(|s| s.as_bytes().to_vec()),
        2 => prop::sample::select(vec!["漢", "ＡＢ", "e\u{301}", "\u{200d}", "👍🏽", "x"])
            .prop_map(|s| s.repeat(3).into_bytes()),
        1 => (1u32..9, 0u32..4).prop_map(|(scale, width)|
            format!("\x1b]66;s={scale}:w={width};漢x\x07").into_bytes()),
    ];
    prop::collection::vec(fragment, 1..12).prop_map(|parts| parts.concat())
}

/// A pane side as tmux could report it: degenerate (0 to 2 cells), ordinary,
/// or one past what a `u16` holds (which a cast would wrap to 0).
fn pane_side() -> impl Strategy<Value = u32> {
    prop_oneof![0u32..3, 3u32..120, Just(65_536)]
}

/// Every event the monitor can hand `step`, aimed at the panes
/// [`seeded_aggregator`] knows (and one it does not), so output and resizes
/// reach the emulator: hostile output, layouts and pane lists that resize
/// the grid down to nothing, captures of anything, and the structural and
/// seam events.
pub fn emulator_event_strategy() -> impl Strategy<Value = Vec<ControlModeEvent>> {
    let pane = || prop::sample::select(vec!["%0", "%1", "%2", "%9"]);
    prop_oneof![
        4 => (pane(), terminal_bytes_strategy()).prop_map(|(p, content)| vec![
            ControlModeEvent::Output { pane_id: p.parse().unwrap(), content },
        ]),
        1 => (pane_side(), pane_side(), pane_side()).prop_map(|(w0, w1, h)| {
            let layout = format!(
                "abcd,{}x{h},0,0{{{w0}x{h},0,0,0,{w1}x{h},{},0,1}}",
                w0 + w1 + 1,
                w0 + 1
            );
            vec![ControlModeEvent::LayoutChange {
                window_id: "@0".parse().unwrap(),
                layout: layout.clone(),
                visible_layout: layout,
                flags: "*".to_string(),
            }]
        }),
        1 => (pane_side(), pane_side()).prop_map(|(w, h)| vec![
            response("TMUXY_LS_BEGIN panes"),
            response(&format!("%2,2,0,0,{w},{h},0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,,")),
            response("TMUXY_LS_END"),
        ]),
        1 => (prop::sample::select(vec!["%0", "%1", "%2"]), terminal_bytes_strategy())
            .prop_map(|(p, content)| vec![
                response(&format!("TMUXY_CAP_BEGIN {}", &p[1..])),
                response(&String::from_utf8_lossy(&content)),
                response("TMUXY_CAP_END"),
            ]),
        2 => seam_event_strategy(),
    ]
}

/// A `%begin`/`%end` block as the parser hands it over.
pub fn response(output: &str) -> ControlModeEvent {
    ControlModeEvent::CommandResponse {
        output: output.to_string(),
        success: true,
    }
}

/// `event` as `agg`'s connection would carry it: a block that starts with a
/// marker's name (what the strategies here generate, unsigned) gets `agg`'s
/// token after the name, as the aggregator's own marker commands print it.
pub fn signed(agg: &StateAggregator, event: ControlModeEvent) -> ControlModeEvent {
    let ControlModeEvent::CommandResponse { output, success } = event else {
        return event;
    };
    let markers = [
        REPLY_BEGIN_MARKER,
        REPLY_END_MARKER,
        CAPTURE_BEGIN_MARKER,
        CAPTURE_END_MARKER,
        BUFFER_BEGIN_MARKER,
        BUFFER_END_MARKER,
        LIST_BEGIN_MARKER,
        LIST_END_MARKER,
    ];
    let output = markers
        .iter()
        .find_map(|marker| {
            let rest = output.strip_prefix(marker)?;
            (rest.is_empty() || rest.starts_with([' ', '\n']))
                .then(|| format!("{}{rest}", agg.markers().tag(marker)))
        })
        .unwrap_or(output);
    ControlModeEvent::CommandResponse { output, success }
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
    agg.step(signed(&agg, response("TMUXY_LS_BEGIN panes")));
    agg.step(response(
        "%0,0,0,0,80,12,0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,,\n\
         %1,1,0,13,80,11,0,0,0,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,,\n\
         %2,2,40,13,40,11,0,0,0,sleep,,1,0,0,0,@0, ,0,0,0,,,,0,,,,,,,",
    ));
    agg.step(signed(&agg, response("TMUXY_LS_END")));
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

/// The effect's variant (a batch's purpose for a send), for the coverage
/// check.
pub fn effect_kind(effect: &SideEffect) -> &'static str {
    match effect {
        SideEffect::Send { batch, .. } => match batch {
            Batch::WindowSetup => "Send(WindowSetup)",
            Batch::Own => "Send(Own)",
            Batch::WindowRelist => "Send(WindowRelist)",
            Batch::PaneRefresh => "Send(PaneRefresh)",
            Batch::Resume => "Send(Resume)",
        },
        SideEffect::Notify(Notice::Images { .. }) => "Notify(Images)",
        SideEffect::Notify(Notice::Clipboard { .. }) => "Notify(Clipboard)",
        SideEffect::Notify(Notice::Message(_)) => "Notify(Message)",
        SideEffect::Notify(Notice::Error(_)) => "Notify(Error)",
        SideEffect::Reply { .. } => "Reply",
        SideEffect::Emit(_) => "Emit",
    }
}

/// Where an effect sits in the order A1 documents.
pub fn effect_rank(effect: &SideEffect) -> u8 {
    match effect {
        SideEffect::Send {
            batch: Batch::WindowSetup,
            ..
        } => 0,
        SideEffect::Notify(_) => 1,
        SideEffect::Send {
            batch: Batch::Own, ..
        }
        | SideEffect::Reply { .. } => 2,
        SideEffect::Send {
            batch: Batch::WindowRelist,
            ..
        } => 3,
        SideEffect::Send {
            batch: Batch::PaneRefresh,
            ..
        } => 4,
        SideEffect::Send {
            batch: Batch::Resume,
            ..
        } => 5,
        SideEffect::Emit(_) => 6,
    }
}
