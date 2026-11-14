//! The process table where there is no `/proc` (macOS): one `ps` for who is
//! whose parent and one `lsof` for the listening sockets, each given two
//! seconds. A process that cannot be read is a pane with no ports.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::output::{parse_lsof, parse_ps};
use super::Processes;

const LIMIT: Duration = Duration::from_secs(2);

pub(super) fn read(_roots: &[u32]) -> Processes {
    let parents = run(Command::new("ps").args(["-A", "-o", "pid=,ppid="]))
        .map(|out| parse_ps(&out))
        .unwrap_or_default();
    let listening = run(Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]))
        .map(|out| parse_lsof(&out))
        .unwrap_or_default();
    Processes { parents, listening }
}

fn run(command: &mut Command) -> Option<String> {
    command
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let mut out = String::new();
    let mut stdout = child.stdout.take()?;
    let deadline = Instant::now() + LIMIT;
    // Read as it comes: a process table can be larger than a pipe holds.
    let reader = std::thread::spawn(move || {
        let _ = stdout.read_to_string(&mut out);
        out
    });
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()
}
