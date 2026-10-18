use super::*;

/// One log of everything that leaves the monitor, in the order it left:
/// the commands the link sends and what the emitter is handed, so an
/// effect that reaches the UI can be placed against one that reaches
/// tmux. `<step>` marks each time the monitor asks for the next event.
type Log = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

/// An emitter that logs every effect it is handed, as a mark.
struct Recording(Log);
impl super::super::log::LogSink for Recording {}
impl StateEmitter for Recording {
    fn emit_state(&self, _update: StateUpdate) {
        self.0.lock().unwrap().push("<emit>".to_string());
    }
    fn emit_error(&self, error: String) {
        panic!("unexpected error: {error}");
    }
    fn store_images(
        &self,
        _pane_id: &PaneId,
        images: Vec<(u32, super::super::images::StoredImage)>,
    ) {
        assert!(
            !images.is_empty(),
            "an empty image store reached the emitter"
        );
        self.0.lock().unwrap().push("<images>".to_string());
    }
    fn write_clipboard(&self, pane_id: Option<&PaneId>, text: String) {
        let from = pane_id.map_or("buffer".to_string(), |p| p.to_string());
        self.0
            .lock()
            .unwrap()
            .push(format!("<clipboard {from} {text}>"));
    }
    fn show_message(&self, text: String) {
        self.0.lock().unwrap().push(format!("<message {text}>"));
    }
}

/// A `%message` goes to the emitter and nowhere else: no command to tmux,
/// no state emission — and an empty one (all control characters) is
/// dropped rather than shown as a blank notice. One this client ran
/// itself arrives inside the command's reply block, and is shown from
/// there.
#[tokio::test]
async fn a_message_reaches_the_emitter_alone() {
    let log: Log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let events = [
        ControlModeEvent::Message {
            text: "build done".to_string(),
        },
        ControlModeEvent::Message {
            text: String::new(),
        },
        // `display-message 'hi #{session_name}'` sent by the client.
        response("TMUXY_RPY_BEGIN 4\n"),
        response("%message hi tmuxy"),
        response("TMUXY_RPY_END 4\n"),
    ];
    let count = events.len();
    let link = Scripted {
        events: events.into_iter().collect(),
        sent: std::sync::Arc::clone(&log),
    };
    let (_tx, rx) = mpsc::channel(1);
    let mut monitor = TmuxMonitor::over(link, MonitorConfig::default(), rx);
    monitor
        .pending_replies
        .insert(4, (ReplyWaiter::ReportFailure, tokio::time::Instant::now()));
    let emitter = Recording(std::sync::Arc::clone(&log));
    let mut rs = RunState::new(&monitor.config, Instant::now());
    for _ in 0..count {
        let event = monitor.connection.recv().await;
        assert!(monitor.on_control_event(&emitter, &mut rs, event).await);
    }
    assert_eq!(
        *log.lock().unwrap(),
        [
            "<step>",
            "<message build done>",
            "<step>",
            "<step>",
            "<step>",
            "<step>",
            "<message hi tmuxy>"
        ]
    );
}

/// A link that logs every command in the order it was sent.
struct Scripted {
    events: std::collections::VecDeque<ControlModeEvent>,
    sent: Log,
}
impl ControlLink for Scripted {
    async fn send_command(&mut self, cmd: &str) -> Result<(), TmuxError> {
        self.sent.lock().unwrap().push(cmd.to_string());
        Ok(())
    }
    async fn send_commands_batch(&mut self, commands: &[String]) -> Result<(), TmuxError> {
        self.sent.lock().unwrap().extend(commands.iter().cloned());
        Ok(())
    }
    async fn recv(&mut self) -> Option<ControlModeEvent> {
        self.sent.lock().unwrap().push("<step>".to_string());
        self.events.pop_front()
    }
    async fn graceful_close(&mut self) {}
}

