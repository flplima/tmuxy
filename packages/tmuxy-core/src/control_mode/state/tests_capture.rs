use super::tests::*;
use super::*;
use crate::ids::test_ids::{pid, wid};

/// A response between the capture markers is attributed to exactly the
/// pane named by the BEGIN marker — and unmarked responses (e.g. a
/// send-keys ack with EMPTY output, indistinguishable in shape from
/// capturing a blank pane) can never steal a pending capture. This was
/// the pane-content-misattribution bug: under command churn one pane
/// rendered another pane's capture, or none at all.
#[test]
fn capture_routing_is_marker_exact_and_theft_proof() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    seed_pane(&mut agg, "%1", "@0");
    agg.queue_captures(&[pid("%0"), pid("%1")]);

    let response = |output: &str| ControlModeEvent::CommandResponse {
        output: output.to_string(),
        success: true,
    };

    // An interleaved unmarked ack (empty output) — must NOT be consumed
    // as a capture for %0.
    let r = agg.process_event(response(""));
    assert!(
        !matches!(r.change_type, ChangeType::Output),
        "unmarked empty ack must not be routed as a capture"
    );

    // %1's capture arrives FIRST (marker-bracketed) — attribution must
    // follow the marker, not the queue order.
    agg.process_event(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "1")));
    let r = agg.process_event(response("PANE_ONE_CONTENT\n"));
    assert!(
        r.change_type == ChangeType::Output,
        "marked capture must be attributed to the pane in the marker"
    );
    agg.process_event(response(&marked(&agg, CAPTURE_END_MARKER, "")));
    assert_eq!(
        agg.panes.get_mut("%1").unwrap().get_content()[0]
            .iter()
            .map(|c| c.char.clone())
            .collect::<String>()
            .trim_end(),
        "PANE_ONE_CONTENT"
    );

    // %0's capture follows and lands in %0 — no shifted attribution.
    agg.process_event(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "0")));
    let r = agg.process_event(response("PANE_ZERO_CONTENT\n"));
    assert!(r.change_type == ChangeType::Output);
    agg.process_event(response(&marked(&agg, CAPTURE_END_MARKER, "")));
    assert_eq!(
        agg.panes.get_mut("%0").unwrap().get_content()[0]
            .iter()
            .map(|c| c.char.clone())
            .collect::<String>()
            .trim_end(),
        "PANE_ZERO_CONTENT"
    );

    // Both in-flight entries were consumed.
    assert!(agg.pending_captures.is_empty());
}

/// tmux 3.7 strftime-expands display-message output: `%<digits>` in a
/// marker comes back mangled (observed: 67 spaces of padding). The id
/// therefore travels as bare digits and the router must tolerate
/// arbitrary padding around it.
#[test]
fn capture_marker_survives_strftime_padding() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%69", "@0");
    agg.queue_captures(&[pid("%69")]);

    let response = |output: &str| ControlModeEvent::CommandResponse {
        output: output.to_string(),
        success: true,
    };
    // Expansion padding around the id, as tmux 3.7 printed it around a
    // `%<digits>`.
    agg.process_event(response(&format!(
        "{}                    69\n",
        agg.markers().tag(CAPTURE_BEGIN_MARKER)
    )));
    let r = agg.process_event(response("PADDED_OK\n"));
    assert!(r.change_type == ChangeType::Output);
    agg.process_event(response(&marked(&agg, CAPTURE_END_MARKER, "")));
    assert!(agg.pending_captures.is_empty());
}

/// A marked capture for a pane killed mid-flight is discarded — and its
/// in-flight entry is released so content preservation can't wedge.
#[test]
fn capture_for_dead_pane_is_discarded_and_released() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    agg.queue_captures(&[pid("%9")]);

    let response = |output: &str| ControlModeEvent::CommandResponse {
        output: output.to_string(),
        success: true,
    };
    agg.process_event(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "9")));
    let r = agg.process_event(response("GHOST\n"));
    assert!(!matches!(r.change_type, ChangeType::Output));
    agg.process_event(response(&marked(&agg, CAPTURE_END_MARKER, "")));
    assert!(agg.pending_captures.is_empty());
}

/// What tmux actually sends for a capture of a pane that is gone: the
/// `capture-pane` block is an `%error`, and the END marker never comes —
/// a control-mode line is one command group, and an error drops the rest
/// of the group (`cmdq_remove_group`). The pane is released on the error
/// alone, and the next unrelated block is not taken for its content.
#[test]
fn a_failed_capture_releases_its_pane_without_an_end_marker() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    agg.queue_captures(&[pid("%9")]);

    let block = |output: &str, success: bool| ControlModeEvent::CommandResponse {
        output: output.to_string(),
        success,
    };
    agg.process_event(block(&marked(&agg, CAPTURE_BEGIN_MARKER, "9"), true));
    agg.process_event(block("can't find pane: %9\n", false));
    assert!(agg.pending_captures.is_empty());
    assert!(agg.armed.is_none());

    let r = agg.process_event(block("GHOST\n", true));
    assert!(!matches!(r.change_type, ChangeType::Output));
    assert!(agg.pending_captures.is_empty());
}

