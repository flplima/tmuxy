//! PTY-based tmux session capture
//!
//! Captures the visual state of a tmux session by attaching via a pseudo-terminal
//! with exact dimensions matching the session, then reading the rendered output.

use nix::pty::{openpty, OpenptyResult};
use nix::sys::signal::{kill, Signal};
use nix::sys::wait::waitpid;
use nix::unistd::{close, dup2, execvp, fork, read, setsid, ForkResult};
use std::env;
use std::ffi::CString;
use std::fs;
use std::os::fd::AsRawFd;
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn get_session_dimensions(session: &str) -> Result<(u16, u16), String> {
    let output = Command::new("tmux")
        .args([
            "display-message",
            "-t",
            session,
            "-p",
            "#{window_width} #{window_height}",
        ])
        .output()
        .map_err(|e| format!("Failed to run tmux: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "tmux display-message failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let dims = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = dims.trim().split_whitespace().collect();
    if parts.len() != 2 {
        return Err(format!("Unexpected dimensions format: {}", dims));
    }

    let width: u16 = parts[0]
        .parse()
        .map_err(|_| format!("Invalid width: {}", parts[0]))?;
    let height: u16 = parts[1]
        .parse()
        .map_err(|_| format!("Invalid height: {}", parts[1]))?;

    // Add 1 for status bar
    Ok((width, height + 1))
}

fn set_pty_size(fd: i32, cols: u16, rows: u16) -> Result<(), String> {
    let winsize = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let ret = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &winsize) };
    if ret < 0 {
        return Err(format!("ioctl TIOCSWINSZ failed: {}", ret));
    }
    Ok(())
}

fn capture_tmux_session(session: &str, timeout_ms: u64) -> Result<Vec<u8>, String> {
    let (cols, rows) = get_session_dimensions(session)?;

    // Open a PTY pair
    let OpenptyResult { master, slave } =
        openpty(None, None).map_err(|e| format!("openpty failed: {}", e))?;

    let master_fd = master.as_raw_fd();
    let slave_fd = slave.as_raw_fd();

    // Set the PTY size to match tmux session
    set_pty_size(master_fd, cols, rows)?;

    // Fork
    match unsafe { fork() } {
        Ok(ForkResult::Child) => {
            // Child process: attach to tmux
            drop(master); // Close master in child

            // Create new session
            setsid().ok();

            // Set controlling terminal
            unsafe {
                libc::ioctl(slave_fd, libc::TIOCSCTTY, 0);
            }

            // Redirect stdin/stdout/stderr to slave
            dup2(slave_fd, 0).ok();
            dup2(slave_fd, 1).ok();
            dup2(slave_fd, 2).ok();

            if slave_fd > 2 {
                close(slave_fd).ok();
            }

            // Set TERM
            env::set_var("TERM", "xterm-256color");

            // Exec tmux attach in read-only mode
            let tmux = CString::new("tmux").unwrap();
            let args = [
                CString::new("tmux").unwrap(),
                CString::new("attach-session").unwrap(),
                CString::new("-r").unwrap(),
                CString::new("-t").unwrap(),
                CString::new(session).unwrap(),
            ];
            let args_ref: Vec<&std::ffi::CStr> = args.iter().map(|s| s.as_c_str()).collect();

            execvp(&tmux, &args_ref).ok();
            std::process::exit(1);
        }
        Ok(ForkResult::Parent { child }) => {
            // Parent process: read from master
            drop(slave); // Close slave in parent

            // Set master to non-blocking
            unsafe {
                let flags = libc::fcntl(master_fd, libc::F_GETFL);
                libc::fcntl(master_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
            }

            let mut output = Vec::new();
            let mut buf = [0u8; 4096];
            let start = Instant::now();
            let timeout = Duration::from_millis(timeout_ms);

            // Read until timeout or no more data
            loop {
                if start.elapsed() > timeout {
                    break;
                }

                match read(master_fd, &mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        output.extend_from_slice(&buf[..n]);
                    }
                    Err(nix::errno::Errno::EAGAIN) | Err(nix::errno::Errno::EWOULDBLOCK) => {
                        // No data available, wait a bit
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }

            // Kill the child process
            kill(child, Signal::SIGKILL).ok();
            waitpid(child, None).ok();

            Ok(output)
        }
        Err(e) => Err(format!("fork failed: {}", e)),
    }
}

fn render_to_plain_text(data: &[u8], cols: u16, rows: u16) -> String {
    let mut parser = vt100::Parser::new(rows, cols, 0);
    parser.process(data);

    let screen = parser.screen();
    let mut lines = Vec::new();

    for row in 0..rows {
        let mut line = String::new();
        for col in 0..cols {
            let cell = screen.cell(row, col).unwrap();
            line.push(cell.contents().chars().next().unwrap_or(' '));
        }
        // Trim trailing spaces but keep the line
        let trimmed = line.trim_end();
        lines.push(trimmed.to_string());
    }

    // Remove trailing empty lines
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }

    lines.join("\n")
}

const SNAPSHOTS_DIR: &str = "snapshots";
const MAX_SNAPSHOTS: usize = 1000;

fn cleanup_old_snapshots(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "txt"))
        .filter_map(|e| {
            let metadata = e.metadata().ok()?;
            let modified = metadata.modified().ok()?;
            Some((e.path(), modified))
        })
        .collect();

    if files.len() <= MAX_SNAPSHOTS {
        return;
    }

    // Sort by modification time (oldest first)
    files.sort_by_key(|(_, time)| *time);

    // Remove oldest files until we're under the limit
    let to_remove = files.len() - MAX_SNAPSHOTS;
    for (path, _) in files.into_iter().take(to_remove) {
        let _ = fs::remove_file(path);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let session = args.get(1).map(|s| s.as_str()).unwrap_or("tmuxy");
    let timeout_ms: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100);

    // Check if session exists
    let check = Command::new("tmux")
        .args(["has-session", "-t", session])
        .status();

    match check {
        Ok(status) if !status.success() => {
            eprintln!("Error: tmux session '{}' does not exist", session);
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Error: Failed to check tmux session: {}", e);
            std::process::exit(1);
        }
        _ => {}
    }

    // Get dimensions for rendering
    let (cols, rows) = match get_session_dimensions(session) {
        Ok(dims) => dims,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    // Determine snapshots directory (relative to current working directory)
    let snapshots_dir = std::path::Path::new(SNAPSHOTS_DIR);
    if !snapshots_dir.exists() {
        if let Err(e) = fs::create_dir_all(snapshots_dir) {
            eprintln!("Error creating snapshots directory: {}", e);
            std::process::exit(1);
        }
    }

    // Cleanup old snapshots if needed
    cleanup_old_snapshots(snapshots_dir);

    match capture_tmux_session(session, timeout_ms) {
        Ok(output) => {
            // Render through vt100 to get plain text
            let plain_text = render_to_plain_text(&output, cols, rows);

            // Generate timestamp filename
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            let filename = snapshots_dir.join(format!("{}-{}.txt", session, timestamp));

            // Save to file
            if let Err(e) = fs::write(&filename, &plain_text) {
                eprintln!("Error writing file: {}", e);
                std::process::exit(1);
            }

            // Print the filename
            println!("{}", filename.display());
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}
