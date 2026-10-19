use super::*;
use crate::control_mode::{StoredImage, MAX_CLIPBOARD_BYTES};
use crate::ids::test_ids::pid;

#[test]
fn parse_bindings_handles_plain_and_repeat_forms() {
    let output = "\
bind-key    -T prefix % split-window -h
bind-key -r -T prefix h resize-pane -L 5
bind-key    -T root C-Left select-pane -L
bind-key    -T prefix \\% send-keys %";
    let prefix = parse_bindings("prefix", output);
    assert_eq!(prefix.len(), 3);
    assert_eq!(prefix[0].key, "%");
    assert_eq!(prefix[0].description, "Split pane vertically");
    assert!(!prefix[0].repeat);
    // -r bindings keep their repeat flag (the old root copy hardcoded
    // repeat: false — this drift is what the shared parser fixes).
    assert_eq!(prefix[1].key, "h");
    assert!(prefix[1].repeat);
    // Escaped keys are unescaped.
    assert_eq!(prefix[2].key, "%");

    let root = parse_bindings("root", output);
    assert_eq!(root.len(), 1);
    assert_eq!(root[0].key, "C-Left");
    assert_eq!(root[0].description, "Select pane");
}

/// A monitor that answers every query with `answer`, recording what it
/// was asked.
fn answering(
    answer: Result<String, String>,
) -> (
    MonitorCommandSender,
    std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) {
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = asked.clone();
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            if let MonitorCommand::RunCommandWithReply { command, reply } = cmd {
                seen.lock().unwrap().push(command);
                let (output, error) = match &answer {
                    Ok(out) => (out.clone(), None),
                    Err(e) => (String::new(), Some(e.clone())),
                };
                let _ = reply.send(crate::control_mode::CommandReply { output, error });
            }
        }
    });
    (tx, asked)
}

#[tokio::test]
async fn scrollback_is_read_through_the_monitor_in_one_query() {
    let (tx, asked) = answering(Ok("40 120\nhello\nworld\n".to_string()));
    let answer = scrollback_cells(&tx, &PaneId::from_number(3), -10, -1)
        .await
        .unwrap();
    assert_eq!(answer["width"], 40);
    assert_eq!(answer["historySize"], 120);
    assert_eq!(answer["start"], -10);
    assert_eq!(answer["end"], -1);
    assert_eq!(answer["cells"].as_array().unwrap().len(), 2);
    let asked = asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert!(asked[0].contains("-t %3 -S -10 -E -1"), "{}", asked[0]);
}

/// The width is tmux's or nothing: a guessed 80 re-wraps every captured
/// line at the wrong column.
#[tokio::test]
async fn tmux_refusing_is_kind_tmux_and_a_gone_monitor_unavailable() {
    let (tx, _) = answering(Err("unknown command: frob".to_string()));
    let err = query(&tx, "frob").await.unwrap_err();
    assert_eq!(err, CommandError::tmux("unknown command: frob"));

    let (tx, rx) = tokio::sync::mpsc::channel(1);
    drop(rx);
    assert_eq!(
        query(&tx, "list-panes").await.unwrap_err().kind,
        crate::ErrorKind::Unavailable
    );
    assert_eq!(
        run(&tx, "list-panes").await.unwrap_err().kind,
        crate::ErrorKind::Unavailable
    );
}

#[tokio::test]
async fn restoring_a_bad_name_is_an_invalid_argument() {
    let (tx, _) = answering(Ok(String::new()));
    assert_eq!(
        restore_named("a\nkill-server", &tx).await.unwrap_err().kind,
        crate::ErrorKind::Invalid
    );
}

#[tokio::test]
async fn scrollback_without_a_width_fails_rather_than_guessing() {
    let (tx, _) = answering(Ok("\nhello\n".to_string()));
    assert!(scrollback_cells(&tx, &PaneId::from_number(3), -10, -1)
        .await
        .is_err());
}

#[test]
fn key_bindings_parse_the_prefix_and_both_tables() {
    let parsed = KeyBindings::parse(
        "C-a\n\
         bind-key    -T prefix % split-window -h\n\
         bind-key -r -T prefix h resize-pane -L 5\n\
         bind-key    -T root C-Left select-pane -L\n",
    );
    assert_eq!(parsed.prefix_key, "C-a");
    assert_eq!(parsed.prefix_bindings.len(), 2);
    assert!(parsed.prefix_bindings[1].repeat);
    assert_eq!(parsed.root_bindings.len(), 1);
    assert_eq!(parsed.root_bindings[0].key, "C-Left");
    assert!(parsed.tables.is_empty());
}

/// A table a binding enters with `switch-client -T` comes through by name,
/// `-r` or not; copy mode's tables stay out — copy mode is the client's.
#[test]
fn key_bindings_carry_every_other_table_but_copy_modes() {
    let parsed = KeyBindings::parse(
        "C-a\n\
         bind-key    -T copy-mode-vi v send-keys -X begin-selection\n\
         bind-key    -T pane x kill-pane \\; switch-client -T pane\n\
         bind-key -r -T pane H resize-pane -L 5 \\; switch-client -T pane\n\
         bind-key    -T prefix p switch-client -T pane\n\
         bind-key    -T tab c new-window\n",
    );
    assert_eq!(
        parsed.tables.keys().collect::<Vec<_>>(),
        [&"pane".to_string(), &"tab".to_string()]
    );
    let pane = &parsed.tables["pane"];
    assert_eq!(pane.len(), 2);
    assert_eq!(pane[0].command, "kill-pane \\; switch-client -T pane");
    assert!(pane[1].repeat);
    assert_eq!(parsed.prefix_bindings.len(), 1);
}

