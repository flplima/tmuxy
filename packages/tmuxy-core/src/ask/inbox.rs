//! The agent inbox bridge, a spike (docs/AGENT-INBOX.md): a message for an
//! agent posted to the inbox socket its session binds, instead of keys typed
//! into its pane. Off unless `@tmuxy-send-inbox` is `on`.
//!
//! The SessionStart hook records, in the pane's `@tmuxy-agent-inbox`, the
//! Claude Code process it runs under (its pid and when it started) and the
//! socket's path, never the session's token: `pid|started|path`. A post goes
//! only while that very process still runs, so the path of a session that
//! ended without its SessionEnd hook is never posted to. The path must be an
//! absolute `.sock` socket, not a symlink, owned by this user, in a directory
//! owned by this user that no one else can write. The line a message is
//! posted as is not documented: [`line`] is the spike's assumption, tested
//! only against a fake socket.

use std::io::Write;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// What the SessionStart hook recorded on a pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub pid: u32,
    pub started: String,
    pub path: String,
}

impl Recorded {
    /// `pid|started|path`, as the hook writes it.
    pub fn parse(value: &str) -> Option<Self> {
        let mut parts = value.trim_end_matches('\n').splitn(3, '|');
        let pid = parts.next()?.parse().ok()?;
        let started = parts.next()?.to_string();
        let path = parts.next()?.to_string();
        (!started.is_empty() && !path.is_empty()).then_some(Self { pid, started, path })
    }

    /// The process that recorded it still runs: same pid, same start.
    pub fn still_running(&self) -> bool {
        super::queue::started(self.pid).as_deref() == Some(self.started.as_str())
    }
}

/// `path` as an inbox this user may post to, or why not.
pub fn checked(path: &str) -> Result<PathBuf, String> {
    let socket = Path::new(path);
    if !socket.is_absolute() || socket.extension().is_none_or(|ext| ext != "sock") {
        return Err(format!("not an inbox socket path: {path}"));
    }
    // SAFETY: getuid has no preconditions and cannot fail.
    let me = unsafe { libc::getuid() };
    let meta = std::fs::symlink_metadata(socket).map_err(|e| format!("{path}: {e}"))?;
    if !meta.file_type().is_socket() || meta.uid() != me {
        return Err(format!("{path} is not a socket of this user's"));
    }
    let dir = socket
        .parent()
        .ok_or_else(|| format!("{path} has no directory"))?;
    let dir_meta = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !dir_meta.is_dir() || dir_meta.uid() != me || dir_meta.mode() & 0o022 != 0 {
        return Err(format!(
            "{} is not a directory of this user's alone",
            dir.display()
        ));
    }
    Ok(socket.to_path_buf())
}

/// The line `text` is posted as. Not documented by Claude Code: this is the
/// spike's assumption (docs/AGENT-INBOX.md, open questions).
pub fn line(text: &str) -> String {
    serde_json::json!({ "type": "message", "text": text }).to_string()
}

/// Post `text` to the inbox at `socket`, as one line, and close.
pub fn post(socket: &Path, text: &str) -> std::io::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(format!("{}\n", line(text)).as_bytes())?;
    stream.shutdown(std::net::Shutdown::Write)
}

/// What `--inbox` posts for `keys`: the words joined with spaces, a final
/// `Enter` dropped, since a message is submitted whole. A key name anywhere
/// else (`C-c`, `Up`, `Escape`) has no meaning in a message: refused.
pub fn text_of(keys: &[String]) -> Result<String, String> {
    let words = match keys.split_last() {
        Some((last, rest)) if last == "Enter" => rest,
        _ => keys,
    };
    if let Some(key) = words.iter().find(|word| key_name(word)) {
        return Err(format!("{key} is a key name, and --inbox posts text"));
    }
    Ok(words.join(" "))
}

fn key_name(word: &str) -> bool {
    const NAMES: [&str; 18] = [
        "Enter", "Escape", "Tab", "BTab", "BSpace", "Space", "Up", "Down", "Left", "Right", "Home",
        "End", "PageUp", "PageDown", "PPage", "NPage", "DC", "IC",
    ];
    let modified = ["C-", "M-", "S-"].iter().any(|m| {
        word.strip_prefix(m)
            .is_some_and(|rest| !rest.is_empty() && !rest.contains(' '))
    });
    let function = word
        .strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n));
    NAMES.contains(&word) || modified || function
}

#[cfg(test)]
mod tests;
