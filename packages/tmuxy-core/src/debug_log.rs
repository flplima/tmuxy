//! Debug logger that writes to /tmp/tmuxy-debug.log
//!
//! Logs shell commands, their outputs, and diagnostic info to help
//! investigate issues on macOS where the app behaves differently
//! when launched from Finder vs. CLI.

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use std::time::SystemTime;

static LOG_MUTEX: Mutex<()> = Mutex::new(());

/// Log to ~/tmuxy-debug.log (not /tmp — macOS App Translocation may block /tmp access)
fn log_path() -> String {
    if let Some(home) = std::env::var_os("HOME") {
        format!("{}/tmuxy-debug.log", home.to_string_lossy())
    } else {
        "/tmp/tmuxy-debug.log".to_string()
    }
}

fn timestamp() -> String {
    let elapsed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = elapsed.as_secs();
    let hours = (secs / 3600) % 24;
    let mins = (secs / 60) % 60;
    let s = secs % 60;
    let ms = elapsed.subsec_millis();
    format!("{:02}:{:02}:{:02}.{:03}", hours, mins, s, ms)
}

/// Write a line to the debug log and stderr.
pub fn log(msg: &str) {
    let line = format!("[tmuxy {}] {}", timestamp(), msg);
    eprintln!("{}", line);
    let _lock = LOG_MUTEX.lock().ok();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "{}", line);
    }
}

/// Log a shell command about to be executed.
pub fn log_cmd(description: &str, program: &str, args: &[&str]) {
    log(&format!(
        "CMD {}: {} {}",
        description,
        program,
        args.join(" ")
    ));
}

/// Log a shell command result.
pub fn log_cmd_result(description: &str, exit_code: Option<i32>, stdout: &str, stderr: &str) {
    let code = exit_code.map_or("?".to_string(), |c| c.to_string());
    log(&format!("RESULT {}: exit={}", description, code));
    if !stdout.trim().is_empty() {
        for line in stdout.trim().lines().take(20) {
            log(&format!("  stdout: {}", line));
        }
    }
    if !stderr.trim().is_empty() {
        for line in stderr.trim().lines().take(20) {
            log(&format!("  stderr: {}", line));
        }
    }
}

/// Log the current environment (useful for comparing CLI vs Finder launch).
pub fn log_env() {
    log("--- Environment ---");
    for key in &[
        "PATH", "HOME", "SHELL", "TERM", "TMPDIR", "USER", "LANG",
        "LC_ALL", "DISPLAY", "TMUXY_SESSION", "TMUX_SOCKET", "TMUX",
    ] {
        let val = std::env::var(key).unwrap_or_else(|_| "(unset)".to_string());
        log(&format!("  {}={}", key, val));
    }
    if let Ok(cwd) = std::env::current_dir() {
        log(&format!("  CWD={}", cwd.display()));
    }
    log(&format!("  PID={}", std::process::id()));
}