/// Where a log entry sits in the effect order of A1: window tags, then
/// images and clipboard writes, then the aggregator's own commands, then
/// re-lists, then captures, a flow resume, the state emission last.
fn rank(entry: &str) -> u8 {
    if entry.starts_with("set-option -w") {
        0
    } else if entry == "<images>" || entry.starts_with("<clipboard") {
        1
    } else if entry == tmux_formats::LIST_PANES_CMD
        || entry == tmux_formats::LIST_WINDOWS_CMD
        || entry == tmux_formats::LIST_STASH_PANES_CMD
    {
        3
    } else if entry.contains("capture-pane") {
        4
    } else if entry.starts_with("refresh-client -A") {
        5
    } else if entry == "<emit>" {
        6
    } else {
        2
    }
}

fn response(output: &str) -> ControlModeEvent {
    ControlModeEvent::CommandResponse {
        timestamp: 0,
        command_num: 0,
        output: output.to_string(),
        success: true,
    }
}

/// M1: everything a step hands out — to tmux or to the emitter — leaves
/// in the order the aggregator returned its effects, one entry per effect
/// that reaches a boundary: the window tags of `AdoptUntaggedWindows`
/// before the re-list of `RefreshAfterWindowAdd` before the `EmitState`,
/// the images of `StoreImages` and the text of `WriteClipboard` handed to
/// the emitter, the re-list of `RefreshPanes` before its captures, a
/// `ResumePane` ahead of the emission, a `SendTmuxCommand` sent as given,
/// a `CommandReply` resolving its waiter and putting nothing on the wire
/// — and nothing interleaved. The order itself is A1's property; this is
/// the dispatch of every variant, scripted once, end to end.
#[tokio::test]
async fn a_step_sends_its_effects_commands_in_effect_order() {
    let log: Log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let title = tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME;
    let events = [
        // Two panes the monitor knows, as the initial sync leaves them,
        // the second in copy mode so a paste buffer is worth reading.
        ControlModeEvent::WindowAdd {
            window_id: "@0".parse().unwrap(),
        },
        response(
            "%0,0,0,0,80,12,0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,\n\
             %1,1,0,13,80,11,0,0,0,sleep,,1,0,0,0,@0, ,0,0,0,,,,0,,,,,,",
        ),
        // The session is on @0. The capture this queues for its active
        // pane is the one the list already queued, answered below.
        ControlModeEvent::SessionWindowChanged {
            session_id: "$0".to_string(),
            window_id: "@0".parse().unwrap(),
        },
        response("TMUXY_CAP_BEGIN 0\n"),
        response("$ \n"),
        response("TMUXY_CAP_END\n"),
        // The user is in %0: a clipboard write from %0 is honoured
        // (`accepted_clipboard_write` takes the active pane's only).
        ControlModeEvent::WindowPaneChanged {
            window_id: "@0".parse().unwrap(),
            pane_id: "%0".parse().unwrap(),
        },
        // Adopt, then the window re-list, then the emission.
        ControlModeEvent::WindowAdd {
            window_id: "@1".parse().unwrap(),
        },
        // A reply block: resolved in the monitor, nothing sent.
        response("TMUXY_RPY_BEGIN 4\n"),
        response("ok\n"),
        response("TMUXY_RPY_END 4\n"),
        // An inline image: stored, the output's emission deferred.
        ControlModeEvent::Output {
            pane_id: "%0".parse().unwrap(),
            content: b"\x1b]1337;File=inline=1;width=10;height=5:iVBORw0KGgo=\x07".to_vec(),
        },
        // An OSC 52 write from the pane.
        ControlModeEvent::Output {
            pane_id: "%0".parse().unwrap(),
            content: b"\x1b]52;c;aGVsbG8gd29ybGQ=\x07".to_vec(),
        },
        // A pane refresh: the pane re-list, then the capture.
        ControlModeEvent::SubscriptionChanged {
            name: title.to_string(),
            pane_id: "%0".parse().unwrap(),
        },
        // Flow control: the resume.
        ControlModeEvent::Pause {
            pane_id: "%0".parse().unwrap(),
        },
        // A yank: the aggregator's own command to read the buffer, and
        // the read's three blocks, the middle one a clipboard write.
        ControlModeEvent::PasteBufferChanged {
            buffer_name: "buffer0".to_string(),
        },
        response("TMUXY_BUF_BEGIN\n"),
        response("yanked\n"),
        response("TMUXY_BUF_END\n"),
        ControlModeEvent::WindowClose {
            window_id: "@1".parse().unwrap(),
        },
    ];
    let count = events.len();
    let link = Scripted {
        events: events.into_iter().collect(),
        sent: std::sync::Arc::clone(&log),
    };
    let (_tx, rx) = mpsc::channel(1);
    let mut monitor = TmuxMonitor::over(link, MonitorConfig::default(), rx);
    let (reply_tx, mut reply_rx) = oneshot::channel();
    monitor.pending_replies.insert(
        4,
        (ReplyWaiter::Caller(reply_tx), tokio::time::Instant::now()),
    );
    let emitter = Recording(std::sync::Arc::clone(&log));
    let mut rs = RunState::new(&monitor.config, Instant::now());
    for _ in 0..count {
        let event = monitor.connection.recv().await;
        assert!(monitor.on_control_event(&emitter, &mut rs, event).await);
    }

    let log = log.lock().unwrap().clone();
    let steps: Vec<Vec<&String>> = log
        .split(|c| c == "<step>")
        .map(|step| step.iter().collect())
        .collect();
    for step in &steps {
        let ranks: Vec<u8> = step.iter().map(|c| rank(c)).collect();
        assert!(
            ranks.windows(2).all(|pair| pair[0] <= pair[1]),
            "a step's effects left the effect order: {step:?}"
        );
    }
    // Every rank is in the log, so the check above covers every effect
    // that reaches a boundary.
    for wanted in 0..=6 {
        assert!(
            log.iter().any(|c| rank(c) == wanted),
            "no effect of rank {wanted} reached a boundary: {log:?}"
        );
    }
    // Each multi-effect step, named, so the check above is not vacuous.
    let ranks_of = |step: &[&String]| step.iter().map(|c| rank(c)).collect::<Vec<_>>();
    // Steps are numbered by event: the window focus change is the 3rd,
    // the pane focus change the 7th, the window add the 8th, the reply's three blocks
    // the 9th to 11th, the image the 12th, the OSC 52 the 13th, the title
    // change the 14th, the pause the 15th, the yank the 16th and its read
    // the 17th to 19th, the window close the 20th.
    let window_add = &steps[8];
    let first_list = window_add
        .iter()
        .position(|c| *c == tmux_formats::LIST_PANES_CMD)
        .unwrap_or_else(|| panic!("no re-list after the window add: {window_add:?}"));
    assert!(
        first_list > 0 && rank(window_add[0]) == 0,
        "the tags should go out before the re-list: {window_add:?}"
    );
    assert_eq!(
        window_add.last().map(|c| c.as_str()),
        Some("<emit>"),
        "the window add should emit after its re-list: {window_add:?}"
    );
    for reply_step in &steps[9..12] {
        assert!(reply_step.is_empty(), "a reply block sent {reply_step:?}");
    }
    let reply = reply_rx
        .try_recv()
        .expect("the reply block resolved its waiter");
    assert_eq!((reply.output.as_str(), reply.error), ("ok\n", None));
    assert_eq!(
        steps[12].iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        ["<images>"],
        "an inline image should reach the emitter alone, its emission deferred"
    );
    assert_eq!(
        steps[13].iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        ["<clipboard %0 hello world>"],
        "an OSC 52 write should reach the emitter with the pane that asked"
    );
    let refresh = &steps[14];
    assert_eq!(
        ranks_of(refresh),
        [3, 3, 4],
        "the pane refresh should re-list before it captures: {refresh:?}"
    );
    let pause = &steps[15];
    assert_eq!(
        ranks_of(pause),
        [5, 6],
        "a pause should answer with the resume, then its emission: {pause:?}"
    );
    let yank = &steps[16];
    assert!(
        ranks_of(yank) == [2] && yank[0].contains("show-buffer"),
        "a yank should send the buffer read alone: {yank:?}"
    );
    assert_eq!(
        steps[17..20]
            .iter()
            .map(|s| s.iter().map(|c| c.as_str()).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        [vec![], vec!["<clipboard buffer yanked>"], vec![]],
        "the buffer read should hand its content to the clipboard, once"
    );
    let window_close = &steps[20];
    assert_eq!(
        window_close.last().map(|c| c.as_str()),
        Some("<emit>"),
        "the window close should end on its emission: {window_close:?}"
    );
}
