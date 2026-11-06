//! Each plugin's log, `<state_dir>/plugins/<name>.state/log`: a line when an
//! action starts and one when it exits, with its status, and every failure
//! to launch one. `tmuxy plugin log <name>` prints it; a launch that fails
//! from a menu says so on the status line and points here.

use std::io::Write;
use std::path::PathBuf;

use crate::paths::Layout;

/// Past this the log is rotated to `log.1`, replacing the previous one.
const MAX_LOG_BYTES: u64 = 512 * 1024;

pub fn path(dirs: &Layout, name: &str) -> PathBuf {
    dirs.plugin_state(name).join("log")
}

fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    crate::session_snapshot::stamp(secs)
}

/// Append one line. A log that cannot be written costs only the line.
pub fn append(dirs: &Layout, name: &str, line: &str) {
    let file = path(dirs, name);
    if super::private_dir(&dirs.plugin_state(name)).is_err() {
        return;
    }
    if std::fs::metadata(&file).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
        let _ = std::fs::rename(&file, file.with_extension("1"));
    }
    if let Ok(mut f) = crate::private_files::open_append(&file) {
        let one_line: String = line
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        let _ = writeln!(f, "{} {one_line}", timestamp());
    }
}
