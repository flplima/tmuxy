//! Where tmuxy keeps what is not the user's config: per-machine state (the
//! trace, the desktop app's log, session snapshots, menu choices, pid files)
//! in [`state_dir`], and the files the app mirrors from its bundle (the
//! shipped tmux config, the built-in themes, the CLI scripts) in
//! [`data_dir`]. The user's own files live in `session::config_dir`, which
//! the app writes only on the very first run.
//!
//! One resolution for every host and every verb, so a `tmuxy trace --mark`
//! stamps the file the server is writing and a test's `TMUXY_STATE_DIR` /
//! `TMUXY_DATA_DIR` moves all of it at once.

use std::ffi::OsString;
use std::path::PathBuf;

/// The state directory: `TMUXY_STATE_DIR`, else the XDG state dir (macOS has
/// none, so `~/Library/Application Support`), under `tmuxy`. Resolving it
/// creates nothing.
pub fn state_dir() -> PathBuf {
    state_dir_from(std::env::var_os("TMUXY_STATE_DIR"))
}

/// The data directory: `TMUXY_DATA_DIR`, else `$XDG_DATA_HOME/tmuxy`, else
/// `~/.local/share/tmuxy` — on every OS, macOS included, as
/// `session::config_dir` does: tmux's `source-file` and `run-shell` name these
/// files by path, so the path is the same on every machine (an AppImage's
/// mount point is not), and an agent or a `grep` finds them where the XDG
/// layout says. Resolving it creates nothing.
pub fn data_dir() -> PathBuf {
    data_dir_from(
        std::env::var_os("TMUXY_DATA_DIR"),
        std::env::var_os("XDG_DATA_HOME"),
        dirs::home_dir(),
    )
}

/// Resolve an absolute home directory even when `$HOME` is unset:
/// `dirs::home_dir()`, else `getpwuid_r(getuid())` on Unix, else a verified
/// private `0700` `/tmp/tmuxy-<uid>` directory owned by the current UID.
pub fn resolved_home_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir().filter(|p| p.is_absolute()) {
        return home;
    }
    #[cfg(unix)]
    {
        if let Some(pw_home) = unix_passwd_home() {
            return pw_home;
        }
        if let Ok(fallback) = unix_uid_temp_home() {
            return fallback;
        }
    }
    std::env::temp_dir().join("tmuxy-home")
}

#[cfg(unix)]
fn unix_passwd_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;

    // SAFETY: getuid() has no preconditions.
    let uid = unsafe { libc::getuid() };
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let mut buf = vec![0u8; 4096];
    // SAFETY: `pwd`, `buf`, and `result` are valid writable pointers owned here.
    let rc = unsafe {
        libc::getpwuid_r(
            uid,
            &mut pwd,
            buf.as_mut_ptr().cast(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    // SAFETY: `pwd.pw_dir` points into `buf` and is NUL-terminated on success.
    let bytes = unsafe { CStr::from_ptr(pwd.pw_dir) }.to_bytes();
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(bytes));
    path.is_absolute().then_some(path)
}

#[cfg(unix)]
fn unix_uid_temp_home() -> std::io::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    // SAFETY: getuid() has no preconditions.
    let uid = unsafe { libc::getuid() };
    let dir = std::env::temp_dir().join(format!("tmuxy-{uid}"));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(&dir)?;
    let meta = std::fs::symlink_metadata(&dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != uid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("unsafe fallback home directory: {}", dir.display()),
        ));
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}

/// The file the action trace is written to (docs/TRACING.md), unless
/// `--trace <path>` names another.
pub fn trace_file() -> PathBuf {
    state_dir().join("trace.ndjson")
}

/// The desktop app's log file: the `tracing` lines it would print to stderr,
/// kept on disk because an app launched from Finder has no stderr anyone
/// sees. What a bug report attaches (Help ▸ Reveal Log File) and what the
/// smoke tests read for a healthy connection lifecycle.
pub fn log_file() -> PathBuf {
    state_dir().join("tmuxy.log")
}

/// [`state_dir`] as a function of the override, so the rule is testable
/// without touching the process environment.
fn state_dir_from(override_dir: Option<OsString>) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| resolved_home_dir().join(".local").join("state"))
        .join("tmuxy")
}

/// [`data_dir`] as a function of its inputs. A relative `XDG_DATA_HOME` is
/// ignored, as the XDG spec says it must be.
fn data_dir_from(
    override_dir: Option<OsString>,
    xdg_data_home: Option<OsString>,
    home: Option<PathBuf>,
) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    if let Some(xdg) = xdg_data_home.map(PathBuf::from).filter(|p| p.is_absolute()) {
        return xdg.join("tmuxy");
    }
    home.filter(|p| p.is_absolute())
        .unwrap_or_else(resolved_home_dir)
        .join(".local")
        .join("share")
        .join("tmuxy")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dev server, the E2E harness and the snapshot tests all point
    /// `TMUXY_STATE_DIR` somewhere of their own, and SECURITY.md promises the
    /// trace lives there too. The trace's own resolution ignored the variable,
    /// so `tmuxy trace --mark` under it stamped the machine-wide file.
    #[test]
    fn the_override_moves_the_whole_state_dir() {
        let dir = state_dir_from(Some(OsString::from("/tmp/tmuxy-test-state")));
        assert_eq!(dir, PathBuf::from("/tmp/tmuxy-test-state"));
        assert_eq!(
            dir.join("trace.ndjson"),
            PathBuf::from("/tmp/tmuxy-test-state/trace.ndjson")
        );
    }

    #[test]
    fn an_empty_override_means_the_platform_default() {
        for unset in [None, Some(OsString::new())] {
            let dir = state_dir_from(unset);
            assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("tmuxy"));
        }
    }

    #[test]
    fn the_data_dir_is_the_override_then_xdg_then_local_share_on_every_os() {
        let home = Some(PathBuf::from("/home/u"));
        assert_eq!(
            data_dir_from(Some("/tmp/d".into()), Some("/x".into()), home.clone()),
            PathBuf::from("/tmp/d")
        );
        assert_eq!(
            data_dir_from(None, Some("/x".into()), home.clone()),
            PathBuf::from("/x/tmuxy")
        );
        for ignored in [None, Some(OsString::from("relative/path"))] {
            assert_eq!(
                data_dir_from(Some(OsString::new()), ignored, home.clone()),
                PathBuf::from("/home/u/.local/share/tmuxy")
            );
        }
        let missing_home = data_dir_from(None, None, None);
        assert!(missing_home.is_absolute(), "{missing_home:?}");
        assert_ne!(
            missing_home,
            std::env::temp_dir()
                .join(".local")
                .join("share")
                .join("tmuxy")
        );
    }

    #[test]
    fn resolved_home_dir_is_always_absolute_and_never_shared_tmp() {
        let home = resolved_home_dir();
        assert!(home.is_absolute(), "{home:?}");
        assert_ne!(home, PathBuf::from("/tmp/tmuxy"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let fallback = unix_uid_temp_home().unwrap();
            let mode = std::fs::symlink_metadata(&fallback)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }
    }
}
