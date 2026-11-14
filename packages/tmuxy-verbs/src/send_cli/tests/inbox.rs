//! `--inbox`: posted to a fake socket in a private temporary directory, never
//! to a real session's. Every refusal posts nothing and types nothing. This
//! test's own process stands in for the Claude Code session.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;

use super::*;

fn into_inbox() -> SendArgs {
    SendArgs {
        inbox: true,
        keys: vec!["the tests pass now".into(), "Enter".into()],
        ..args(Some("%3"))
    }
}

/// A fake inbox: a socket in a fresh owner-only directory, and what it got.
fn fake_inbox(name: &str) -> (std::path::PathBuf, std::thread::JoinHandle<String>) {
    let dir = std::env::temp_dir().join(format!("tmuxy-send-inbox-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = dir.join("session.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let got = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if let Ok((mut stream, _)) = listener.accept() {
                stream.set_nonblocking(false).unwrap();
                let mut text = String::new();
                stream.read_to_string(&mut text).unwrap();
                return text;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        String::new()
    });
    (socket, got)
}

/// What the hook records: this test's own process, still running, as the
/// session, and `socket` as its inbox.
fn recorded_by_me(socket: &std::path::Path) -> String {
    let me = std::process::id();
    let started = tmuxy_core::ask::queue::started(me).unwrap();
    format!("{me}|{started}|{}", socket.display())
}

#[tokio::test]
async fn the_text_goes_to_the_agents_inbox_and_nothing_is_typed() {
    let (socket, got) = fake_inbox("posted");
    let tmux = Fake {
        inbox: format!("on\t{}\tclaude", recorded_by_me(&socket)),
        ..Fake::default()
    };
    run(&tmux, into_inbox()).await.unwrap();
    let line: serde_json::Value = serde_json::from_str(got.join().unwrap().trim()).unwrap();
    assert_eq!(line["text"], "the tests pass now");
    assert!(tmux.typed().is_empty());
    std::fs::remove_dir_all(socket.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn off_unrecorded_not_claude_ended_at_a_prompt_or_a_key_name_posts_nothing() {
    let (socket, got) = fake_inbox("refused");
    let live = recorded_by_me(&socket);
    // The same path, recorded by a session that has ended: another start.
    let stale = format!("{}|long ago|{}", std::process::id(), socket.display());
    let key_names = SendArgs {
        keys: vec!["stop".into(), "C-c".into()],
        ..into_inbox()
    };
    let cases = [
        (format!("\t{live}\tclaude"), false, "is off", into_inbox()),
        (
            "on\t\tclaude".to_string(),
            false,
            "no agent inbox",
            into_inbox(),
        ),
        (
            format!("on\t{live}\tcodex"),
            false,
            "not Claude Code",
            into_inbox(),
        ),
        (
            format!("on\t{stale}\tclaude"),
            false,
            "has ended",
            into_inbox(),
        ),
        (
            format!("on\t{live}\tclaude"),
            true,
            "waiting at a prompt",
            into_inbox(),
        ),
        (format!("on\t{live}\tclaude"), false, "key name", key_names),
    ];
    for (inbox, at_prompt, said, args) in cases {
        let tmux = Fake {
            inbox,
            needs_input: Mutex::new(at_prompt),
            ..Fake::default()
        };
        let (code, message) = run(&tmux, args).await.unwrap_err();
        assert_eq!(code, EXIT_FAILED, "{message}");
        assert!(message.contains(said), "{message}");
        assert!(tmux.typed().is_empty());
    }
    assert_eq!(got.join().unwrap(), "", "something was posted");
    std::fs::remove_dir_all(socket.parent().unwrap()).unwrap();
}
