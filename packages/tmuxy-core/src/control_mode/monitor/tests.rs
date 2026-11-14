use super::*;
use crate::constants::tmux_formats::{self, RowBuilder, TmuxList, WindowColumn};
use crate::control_mode::state::{
    Markers, BUFFER_BEGIN_MARKER, BUFFER_END_MARKER, CAPTURE_BEGIN_MARKER, CAPTURE_END_MARKER,
    LIST_BEGIN_MARKER, LIST_END_MARKER, REPLY_BEGIN_MARKER, REPLY_END_MARKER,
};
use crate::PaneId;

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
/// there — as is whatever else a command typed at the prompt printed (a
/// `show-messages`, a `list-keys`): tmux answers a control client in the
/// reply and opens no pager for it, so the reply is the only place it is.
#[tokio::test]
async fn a_message_reaches_the_emitter_alone() {
    let log: Log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (_tx, rx) = mpsc::channel(1);
    let link = Scripted {
        events: Default::default(),
        sent: std::sync::Arc::clone(&log),
    };
    let mut monitor = TmuxMonitor::over(link, MonitorConfig::default(), rx);
    let markers = monitor.core.aggregator().markers().clone();
    // Sent by the client, fire-and-forget: `display-message 'hi
    // #{session_name}'`, and `show-messages` typed at the prompt.
    let [hi, shown] = ["display-message 'hi #{session_name}'", "show-messages"].map(|c| {
        let sent = monitor.core.command(c, None, Instant::now());
        sent.reply_id().expect("wrapped").to_string()
    });
    let events = [
        ControlModeEvent::Message {
            text: "build done".to_string(),
        },
        ControlModeEvent::Message {
            text: String::new(),
        },
        marked(&markers, REPLY_BEGIN_MARKER, &hi),
        response("%message hi tmuxy"),
        marked(&markers, REPLY_END_MARKER, &hi),
        marked(&markers, REPLY_BEGIN_MARKER, &shown),
        response("Mon Nov  2 12:00:00 2026 client-1 message: hi tmuxy\n\n"),
        marked(&markers, REPLY_END_MARKER, &shown),
    ];
    let count = events.len();
    monitor.connection.events.extend(events);
    let emitter = Recording(std::sync::Arc::clone(&log));
    let mut rs = RunState::new(&monitor.config, Instant::now());
    for _ in 0..count {
        assert!(step(&mut monitor, &emitter, &mut rs).await);
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
            "<message hi tmuxy>",
            "<step>",
            "<step>",
            "<step>",
            "<message Mon Nov  2 12:00:00 2026 client-1 message: hi tmuxy>",
        ]
    );
}

/// The next event, run through the core and dispatched, as the loop does.
async fn step<E: StateEmitter>(
    monitor: &mut TmuxMonitor<Scripted>,
    emitter: &E,
    rs: &mut RunState,
) -> bool {
    let event = monitor.connection.recv().await.expect("a scripted event");
    let actions = monitor.core.step(event, Instant::now());
    monitor.dispatch(emitter, rs, actions).await
}

