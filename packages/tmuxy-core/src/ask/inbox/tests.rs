//! Only against fake sockets in a private temporary directory: nothing here
//! connects to a real session's inbox.

use std::io::BufRead;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use super::*;

/// A fresh directory of this test's own, owner-only.
fn private_dir() -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tmuxy-inbox-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    dir
}

#[test]
fn a_message_arrives_as_one_line_with_its_text_intact() {
    let dir = private_dir();
    let socket = dir.join("fake.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let text = "it's #[done] \"quoted\" ; $HOME\nsecond line";
    let reader = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut lines = std::io::BufReader::new(stream).lines();
        let first = lines.next().unwrap().unwrap();
        (first, lines.next().is_none())
    });
    let path = checked(socket.to_str().unwrap()).unwrap();
    post(&path, text).unwrap();
    let (first, only) = reader.join().unwrap();
    assert!(only, "more than one line");
    let message: serde_json::Value = serde_json::from_str(&first).unwrap();
    assert_eq!(message["type"], "message");
    assert_eq!(message["text"], text);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn anything_but_a_private_socket_is_refused() {
    let dir = private_dir();
    let socket = dir.join("real.sock");
    let _listener = UnixListener::bind(&socket).unwrap();
    let link = dir.join("link.sock");
    std::os::unix::fs::symlink(&socket, &link).unwrap();
    let file = dir.join("file.sock");
    std::fs::write(&file, "").unwrap();
    let odd = dir.join("real.txt");
    std::os::unix::fs::symlink(&socket, &odd).unwrap();

    for refused in [
        link.to_str().unwrap(),
        file.to_str().unwrap(),
        odd.to_str().unwrap(),
        "real.sock",
        "",
    ] {
        assert!(checked(refused).is_err(), "{refused}");
    }
    assert!(checked(socket.to_str().unwrap()).is_ok());

    // A directory others can write: someone could swap the socket.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(checked(socket.to_str().unwrap()).is_err());
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_text_is_the_words_without_a_final_enter_and_no_key_names() {
    let words = |w: &[&str]| w.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        text_of(&words(&["fix", "the test", "Enter"])).unwrap(),
        "fix the test"
    );
    assert_eq!(text_of(&words(&["go Up now"])).unwrap(), "go Up now");
    assert_eq!(text_of(&words(&[])).unwrap(), "");
    for key in ["C-c", "Up", "Escape", "F5", "Enter"] {
        assert!(text_of(&words(&["stop", key, "now"])).is_err(), "{key}");
    }
}

/// Recorded by a process that still runs (this one): it holds. The same pid
/// with another start time is a process that took it over: it does not.
#[test]
fn a_recorded_inbox_holds_only_while_its_process_runs() {
    let me = std::process::id();
    let when = crate::ask::queue::started(me).unwrap();
    let live = Recorded::parse(&format!("{me}|{when}|/x/a.sock")).unwrap();
    assert!(live.still_running());
    let reused = Recorded::parse(&format!("{me}|not then|/x/a.sock")).unwrap();
    assert!(!reused.still_running());
    for bad in ["", "/x/a.sock", "x|1|/x/a.sock", "12||/x/a.sock", "12|1|"] {
        assert!(Recorded::parse(bad).is_none(), "{bad}");
    }
}
