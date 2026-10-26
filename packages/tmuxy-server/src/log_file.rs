//! The desktop app's `tmuxy.log`: appended to, and rotated to `<path>.1` once
//! it passes [`MAX_BYTES`], the way the trace file is, so a long-lived install
//! keeps at most two files' worth of log.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The size past which the log starts over, keeping the old one as `.1`.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    state: Mutex<(File, u64)>,
}

impl RotatingLog {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        Self::open_capped(path, MAX_BYTES)
    }

    fn open_capped(path: &Path, max_bytes: u64) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            tmuxy_core::private_files::create_dir_all(dir)?;
        }
        let file = open_append(path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path: path.to_path_buf(),
            max_bytes,
            state: Mutex::new((file, size)),
        })
    }
}

/// `fmt` hands each event to the writer as one buffer, so a check before each
/// write rotates between lines, never inside one.
impl Write for &RotatingLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (file, size) = &mut *guard;
        if *size > 0 && *size + buf.len() as u64 > self.max_bytes {
            let backup = PathBuf::from(format!("{}.1", self.path.display()));
            // Best-effort: a failed rotation keeps writing to the current file.
            if std::fs::rename(&self.path, &backup).is_ok() {
                if let Ok(fresh) = open_append(&self.path) {
                    *file = fresh;
                    *size = 0;
                }
            }
        }
        let written = file.write(buf)?;
        *size += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .flush()
    }
}

/// The log is only readable by its owner, like the trace, including a file an
/// older build left with a looser mode.
fn open_append(path: &Path) -> io::Result<File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_log_rotates_to_a_single_backup_between_lines() {
        let dir = std::env::temp_dir().join(format!("tmuxy-log-rotate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("tmuxy.log");
        let log = RotatingLog::open_capped(&path, 10).unwrap();

        (&log).write_all(b"first 1\n").unwrap();
        (&log).write_all(b"second\n").unwrap();
        (&log).write_all(b"third\n").unwrap();

        let backup = dir.join("tmuxy.log.1");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "second\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "third\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
