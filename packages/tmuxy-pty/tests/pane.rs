//! The helper as tmux runs it: the pane's socket on stdin and stdout, a
//! program under it, keystrokes in and terminal output back.

#![allow(clippy::expect_used)]

use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Pane {
    socket: UnixStream,
    helper: Child,
    seen: Vec<u8>,
}

impl Pane {
    fn run(program: &[&str]) -> Self {
        let (socket, theirs) = UnixStream::pair().expect("socket pair");
        let theirs = OwnedFd::from(theirs);
        let helper = Command::new(env!("CARGO_BIN_EXE_tmuxy-pty"))
            .args(program)
            .stdin(Stdio::from(theirs.try_clone().expect("dup")))
            .stdout(Stdio::from(theirs))
            .spawn()
            .expect("spawn tmuxy-pty");
        socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        Self {
            socket,
            helper,
            seen: Vec::new(),
        }
    }

    fn type_keys(&mut self, keys: &[u8]) {
        self.socket.write_all(keys).expect("type");
    }

    /// Wait until the pane has shown `want`; returns everything shown so far.
    fn shows(&mut self, want: &str) -> String {
        let until = Instant::now() + Duration::from_secs(10);
        let mut buf = [0u8; 4096];
        while Instant::now() < until {
            let text = String::from_utf8_lossy(&self.seen).into_owned();
            if text.contains(want) {
                return text;
            }
            if let Ok(n) = self.socket.read(&mut buf) {
                self.seen.extend_from_slice(&buf[..n]);
            }
        }
        panic!(
            "pane never showed {want:?}; it showed {:?}",
            String::from_utf8_lossy(&self.seen)
        );
    }

    fn exit_code(mut self) -> Option<i32> {
        let until = Instant::now() + Duration::from_secs(10);
        while Instant::now() < until {
            if let Some(status) = self.helper.try_wait().expect("wait") {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.helper.kill();
        panic!("tmuxy-pty did not exit");
    }
}

#[test]
fn typed_line_is_echoed_read_by_the_program_and_its_output_is_crlf() {
    let mut pane = Pane::run(&["/bin/sh", "sh", "-c", "read l; echo got:$l; echo two"]);
    pane.type_keys(b"hx\x7fi\r");
    let shown = pane.shows("two\r\n");
    assert!(shown.contains("hx\x08 \x08i\r\n"), "{shown:?}");
    assert!(shown.contains("got:hi\r\ntwo\r\n"), "{shown:?}");
    assert_eq!(pane.exit_code(), Some(0));
}

#[test]
fn ctrl_c_interrupts_the_program() {
    let mut pane = Pane::run(&["/bin/sh", "sh", "-c", "echo ready; exec sleep 30"]);
    pane.shows("ready");
    let started = Instant::now();
    pane.type_keys(b"\x03");
    pane.shows("^C");
    assert_eq!(pane.exit_code(), Some(128 + 2));
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// Ctrl+D is an EOT byte on the program's input, which stays open: the
/// preload, LD_PRELOAD'ed in the guest only, turns the byte into one end of
/// file for whoever reads it.
#[test]
fn ctrl_d_puts_an_eot_on_the_program_input() {
    let mut pane = Pane::run(&[
        "/bin/sh",
        "sh",
        "-c",
        "head -c 4 | od -An -tx1 | tr -d ' \\n'; echo; echo done",
    ]);
    pane.type_keys(b"ab\r\x04");
    let shown = pane.shows("done");
    assert!(shown.contains("61620a04"), "{shown:?}");
    assert_eq!(pane.exit_code(), Some(0));
}

#[test]
fn closing_the_pane_hangs_up_the_program() {
    let mut pane = Pane::run(&["/bin/sh", "sh", "-c", "echo ready; exec sleep 30"]);
    pane.shows("ready");
    pane.socket
        .shutdown(std::net::Shutdown::Both)
        .expect("close the pane");
    assert_eq!(pane.exit_code(), Some(0));
}

/// Ctrl+L at a prompt clears the screen, has the program start a new line
/// (a shell then prints its prompt again), and shows the line being typed
/// after what the program printed.
#[test]
fn ctrl_l_clears_and_redraws_the_line_being_typed() {
    let mut pane = Pane::run(&[
        "/bin/sh",
        "sh",
        "-c",
        "echo ready; read l; printf 'prompt[%s]> ' \"$l\"; sleep 1",
    ]);
    pane.shows("ready");
    pane.type_keys(b"ab\x0c");
    let shown = pane.shows("prompt[]> ab");
    assert!(shown.contains("\x1b[H\x1b[2J"), "{shown:?}");
}
