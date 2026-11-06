use super::*;
use crate::client_size::{SizePolicy, MIN_CLIENT_COLS, MIN_CLIENT_ROWS};
use crate::control_mode::{StateEmitter, MAX_CLIPBOARD_BYTES};

#[derive(Default)]
struct Recorded(Mutex<Vec<HostEvent>>);

impl Sink for Recorded {
    fn emit(&self, event: HostEvent) {
        self.0.lock().unwrap().push(event);
    }
}

fn runtime() -> (Arc<SessionRuntime>, Arc<Recorded>) {
    let sink = Arc::new(Recorded::default());
    let runtime = SessionRuntime::new(
        RuntimeConfig {
            session: "s".to_string(),
            preview: Arc::default(),
            preview_scope: "s".to_string(),
            restore: false,
        },
        sink.clone(),
    );
    (runtime, sink)
}

fn resizing_monitor() -> (MonitorCommandSender, Arc<Mutex<Vec<(u32, u32)>>>) {
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let resizes = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&resizes);
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            if let MonitorCommand::ResizeWindow { cols, rows } = cmd {
                seen.lock().unwrap().push((cols, rows));
            }
        }
    });
    (tx, resizes)
}

/// The resizes the fake monitor has seen once there are `n` of them: it reads
/// the channel in its own task, so `send` returning does not mean it has.
async fn resizes_seen(resizes: &Mutex<Vec<(u32, u32)>>, n: usize) -> Vec<(u32, u32)> {
    for _ in 0..200 {
        if resizes.lock().unwrap().len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    resizes.lock().unwrap().clone()
}

#[tokio::test]
async fn a_client_sizes_the_session_and_a_zero_is_no_report() {
    let (runtime, _) = runtime();
    let (tx, resizes) = resizing_monitor();
    runtime.connected(tx).await;
    runtime.set_client_size(1, 0, 12).await;
    runtime.set_client_size(1, 40, 12).await;
    assert_eq!(resizes_seen(&resizes, 1).await, vec![(40, 12)]);
    assert_eq!(runtime.sent_size(), Some((40, 12)));
}

/// A viewport below the floor is taken as the floor: a real client whose
/// grid measured as a sliver mid-load, or a forged 1x1, would otherwise size
/// the session down to nothing for every client under `smallest`.
#[tokio::test]
async fn a_viewport_below_the_floor_is_raised_to_it() {
    let (runtime, _) = runtime();
    let (tx, resizes) = resizing_monitor();
    runtime.connected(tx).await;
    runtime.set_client_size(1, 1, 1).await;
    assert_eq!(
        resizes_seen(&resizes, 1).await,
        vec![(MIN_CLIENT_COLS, MIN_CLIENT_ROWS)]
    );
}

/// The size last sent records a size that REACHED tmux. It was once written
/// before anything was sent, so a monitor that had not registered its command
/// channel yet dropped the resize while the size was remembered as applied;
/// every later attempt short-circuited on "same size as last time", and the
/// window stayed at the control-mode PTY's 200x50 while a phone-width client
/// drew 41 columns.
#[tokio::test]
async fn a_size_that_reached_no_monitor_is_asked_for_again() {
    let (runtime, _) = runtime();
    runtime.set_client_size(1, 41, 29).await;
    assert_eq!(
        runtime.sent_size(),
        None,
        "a size nothing received must not be recorded as applied"
    );

    let (tx, resizes) = resizing_monitor();
    runtime.connected(tx).await;
    assert_eq!(resizes_seen(&resizes, 1).await, vec![(41, 29)]);
    assert_eq!(runtime.sent_size(), Some((41, 29)));

    runtime.set_client_size(1, 41, 29).await;
    assert_eq!(resizes_seen(&resizes, 2).await.len(), 1);
}

/// A monitor whose control link dropped while the session survived (its CC
/// client killed, a `detach-client`) attaches again, and the attach resizes
/// the session to the control-mode PTY's 200x50. The size sent before still
/// said the clients' size had reached tmux, so nothing sent it again, and
/// the session stayed at 200x50 under a client drawing 41 columns.
#[tokio::test]
async fn a_reconnected_monitor_is_told_the_clients_size_again() {
    let (runtime, _) = runtime();
    let (tx, resizes) = resizing_monitor();
    runtime.connected(tx.clone()).await;
    runtime.set_client_size(1, 41, 29).await;
    assert_eq!(resizes_seen(&resizes, 1).await, vec![(41, 29)]);

    runtime.disconnected();
    runtime.connected(tx).await;
    assert_eq!(resizes_seen(&resizes, 2).await, vec![(41, 29), (41, 29)]);
    assert_eq!(runtime.sent_size(), Some((41, 29)));
}

#[tokio::test]
async fn a_client_that_leaves_stops_holding_the_session_small() {
    let (runtime, _) = runtime();
    let (tx, resizes) = resizing_monitor();
    runtime.connected(tx).await;
    runtime.set_client_size(1, 200, 50).await;
    runtime.set_client_size(2, 80, 24).await;
    assert_eq!(resizes_seen(&resizes, 2).await, vec![(200, 50), (80, 24)]);

    runtime.client_left(2).await;
    assert_eq!(resizes_seen(&resizes, 3).await[2], (200, 50));
}

#[tokio::test]
async fn the_session_is_sized_by_its_size_policy() {
    let (runtime, _) = runtime();
    let (tx, resizes) = resizing_monitor();
    runtime.connected(tx).await;
    runtime.set_client_size(1, 200, 50).await;
    runtime.set_client_size(2, 80, 60).await;
    assert_eq!(resizes_seen(&resizes, 2).await, vec![(200, 50), (80, 50)]);

    runtime.set_size_policy(SizePolicy::Largest).await;
    assert_eq!(resizes_seen(&resizes, 3).await[2], (200, 60));

    runtime
        .set_size_policy(SizePolicy::Fixed {
            cols: 100,
            rows: 30,
        })
        .await;
    assert_eq!(resizes_seen(&resizes, 4).await[3], (100, 30));

    runtime.set_client_size(2, 40, 20).await;
    runtime.client_left(1).await;
    assert_eq!(resizes_seen(&resizes, 5).await.len(), 4);
    assert_eq!(runtime.sent_size(), Some((100, 30)));
}

#[tokio::test]
async fn a_latest_session_follows_the_client_used_last() {
    let (runtime, _) = runtime();
    let (tx, resizes) = resizing_monitor();
    runtime.connected(tx).await;
    runtime.set_client_size(1, 200, 50).await;
    runtime.set_client_size(2, 80, 60).await;
    runtime.set_size_policy(SizePolicy::Latest).await;
    assert_eq!(resizes_seen(&resizes, 3).await[2], (80, 60));

    runtime.note_activity(1).await;
    assert_eq!(resizes_seen(&resizes, 4).await[3], (200, 50));

    // Using the same client again is no resize, and neither is the other
    // client reporting the size it already had: its grid is not its own size,
    // so it reports it after every update, and taking that for a use made the
    // two clients take the session from each other on every frame.
    runtime.note_activity(1).await;
    runtime.set_client_size(2, 80, 60).await;
    assert_eq!(resizes_seen(&resizes, 5).await.len(), 4);

    runtime.set_client_size(2, 90, 40).await;
    assert_eq!(resizes_seen(&resizes, 5).await[4], (90, 40));
}

#[tokio::test]
async fn a_command_waits_only_for_a_monitor_that_is_coming() {
    let (runtime, _) = runtime();
    let waiting = {
        let runtime = Arc::clone(&runtime);
        tokio::spawn(async move { runtime.channel().await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    let (tx, _) = resizing_monitor();
    runtime.connected(tx).await;
    assert!(waiting.await.unwrap().is_ok());

    runtime.set_down();
    let refused = tokio::time::timeout(Duration::from_millis(200), runtime.channel()).await;
    assert_eq!(
        refused
            .expect("a stopped monitor is not waited for")
            .unwrap_err()
            .kind,
        crate::ErrorKind::Unavailable
    );
}

#[tokio::test]
async fn a_clipboard_write_is_sent_and_one_over_the_cap_is_not() {
    let (runtime, sink) = runtime();
    runtime.write_clipboard(Some(&"%0".parse().unwrap()), "yanked".into());
    // A pane's output is untrusted and can make a clipboard write of any
    // size. The paste-buffer mirror arrives with no pane, so the aggregator's
    // active-pane gate never sees it: the size cap is the one bound it has.
    runtime.write_clipboard(None, "x".repeat(MAX_CLIPBOARD_BYTES + 1));
    let events = sink.0.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert!(
        matches!(&events[0], HostEvent::Clipboard { pane_id, text } if pane_id == "%0" && text == "yanked")
    );
}

#[test]
fn a_greeting_carries_the_bindings_once_they_are_known() {
    let (runtime, _) = runtime();
    let names = |events: Vec<HostEvent>| events.iter().map(HostEvent::name).collect::<Vec<_>>();
    assert_eq!(names(runtime.greeting(7)), ["connection-info"]);
    *runtime.bindings.lock().unwrap() = Some(KeyBindings {
        prefix_key: "C-a".to_string(),
        prefix_bindings: Vec::new(),
        root_bindings: Vec::new(),
        tables: Default::default(),
    });
    assert_eq!(
        names(runtime.greeting(7)),
        ["connection-info", "keybindings"]
    );
}
