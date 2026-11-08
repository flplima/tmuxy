//! The desktop app's `tmuxy.log`: appended to, and rotated to `<path>.1` once
//! it passes [`MAX_BYTES`], the way the trace file is, so a long-lived install
//! keeps at most two files' worth of log. Opened like every private file
//! (`private_files::open_append`): owner-only, even a file an older build
//! left looser, and never through a symlink planted at its path.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub(super) struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    state: Mutex<(File, u64)>,
}

impl RotatingLog {
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        Self::open_capped(path, MAX_BYTES)
    }

    fn open_capped(path: &Path, max_bytes: u64) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            crate::private_files::create_dir_all(dir)?;
        }
        let file = crate::private_files::open_append(path)?;
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
            if std::fs::rename(&self.path, &backup).is_ok() {
                if let Ok(fresh) = crate::private_files::open_append(&self.path) {
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

#[cfg(test)]
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

    #[cfg(unix)]
    #[test]
    fn the_log_is_never_written_through_a_symlink() {
        let dir = std::env::temp_dir().join(format!("tmuxy-log-symlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("elsewhere");
        std::fs::write(&target, "keep").unwrap();
        let path = dir.join("tmuxy.log");
        std::os::unix::fs::symlink(&target, &path).unwrap();

        assert!(RotatingLog::open(&path).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