#[test]
fn osc52_clipboard_write_propagates_to_result() {
    // OSC 52 base64-encoded "hello world" payload — what an app like
    // `printf '\e]52;c;%s\e\\' "$(printf hello\ world | base64)'` sends.
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");

    let event = ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"\x1b]52;c;aGVsbG8gd29ybGQ=\x07".to_vec(),
    };

    let result = agg.process_event(event);

    assert_eq!(
        result.clipboard_writes,
        vec![(Some(pid("%0")), "hello world".to_string())],
        "OSC 52 sequence must surface as a clipboard write on the event result"
    );
}

/// SEC-01. One write per pane per `MIN_CLIPBOARD_INTERVAL`: a program
/// writing the clipboard in a loop gets its first write and no more until
/// the interval has passed.
#[test]
fn a_pane_writing_the_clipboard_in_a_loop_is_rate_limited() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    let write = || ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"\x1b]52;c;aGVsbG8gd29ybGQ=\x07".to_vec(),
    };

    assert_eq!(agg.process_event(write()).clipboard_writes.len(), 1);
    assert!(
        agg.process_event(write()).clipboard_writes.is_empty(),
        "a second write inside the interval is dropped"
    );

    // Once the interval has passed the pane may write again.
    let earlier = Instant::now() - MIN_CLIPBOARD_INTERVAL;
    agg.panes.get_mut("%0").unwrap().last_clipboard_write = Some(earlier);
    assert_eq!(agg.process_event(write()).clipboard_writes.len(), 1);
}

/// SEC-13. A paste buffer is server-global and `%paste-buffer-changed`
/// names no origin, so it is read (in-band, marker-wrapped) only while a
/// pane of this session is in copy mode — the trace a yank leaves. Both
/// hosts share this arm, so both have the gate.
#[test]
fn a_paste_buffer_change_is_read_only_while_a_pane_is_in_copy_mode() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    let changed = || ControlModeEvent::PasteBufferChanged {
        buffer_name: "buffer0".to_string(),
    };

    let outside = agg.step(changed());
    assert!(
        !outside.effects.iter().any(|e| matches!(
            e,
            SideEffect::Send {
                batch: Batch::Own,
                ..
            }
        )),
        "no pane in copy mode: the buffer is not read ({:?})",
        outside.effects
    );

    enter_copy_mode(&mut agg, "%0", "@0");
    let inside = agg.step(changed());
    let read = inside
        .effects
        .iter()
        .find_map(|e| match e {
            SideEffect::Send {
                batch: Batch::Own,
                commands,
            } => commands.first().map(String::as_str),
            _ => None,
        })
        .expect("a pane in copy mode: the buffer is read over the control channel");
    assert!(
        read.contains(&agg.markers().tag(BUFFER_BEGIN_MARKER))
            && read.contains("show-buffer -b 'buffer0'")
    );
}

/// tmuxy stages its own pastes in `tmuxy-paste` (the client, a chunk at a
/// time) and `tmuxy-cli-paste-<pid>` (`tmuxy pane paste`): a paste into one pane
/// while another is in copy mode is not a yank, and is never read back into
/// the clipboard.
#[test]
fn tmuxys_own_paste_buffers_are_never_read_back() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    enter_copy_mode(&mut agg, "%0", "@0");
    for name in ["tmuxy-paste", "tmuxy-cli-paste-4242"] {
        let step = agg.step(ControlModeEvent::PasteBufferChanged {
            buffer_name: name.to_string(),
        });
        assert!(
            !step.effects.iter().any(|e| matches!(
                e,
                SideEffect::Send {
                    batch: Batch::Own,
                    ..
                }
            )),
            "{name} was read: {:?}",
            step.effects
        );
    }
}

/// A buffer is named by whoever ran `set-buffer -b`, so the name is quoted
/// into the read: a quote in it must neither break the read nor end the
/// argument and run the rest as a command of its own.
#[test]
fn a_paste_buffer_name_is_quoted_into_its_read() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    enter_copy_mode(&mut agg, "%0", "@0");
    let read = agg
        .step(ControlModeEvent::PasteBufferChanged {
            buffer_name: "x' ; run-shell 'touch /tmp/pwned".to_string(),
        })
        .effects
        .into_iter()
        .find_map(|e| match e {
            SideEffect::Send {
                batch: Batch::Own,
                mut commands,
            } => commands.pop(),
            _ => None,
        })
        .expect("a pane in copy mode: the buffer is read");
    assert!(
        read.contains(r"show-buffer -b 'x'\'' ; run-shell '\''touch /tmp/pwned' ;"),
        "{read}"
    );
}

