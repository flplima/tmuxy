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

/// An absolute home directory even when `$HOME` is unset: `dirs::home_dir()`
/// (`$HOME`, else the passwd entry's), else a private per-UID
/// `/tmp/tmuxy-<uid>` that must be a real `0700` directory this user owns.
/// The CLI resolves the same way (`_tmuxy_home` in
/// `tmuxy-cli/bin/tmuxy/_lib`). When even that is refused (a symlink or
/// another user's directory squats the name), the result is `/`, which no
/// other user can write under, rather than any shared temp path.
pub fn resolved_home_dir() -> PathBuf {
    dirs::home_dir()
        .filter(|p| p.is_absolute())
        .unwrap_or_else(fallback_home)
}

#[cfg(unix)]
fn fallback_home() -> PathBuf {
    // SAFETY: getuid() has no preconditions.
    let uid = unsafe { libc::getuid() };
    private_uid_dir(std::path::Path::new("/tmp"), uid).unwrap_or_else(|_| PathBuf::from("/"))
}

#[cfg(not(unix))]
fn fallback_home() -> PathBuf {
    std::env::temp_dir().join("tmuxy-home")
}

/// `<base>/tmuxy-<uid>`, created `0700` if missing, and refused unless it is
/// a directory (not a symlink) that `uid` owns. `base` is sticky `/tmp`, so
/// once checked it cannot be swapped by another user.
#[cfg(unix)]
fn private_uid_dir(base: &std::path::Path, uid: u32) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let dir = base.join(format!("tmuxy-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(&dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != uid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "unsafe fallback home directory",
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
        assert!(missing_home.is_absolute());
        assert_ne!(
            missing_home,
            std::env::temp_dir()
                .join(".local")
                .join("share")
                .join("tmuxy")
        );
    }

    #[test]
    fn the_resolved_home_is_always_absolute() {
        assert!(resolved_home_dir().is_absolute());
    }

    #[cfg(unix)]
    #[test]
    fn the_fallback_home_is_a_private_dir_the_user_owns_and_never_a_symlink() {
        use std::os::unix::fs::PermissionsExt;

        // SAFETY: getuid() has no preconditions.
        let uid = unsafe { libc::getuid() };
        let base = std::env::temp_dir().join(format!("tmuxy-home-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.join(format!("tmuxy-{uid}"));
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;

        // Created owner-only when missing.
        assert_eq!(private_uid_dir(&base, uid).unwrap(), dir);
        assert_eq!(mode(&dir), 0o700);

        // An existing one of the user's own is tightened.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(private_uid_dir(&base, uid).unwrap(), dir);
        assert_eq!(mode(&dir), 0o700);

        // Another user's directory under the name is refused (a test cannot
        // chown, so it asks for the directory as a uid that does not own it).
        let other = uid.wrapping_add(1);
        std::fs::rename(&dir, base.join(format!("tmuxy-{other}"))).unwrap();
        assert!(private_uid_dir(&base, other).is_err());

        // A symlink under the name is refused, even to a directory the user owns.
        let decoy = base.join("decoy");
        std::fs::create_dir(&decoy).unwrap();
        std::os::unix::fs::symlink(&decoy, &dir).unwrap();
        assert!(private_uid_dir(&base, uid).is_err());

        std::fs::remove_dir_all(&base).unwrap();
    }
}
