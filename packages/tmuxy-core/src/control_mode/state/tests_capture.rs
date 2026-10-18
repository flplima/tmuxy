use super::tests::*;
use super::*;
use crate::ids::test_ids::pid;

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
        timestamp: 0,
        command_num: 0,
        output: output.to_string(),
        success: true,
    };

    // An interleaved unmarked ack (empty output) — must NOT be consumed
    // as a capture for %0.
    let r = agg.process_event(response(""));
    assert!(
        !matches!(r.change_type, ChangeType::PaneOutput { .. }),
        "unmarked empty ack must not be routed as a capture"
    );

    // %1's capture arrives FIRST (marker-bracketed) — attribution must
    // follow the marker, not the queue order.
    agg.process_event(response(&format!("{CAPTURE_BEGIN_MARKER} 1\n")));
    let r = agg.process_event(response("PANE_ONE_CONTENT\n"));
    assert!(
        matches!(r.change_type, ChangeType::PaneOutput { ref pane_id } if pane_id == "%1"),
        "marked capture must be attributed to the pane in the marker"
    );
    agg.process_event(response(&format!("{CAPTURE_END_MARKER}\n")));
    assert_eq!(
        agg.panes.get_mut("%1").unwrap().get_content()[0]
            .iter()
            .map(|c| c.char.clone())
            .collect::<String>()
            .trim_end(),
        "PANE_ONE_CONTENT"
    );

    // %0's capture follows and lands in %0 — no shifted attribution.
    agg.process_event(response(&format!("{CAPTURE_BEGIN_MARKER} 0\n")));
    let r = agg.process_event(response("PANE_ZERO_CONTENT\n"));
    assert!(matches!(r.change_type, ChangeType::PaneOutput { ref pane_id } if pane_id == "%0"));
    agg.process_event(response(&format!("{CAPTURE_END_MARKER}\n")));
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
        timestamp: 0,
        command_num: 0,
        output: output.to_string(),
        success: true,
    };
    // Real tmux 3.7 output shape for 'TMUXY_CAP_BEGIN 69'-style markers,
    // with expansion padding thrown in.
    agg.process_event(response(&format!(
        "{CAPTURE_BEGIN_MARKER}                    69\n"
    )));
    let r = agg.process_event(response("PADDED_OK\n"));
    assert!(matches!(r.change_type, ChangeType::PaneOutput { ref pane_id } if pane_id == "%69"));
    agg.process_event(response(&format!("{CAPTURE_END_MARKER}\n")));
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
        timestamp: 0,
        command_num: 0,
        output: output.to_string(),
        success: true,
    };
    agg.process_event(response(&format!("{CAPTURE_BEGIN_MARKER} 9\n")));
    let r = agg.process_event(response("GHOST\n"));
    assert!(!matches!(r.change_type, ChangeType::PaneOutput { .. }));
    agg.process_event(response(&format!("{CAPTURE_END_MARKER}\n")));
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
        timestamp: 0,
        command_num: 0,
        output: output.to_string(),
        success,
    };
    agg.process_event(block(&format!("{CAPTURE_BEGIN_MARKER} 9\n"), true));
    agg.process_event(block("can't find pane: %9\n", false));
    assert!(agg.pending_captures.is_empty());
    assert!(agg.capture_armed.is_none());

    let r = agg.process_event(block("GHOST\n", true));
    assert!(!matches!(r.change_type, ChangeType::PaneOutput { .. }));
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
        !outside
            .effects
            .iter()
            .any(|e| matches!(e, SideEffect::SendTmuxCommand(_))),
        "no pane in copy mode: the buffer is not read ({:?})",
        outside.effects
    );

    agg.step(ControlModeEvent::PaneModeChanged { pane_id: pid("%0") });
    let inside = agg.step(changed());
    let read = inside
        .effects
        .iter()
        .find_map(|e| match e {
            SideEffect::SendTmuxCommand(cmd) => Some(cmd.as_str()),
            _ => None,
        })
        .expect("a pane in copy mode: the buffer is read over the control channel");
    assert!(read.contains("TMUXY_BUF_BEGIN") && read.contains("show-buffer -b 'buffer0'"));
}

/// A buffer is named by whoever ran `set-buffer -b`, so the name is quoted
/// into the read: a quote in it must neither break the read nor end the
/// argument and run the rest as a command of its own.
#[test]
fn a_paste_buffer_name_is_quoted_into_its_read() {
    let mut agg = StateAggregator::new();
    seed_active_pane(&mut agg, "%0", "@0");
    agg.step(ControlModeEvent::PaneModeChanged { pane_id: pid("%0") });
    let read = agg
        .step(ControlModeEvent::PasteBufferChanged {
            buffer_name: "x' ; run-shell 'touch /tmp/pwned".to_string(),
        })
        .effects
        .into_iter()
        .find_map(|e| match e {
            SideEffect::SendTmuxCommand(cmd) => Some(cmd),
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