#[test]
fn output_without_osc52_yields_no_clipboard_write() {
    // Sanity check that the new field doesn't fire on plain output.
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");

    let event = ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"hello\r\n".to_vec(),
    };

    let result = agg.process_event(event);
    assert!(result.clipboard_writes.is_empty());
}

/// SEC-22. Nothing evicted from a pane's image store while the pane lived
/// — the server's own store is trimmed only for DEAD panes — so a program
/// printing pictures in a loop grew the process for the life of the pane,
/// on nothing but pane output.
#[test]
fn a_pane_stops_hoarding_pictures_at_the_cap() {
    let mut pane = PaneState::new(pid("%0"), 80, 24);
    for id in 0..(MAX_STORED_IMAGES_PER_PANE as u32 * 2) {
        pane.image_store.insert(
            id,
            crate::control_mode::StoredImage {
                data: vec![0u8; 8],
                mime_type: "image/png".to_string(),
            },
        );
        pane.image_store_order.push_back(id);
    }
    // The eviction runs on output, which is the only way images arrive.
    pane.process_output(b"");
    assert!(
        pane.image_store.len() <= MAX_STORED_IMAGES_PER_PANE,
        "holding {} images, over the {MAX_STORED_IMAGES_PER_PANE} cap",
        pane.image_store.len()
    );
    // The oldest go first, so scrolling back over RECENT output still finds
    // its pictures.
    assert!(pane
        .image_store
        .contains_key(&(MAX_STORED_IMAGES_PER_PANE as u32 * 2 - 1)));
    assert!(!pane.image_store.contains_key(&0));
}

/// SEC-01. OSC 52 arrives in pane OUTPUT, so `cat` of a crafted file is
/// enough to reach it — a background pane (a tailed log, a stray ssh
/// session) could silently replace what the user was about to paste.
#[test]
fn osc52_from_a_pane_the_user_is_not_in_is_dropped() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    seed_pane(&mut agg, "%1", "@0");

    let result = agg.process_event(ControlModeEvent::Output {
        pane_id: pid("%1"),
        content: b"\x1b]52;c;aGVsbG8gd29ybGQ=\x07".to_vec(),
    });

    assert!(
        result.clipboard_writes.is_empty(),
        "a background pane must not reach the system clipboard"
    );
}

/// SEC-01. The payload is whatever the file held, so it is bounded.
#[test]
fn an_osc52_write_over_the_cap_is_dropped() {
    let under = accepted_clipboard_write(
        &pid("%0"),
        Some(&pid("%0")),
        "x".repeat(MAX_CLIPBOARD_BYTES),
    );
    assert_eq!(under.map(|t| t.len()), Some(MAX_CLIPBOARD_BYTES));

    let over = accepted_clipboard_write(
        &pid("%0"),
        Some(&pid("%0")),
        "x".repeat(MAX_CLIPBOARD_BYTES + 1),
    );
    assert_eq!(over, None);
}

#[test]
fn a_clipboard_write_needs_an_active_pane_to_match() {
    assert_eq!(
        accepted_clipboard_write(&pid("%0"), Some(&pid("%0")), "yank".into()),
        Some("yank".to_string())
    );
    assert_eq!(
        accepted_clipboard_write(&pid("%0"), Some(&pid("%1")), "yank".into()),
        None
    );
    // Nothing is active yet (a session still coming up): no pane is the
    // one the user is in, so none may write.
    assert_eq!(
        accepted_clipboard_write(&pid("%0"), None, "yank".into()),
        None
    );
}