/// A link that logs every command in the order it was sent.
struct Scripted {
    events: std::collections::VecDeque<ControlModeEvent>,
    sent: Log,
}
impl ControlLink for Scripted {
    async fn send_commands<S: AsRef<str> + Sync>(
        &mut self,
        commands: &[S],
    ) -> Result<(), TmuxError> {
        self.sent
            .lock()
            .unwrap()
            .extend(commands.iter().map(|c| c.as_ref().to_string()));
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
    } else if TmuxList::ALL
        .iter()
        .any(|list| entry.contains(&format!(" ; {} ; ", list.command())))
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

/// A marker block of the monitor's own: `name` with its token, then `arg`.
fn marked(markers: &Markers, name: &str, arg: &str) -> ControlModeEvent {
    response(format!("{} {arg}", markers.tag(name)).trim_end())
}

fn response(output: &str) -> ControlModeEvent {
    ControlModeEvent::CommandResponse {
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
    let (_tx, rx) = mpsc::channel(1);
    let link = Scripted {
        events: Default::default(),
        sent: std::sync::Arc::clone(&log),
    };
    let mut monitor = TmuxMonitor::over(link, MonitorConfig::default(), rx);
    let markers = monitor.core.aggregator().markers().clone();
    let title = tmux_formats::PANE_TITLE_SUBSCRIPTION_NAME;
    let (reply_tx, mut reply_rx) = oneshot::channel();
    let asked = monitor
        .core
        .command("display-message -p ok", Some(reply_tx), Instant::now());
    let id = asked
        .reply_id()
        .expect("a caller's command is wrapped")
        .to_string();
    let events = [
        // Two panes the monitor knows, as the initial sync leaves them,
        // the second in copy mode so a paste buffer is worth reading.
        ControlModeEvent::WindowAdd {
            window_id: "@0".parse().unwrap(),
        },
        marked(&markers, LIST_BEGIN_MARKER, TmuxList::Panes.name()),
        response(
            "%0,0,0,0,80,12,0,0,1,sleep,,0,,,,@0, ,0,0,0,,,,0,,,,,,,,\n\
             %1,1,0,13,80,11,0,0,0,sleep,,1,0,0,0,@0, ,0,0,0,,,,0,,,,,,,,",
        ),
        marked(&markers, LIST_END_MARKER, ""),
        marked(&markers, LIST_BEGIN_MARKER, TmuxList::Windows.name()),
        response(&format!(
            "{}\n",
            RowBuilder::<WindowColumn>::new()
                .set(WindowColumn::WindowId, "@0")
                .set(WindowColumn::Index, 0)
                .set(WindowColumn::Active, 1)
                .set(WindowColumn::WindowType, "tab")
                .set(WindowColumn::Zoomed, 0)
                .set(WindowColumn::Name, "shell")
                .build()
        )),
        marked(&markers, LIST_END_MARKER, ""),
        // The session is on @0. The captures this asks for its panes are
        // the ones the list already queued: %0's is captured once more when
        // that lands, %1's (in copy mode, polled) is not. Nothing is emitted
        // until the last of them has landed.
        ControlModeEvent::SessionWindowChanged {
            session_id: "$0".to_string(),
            window_id: "@0".parse().unwrap(),
        },
        marked(&markers, CAPTURE_BEGIN_MARKER, "0"),
        response("$ \n"),
        marked(&markers, CAPTURE_END_MARKER, ""),
        marked(&markers, CAPTURE_BEGIN_MARKER, "1"),
        response("$ \n"),
        marked(&markers, CAPTURE_END_MARKER, ""),
        marked(&markers, CAPTURE_BEGIN_MARKER, "0"),
        response("$ \n"),
        marked(&markers, CAPTURE_END_MARKER, ""),
        // The user is in %0: a clipboard write from %0 is honoured
        // (`accepted_clipboard_write` takes the active pane's only).
        ControlModeEvent::WindowPaneChanged {
            window_id: "@0".parse().unwrap(),
            pane_id: "%0".parse().unwrap(),
        },
        // Adopt, then the window re-list; nothing is emitted, as a window
        // only announced is not shown (A16) until the list names it.
        ControlModeEvent::WindowAdd {
            window_id: "@1".parse().unwrap(),
        },
        marked(&markers, LIST_BEGIN_MARKER, TmuxList::Windows.name()),
        response(&format!(
            "{}\n{}\n",
            RowBuilder::<WindowColumn>::new()
                .set(WindowColumn::WindowId, "@0")
                .set(WindowColumn::Index, 0)
                .set(WindowColumn::Active, 1)
                .set(WindowColumn::WindowType, "tab")
                .set(WindowColumn::Zoomed, 0)
                .set(WindowColumn::Name, "shell")
                .build(),
            RowBuilder::<WindowColumn>::new()
                .set(WindowColumn::WindowId, "@1")
                .set(WindowColumn::Index, 1)
                .set(WindowColumn::Active, 0)
                .set(WindowColumn::WindowType, "tab")
                .set(WindowColumn::Zoomed, 0)
                .set(WindowColumn::Name, "two")
                .build()
        )),
        marked(&markers, LIST_END_MARKER, ""),
        // A reply block: resolved in the monitor, nothing sent.
        marked(&markers, REPLY_BEGIN_MARKER, &id),
        response("ok\n"),
        marked(&markers, REPLY_END_MARKER, &id),
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
        marked(&markers, BUFFER_BEGIN_MARKER, ""),
        response("yanked\n"),
        marked(&markers, BUFFER_END_MARKER, ""),
        ControlModeEvent::WindowClose {
            window_id: "@1".parse().unwrap(),
        },
    ];
    let count = events.len();
    monitor.connection.events.extend(events);
    let emitter = Recording(std::sync::Arc::clone(&log));
    let mut rs = RunState::new(&monitor.config, Instant::now());
    for _ in 0..count {
        assert!(step(&mut monitor, &emitter, &mut rs).await);
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
    // Steps are numbered by event: the window focus change is the 8th,
    // the pane focus change the 18th, the window add the 19th and its
    // list-windows the 20th to 22nd, the reply's three blocks the 23rd to
    // 25th, the image the 26th, the OSC 52 the 27th, the title change the
    // 28th, the pause the 29th, the yank the 30th and its read the 31st to
    // 33rd, the window close the 34th.
    let window_add = &steps[19];
    let first_list = window_add
        .iter()
        .position(|c| rank(c) == 3)
        .unwrap_or_else(|| panic!("no re-list after the window add: {window_add:?}"));
    assert!(
        first_list > 0 && rank(window_add[0]) == 0,
        "the tags should go out before the re-list: {window_add:?}"
    );
    assert!(
        !window_add.iter().any(|c| c.as_str() == "<emit>"),
        "a window only announced should not be shown: {window_add:?}"
    );
    assert_eq!(
        steps[21].last().map(|c| c.as_str()),
        Some("<emit>"),
        "the list that names the window should show it: {:?}",
        steps[21]
    );
    for reply_step in &steps[23..26] {
        assert!(reply_step.is_empty(), "a reply block sent {reply_step:?}");
    }
    let reply = reply_rx
        .try_recv()
        .expect("the reply block resolved its waiter");
    assert_eq!((reply.output.as_str(), reply.error), ("ok\n", None));
    assert_eq!(
        steps[26].iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        ["<images>"],
        "an inline image should reach the emitter alone, its emission deferred"
    );
    assert_eq!(
        steps[27].iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        ["<clipboard %0 hello world>"],
        "an OSC 52 write should reach the emitter with the pane that asked"
    );
    let refresh = &steps[28];
    assert_eq!(
        ranks_of(refresh),
        [3, 3, 4],
        "the pane refresh should re-list before it captures: {refresh:?}"
    );
    let pause = &steps[29];
    assert_eq!(
        ranks_of(pause),
        [5],
        "a pause should answer with the resume alone: {pause:?}"
    );
    let yank = &steps[30];
    assert!(
        ranks_of(yank) == [2] && yank[0].contains("show-buffer"),
        "a yank should send the buffer read alone: {yank:?}"
    );
    assert_eq!(
        steps[31..34]
            .iter()
            .map(|s| s.iter().map(|c| c.as_str()).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        [vec![], vec!["<clipboard buffer yanked>"], vec![]],
        "the buffer read should hand its content to the clipboard, once"
    );
    let window_close = &steps[34];
    assert_eq!(
        window_close.last().map(|c| c.as_str()),
        Some("<emit>"),
        "the window close should end on its emission: {window_close:?}"
    );
}

/// M4: a window is told to stop sizing itself before the monitor sizes it.
/// tmux will not keep a `resizew` on a window still set to size itself to
/// the latest client — it applies ours and then puts its own back — and the
/// options are per WINDOW, so they are set on each window as it is first
/// seen, in the step's own effects, ahead of the client-size pass.
///
/// M13: it is sized once `list-windows` has said what it is, not on the
/// `%window-add` that announced it: sized as a tab for that beat, a new
/// float was the viewport's size just as its program started.
#[tokio::test]
async fn a_window_is_told_to_stop_sizing_itself_before_it_is_sized() {
    let log: Log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (_tx, rx) = mpsc::channel(1);
    let link = Scripted {
        events: Default::default(),
        sent: std::sync::Arc::clone(&log),
    };
    let mut monitor = TmuxMonitor::over(link, MonitorConfig::default(), rx);
    let markers = monitor.core.aggregator().markers().clone();
    let listed = |kind: &str| {
        response(
            &RowBuilder::<WindowColumn>::new()
                .set(WindowColumn::WindowId, "@3")
                .set(WindowColumn::Index, 1)
                .set(WindowColumn::Active, 0)
                .set(WindowColumn::WindowType, kind)
                .set(WindowColumn::Zoomed, 0)
                .set(WindowColumn::Name, "shell")
                .build(),
        )
    };
    monitor.connection.events.extend([
        ControlModeEvent::WindowAdd {
            window_id: "@3".parse().unwrap(),
        },
        marked(&markers, LIST_BEGIN_MARKER, TmuxList::Windows.name()),
        listed("tab"),
        marked(&markers, LIST_END_MARKER, ""),
    ]);
    monitor.core.set_client_size(41, 29);
    let emitter = Recording(std::sync::Arc::clone(&log));
    let mut rs = RunState::new(&monitor.config, Instant::now());

    // The add alone: told to stop sizing itself, and not sized yet.
    assert!(step(&mut monitor, &emitter, &mut rs).await);
    let sent = || log.lock().unwrap().clone();
    let at = |log: &[String], wanted: &str| log.iter().position(|c| c == wanted);
    let on_add = sent();
    assert!(at(&on_add, "set-option -w -t @3 window-size manual").is_some());
    assert!(
        !on_add.iter().any(|c| c.starts_with("resizew -t @3")),
        "a window nothing has described yet was sized: {on_add:?}"
    );
    assert!(
        !on_add.iter().any(|c| c.contains("pane-border-status")),
        "a window nothing has described yet was given a border row: {on_add:?}"
    );

    // Listed as a tab: now it is sized, after the options that let tmux keep the size.
    for _ in 0..3 {
        assert!(step(&mut monitor, &emitter, &mut rs).await);
    }
    let log = sent();
    let resize = at(&log, "resizew -t @3 -x 41 -y 29")
        .unwrap_or_else(|| panic!("the listed window was not sized: {log:?}"));
    assert!(at(&log, "set-option -w -t @3 window-size manual").unwrap() < resize);
    assert!(at(&log, "set-option -w -t @3 aggressive-resize off").unwrap() < resize);
    assert!(at(&log, "set-option -w -t @3 pane-border-status top").is_some());
}