#[tokio::test]
async fn key_bindings_fall_back_to_the_default_prefix_when_tmux_cannot_answer() {
    let (tx, _) = answering(Err("no server".to_string()));
    let read = KeyBindings::read(&tx).await;
    assert_eq!(read.prefix_key, "C-b");
    assert!(read.prefix_bindings.is_empty());
}

#[test]
fn source_file_is_recognised_in_both_spellings() {
    assert!(is_source_file("source-file ~/.config/tmuxy/tmuxy.conf"));
    assert!(is_source_file("  source ~/.tmux.conf"));
    assert!(!is_source_file("sourcery"));
    assert!(!is_source_file("send-keys source-file"));
}

#[tokio::test]
async fn a_running_session_is_not_restored_over() {
    // `has-session` answers without an error: the session exists.
    let (tx, asked) = answering(Ok(String::new()));
    let refused = restore_named("work", &tx).await.unwrap_err();
    assert!(refused.error.contains("already running"), "{refused}");
    assert_eq!(refused.kind, crate::ErrorKind::Invalid);
    assert_eq!(asked.lock().unwrap()[0], "has-session -t '=work'");
}

#[tokio::test]
async fn an_unusable_session_name_reaches_no_tmux() {
    let (tx, asked) = answering(Ok(String::new()));
    assert!(restore_named("a\nkill-server", &tx).await.is_err());
    assert!(asked.lock().unwrap().is_empty());
}

fn picture(len: usize) -> StoredImage {
    StoredImage {
        data: vec![0u8; len],
        mime_type: "image/jpeg".to_string(),
    }
}

/// A pane that keeps producing frames must not grow without limit.
///
/// The frame case is the one that bites: a program redrawing its picture
/// draws at the same anchor, so the PLACEMENTS stay at one while every frame
/// adds a new image id — and the store is otherwise only swept when the pane
/// goes away. The desktop app kept every frame until it was relaunched.
#[test]
fn a_pane_streaming_frames_stops_growing_but_keeps_the_newest() {
    let mut store = ImageStore::default();
    // A megabyte a frame, far past the cap.
    for id in 0..40u32 {
        store.insert(&pid("%1"), vec![(id, picture(1024 * 1024))]);
    }
    let total: usize = store.images.values().map(|img| img.data.len()).sum();
    assert!(
        total <= MAX_PANE_IMAGE_BYTES,
        "a streaming pane must stay under the cap, held {total}"
    );
    assert!(
        store.get(&pid("%1"), 39).is_some(),
        "the newest frame is the one on screen and must survive"
    );
    assert!(
        store.get(&pid("%1"), 0).is_none(),
        "the oldest frame is the one to drop"
    );
}

#[test]
fn an_ordinary_pane_of_pictures_is_left_alone() {
    let mut store = ImageStore::default();
    store.insert(
        &pid("%1"),
        (0..50u32).map(|id| (id, picture(200 * 1024))).collect(),
    );
    assert_eq!(store.images.len(), 50, "10MB of pictures is under the cap");
}

/// One pane's flood must not evict another pane's pictures.
#[test]
fn the_cap_is_per_pane() {
    let mut store = ImageStore::default();
    store.insert(&pid("%2"), vec![(1, picture(1024))]);
    for id in 0..40u32 {
        store.insert(&pid("%1"), vec![(id, picture(1024 * 1024))]);
    }
    assert!(store.get(&pid("%2"), 1).is_some());
}

/// A pane that has gone takes its pictures with it.
#[test]
fn a_full_state_forgets_the_pictures_of_dead_panes() {
    let mut store = ImageStore::default();
    store.insert(&pid("%1"), vec![(1, picture(10))]);
    store.insert(&pid("%2"), vec![(1, picture(10))]);
    let state: crate::TmuxState = serde_json::from_value(serde_json::json!({
        "session_name": "s",
        "active_window_id": null,
        "active_pane_id": null,
        "panes": [],
        "windows": [],
        "total_width": 80,
        "total_height": 24,
        "status_line": "",
        "focus_request": null,
    }))
    .unwrap();
    store.retain_live_panes(&state);
    assert!(store.get(&pid("%1"), 1).is_none());
    assert!(store.get(&pid("%2"), 1).is_none());
}

/// SEC-01/SEC-13, for both transports: the desktop forwarded a clipboard
/// write of any size.
#[test]
fn a_clipboard_write_over_the_cap_is_refused() {
    assert!(clipboard_write_allowed("yanked"));
    assert!(clipboard_write_allowed(&"x".repeat(MAX_CLIPBOARD_BYTES)));
    assert!(!clipboard_write_allowed(
        &"x".repeat(MAX_CLIPBOARD_BYTES + 1)
    ));
}
