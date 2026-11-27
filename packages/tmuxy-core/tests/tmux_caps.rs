//! What [`TmuxCaps`] says of a version, checked against the tmux this runs
//! on: the nightly matrix runs it on each supported version.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::io::{BufRead as _, Write as _};

use tmuxy_core::tmux_compat::TmuxCaps;

/// A `swap-pane` sent by a control client, and whether tmux follows it with
/// a `%layout-change`. tmux queues the notification, so it can come after
/// later replies: a round trip at a time, it is waited for until it comes.
/// Only a tmux that never sends one (3.2) uses up the two seconds, so a slow
/// machine can make that version pass late, never another one fail.
fn swap_is_announced(server: &common::ScratchServer) -> bool {
    let mut client = tmuxy_core::session::local_tmux_on(&server.socket)
        .args(["-C", "attach", "-t", "caps"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = std::io::BufReader::new(client.stdout.take().unwrap()).lines();
    let input = client.stdin.as_mut().unwrap();
    // A round trip on the client: whether a `%layout-change` came before it.
    let mut round_trip = |input: &mut std::process::ChildStdin, n: usize| {
        let marker = format!("tmuxy-trip-{n}");
        writeln!(input, "display-message -p {marker}").unwrap();
        let mut announced = false;
        for line in lines.by_ref() {
            let line = line.unwrap();
            announced |= line.starts_with("%layout-change ");
            if line == marker {
                return announced;
            }
        }
        panic!("the client closed");
    };
    // Whatever the attach itself announced is read past first.
    round_trip(input, 0);
    writeln!(input, "swap-pane -D").unwrap();
    let started = std::time::Instant::now();
    let mut announced = false;
    let mut n = 1;
    // Only on 3.2, where none comes, does this loop run its two seconds out.
    while !announced && started.elapsed() < std::time::Duration::from_secs(2) {
        announced = round_trip(input, n);
        n += 1;
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = writeln!(input, "detach");
    let _ = client.wait();
    announced
}

/// A program in a pane asks for the cell size (`CSI 16 t`), and whether any
/// answer comes back. The pane writes what it reads to a file; only a tmux
/// that never answers (before 3.4) waits out the five seconds; one that
/// answers is done as soon as its answer is read.
fn cell_size_query_is_answered(server: &common::ScratchServer) -> bool {
    let answer = server.home.join("cell-size-answer");
    let _ = std::fs::remove_file(&answer);
    let program = format!(
        "stty raw -echo; printf '\\033[16t'; dd bs=1 count=3 of={} 2>/dev/null",
        answer.display()
    );
    server.tmux(&["new-window", "-d", "-t", "caps", &program]);
    let started = std::time::Instant::now();
    while started.elapsed() < std::time::Duration::from_secs(5) {
        if std::fs::read(&answer).is_ok_and(|bytes| bytes.len() == 3) {
            return std::fs::read(&answer).unwrap() == b"\x1b[6";
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}

#[test]
fn the_version_tmux_reports_is_read_as_its_own_and_its_swaps_as_caps_say() {
    let server = common::ScratchServer::new("caps");
    server.tmux(&[
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "caps",
        "-x",
        "80",
        "-y",
        "24",
    ]);
    server.tmux(&["split-window", "-t", "caps"]);
    let version = server.tmux(&["display-message", "-p", "#{version}"]);
    let caps = TmuxCaps::from_version(&version);
    let line = server.tmux(&["-V"]);
    match tmuxy_core::tmux_check::parse_version(&line) {
        Some((major, minor)) => {
            assert!(caps.at_least(major, minor), "{version} vs {line}");
            assert!(!caps.at_least(major, minor + 1), "{version} vs {line}");
        }
        // `master` is the newest; a distribution's tag is not known.
        None if version == "master" => assert!(caps.at_least(99, 0)),
        None => assert!(!caps.at_least(3, 2), "{version} vs {line}"),
    }
    assert_eq!(
        swap_is_announced(&server),
        caps.announces_pane_swaps(),
        "tmux {version}"
    );
    assert_eq!(
        cell_size_query_is_answered(&server),
        caps.answers_pixel_size_queries(),
        "tmux {version}"
    );
}
