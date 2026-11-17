//! The pid file a web server writes for its port, and its removal.

use tracing::warn;

pub(super) fn pid_file_path(port: u16) -> std::path::PathBuf {
    tmuxy_core::paths::Layout::current().pid_file(port)
}

/// A server whose pid file could not be written still serves, but
/// `tmuxy server stop|status` will not find it: said once, at start.
pub(super) fn write_pid_file(port: u16) {
    let pid = std::process::id();
    let path = pid_file_path(port);
    let written = match path.parent() {
        Some(dir) => tmuxy_core::private_files::create_dir_all(dir),
        None => Ok(()),
    }
    .and_then(|()| tmuxy_core::private_files::write(&path, pid.to_string()));
    if let Err(e) = written {
        warn!(path = %path.display(), error = %e, "could not write the pid file: `tmuxy server stop` and `status` will not find this server");
    }
}

/// Remove the port's pid file if it still names `pid`.
///
/// The file outlives the process that wrote it by a moment: a server told to
/// stop removes it on its way out, by which time a replacement on the same
/// port may already have written its own. Removing unconditionally deleted
/// the new server's file, and `stop` then reported a running server as gone.
pub(super) fn remove_pid_file(port: u16, pid: u32) {
    remove_pid_file_at(&pid_file_path(port), pid);
}

pub(super) fn remove_pid_file_at(path: &std::path::Path, pid: u32) {
    let names_pid = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        == Some(pid);
    if names_pid {
        std::fs::remove_file(path).ok();
    }
}

pub(super) fn read_pid_file_at(path: &std::path::Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| parse_pid(&s))
}

/// The pid a pid file names, if it names one other process. To kill(2), `0`
/// is the caller's own process group and a negative `pid_t` (what `u32::MAX`
/// becomes) is every process the user owns; `1` is init.
pub(super) fn parse_pid(text: &str) -> Option<u32> {
    text.trim()
        .parse::<i32>()
        .ok()
        .filter(|&pid| pid > 1)
        .and_then(|pid| u32::try_from(pid).ok())
}