/// `%pane-mode-changed` is a nudge to re-list, never a toggle. tmux answers a
/// control client's queued commands before it delivers notifications, so a
/// `list-panes` batched with the `copy-mode` that caused the notification has
/// already reported the pane in copy mode when it arrives; a toggle flipped
/// the pane back out, closing the user's copy mode and the clipboard gate
/// with it. The notification also fires for view- and tree-mode, which the
/// poll's copy-mode column rightly reports as not copy mode.
#[test]
fn a_mode_change_notification_relists_the_pane_instead_of_toggling_copy_mode() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    // The first step tags the seeded window (A3) and emits for that; drain it.
    agg.step(ControlModeEvent::SessionsChanged);

    // On its own it flips nothing and asks for the pane's row again.
    let alone = agg.step(ControlModeEvent::PaneModeChanged { pane_id: pid("%0") });
    assert!(
        !agg.panes["%0"].in_mode,
        "a notification alone is not copy mode"
    );
    assert!(
        alone.effects.iter().any(|e| matches!(
            e,
            SideEffect::Send {
                batch: Batch::PaneRefresh,
                ..
            }
        )),
        "the pane is re-listed ({:?})",
        alone.effects
    );
    assert!(
        !alone
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::Emit(_))),
        "the reply emits, not the notification ({:?})",
        alone.effects
    );

    // list-panes answered first and says copy mode: the notification that
    // follows leaves it so.
    enter_copy_mode(&mut agg, "%0", "@0");
    agg.step(ControlModeEvent::PaneModeChanged { pane_id: pid("%0") });
    assert!(
        agg.panes["%0"].in_mode,
        "the notification after the row flipped the pane out of copy mode"
    );
    assert!(agg.has_pane_in_copy_mode(), "the clipboard gate stays open");
}

/// A pane that moved windows (break-pane) holds its `%output` until the
/// capture of its new place lands. When that capture fails, the hold must
/// be released with it, or the pane goes blind: every line it prints from
/// then on is dropped until some later capture happens to land.
#[test]
fn a_moved_pane_whose_capture_fails_gets_its_output_back() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    for w in ["@0", "@1"] {
        agg.windows.insert(wid(w), WindowState::new(wid(w), 0));
    }
    let layout = "0000,80x24,0,0,0";
    let moved = agg.process_event(ControlModeEvent::LayoutChange {
        window_id: wid("@1"),
        layout: layout.into(),
        visible_layout: layout.into(),
        flags: String::new(),
    });
    assert_eq!(
        moved.panes_needing_refresh,
        vec![pid("%0")],
        "a move captures the pane"
    );
    agg.queue_captures(&[pid("%0")]);

    let held = agg.process_event(ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"STALE\r\n".to_vec(),
    });
    assert!(
        !held.state_changed,
        "output is held while the capture is in flight"
    );

    agg.process_event(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "0"), true));
    agg.process_event(ControlModeEvent::CommandResponse {
        output: "can't find pane: %0\n".to_string(),
        success: false,
    });

    let after = agg.process_event(ControlModeEvent::Output {
        pane_id: pid("%0"),
        content: b"FRESH".to_vec(),
    });
    assert!(
        after.state_changed,
        "output reaches the pane once the capture is over"
    );
    let first_row: String = agg.panes.get_mut("%0").unwrap().get_content()[0]
        .iter()
        .map(|c| c.char.clone())
        .collect();
    assert_eq!(first_row.trim_end(), "FRESH");
}

/// A capture asked for while one is already in flight for the pane (the
/// second resize of a divider drag) is not sent twice — but the reply in
/// flight shows the pane as it was when it was issued, in the old geometry.
/// Once it lands, one more capture follows, so the pane is not left showing
/// the old wrapping until the next layout change.
#[test]
fn a_capture_requested_while_one_is_in_flight_follows_when_it_lands() {
    let mut agg = StateAggregator::new();
    seed_pane(&mut agg, "%0", "@0");
    assert_eq!(agg.queue_captures(&[pid("%0")]), vec![pid("%0")]);
    assert!(
        agg.queue_captures(&[pid("%0")]).is_empty(),
        "no second capture while one is in flight"
    );

    agg.step(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "0"), true));
    let landed = agg.step(response("OLD GEOMETRY\n", true));
    assert!(
        landed.effects.iter().any(|e| captures(e, "%0")),
        "the dropped request is made once the pane is free ({:?})",
        landed.effects
    );
    agg.step(response(&marked(&agg, CAPTURE_END_MARKER, ""), true));

    // The follow-up, in flight since the step queued it, asks for nothing more.
    agg.step(response(&marked(&agg, CAPTURE_BEGIN_MARKER, "0"), true));
    let settled = agg.step(response("NEW GEOMETRY\n", true));
    assert!(
        !settled.effects.iter().any(|e| matches!(
            e,
            SideEffect::Send {
                batch: Batch::PaneRefresh,
                ..
            }
        )),
        "a capture nobody asked twice for ends the chain ({:?})",
        settled.effects
    );
}

/// Whether `effect` is a pane refresh that captures `pane`.
pub(super) fn captures(effect: &SideEffect, pane: &str) -> bool {
    matches!(effect, SideEffect::Send { batch: Batch::PaneRefresh, commands }
        if commands.iter().any(|c| c.contains(&format!("capture-pane -t {pane} "))))
}
