//! What an AppImage puts in its own environment, working directory and open
//! file descriptors, kept out of the tmux server tmuxy starts from it.
//!
//! An AppImage's runtime and GTK hooks configure the process for the bundled
//! binaries and libraries inside `$APPDIR`:
//!   - `LD_LIBRARY_PATH`, `PATH`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`,
//!     `QT_PLUGIN_PATH`, `GST_PLUGIN_SYSTEM_PATH*`, `PERLLIB` are prefixed
//!     with `$APPDIR/…` entries. Passed on to tmux, every shell in every pane
//!     inherits them, loading the bundle's older libraries first and keeping
//!     an old `$APPDIR/usr/bin` ahead of `$PATH` after an upgrade.
//!   - `APPIMAGE`, `APPDIR`, `ARGV0`, `OWD`, `PYTHON*`, `GTK_*`, `GDK_*`,
//!     `GIO_*`, `GI_*` are exported (`ARGV0=tmuxy` breaks Rust coreutils in
//!     child processes).
//!   - `AppRun` `chdir`s into `$APPDIR/usr` and saves the caller's working
//!     directory in `OWD`.
//!   - The AppImage runtime holds `$APPDIR` open on a file descriptor (1023)
//!     without `FD_CLOEXEC`. Inherited by `tmux`, the daemonized `tmux` server
//!     holds the FUSE mount open even after `tmuxy` exits or upgrades.

use std::path::{Path, PathBuf};

/// Environment variables set wholly by the AppImage runtime / GTK hooks that
/// should be removed before spawning `tmux`.
pub(super) const VARS_TO_REMOVE: &[&str] = &[
    "APPIMAGE",
    "APPDIR",
    "ARGV0",
    "OWD",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONDONTWRITEBYTECODE",
    "GTK_THEME",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_MODULE_DIR",
    "GI_TYPELIB_PATH",
];

/// `:`-separated path list variables to which `AppRun` / GTK hooks prepend
/// `$APPDIR/…` entries; only the `$APPDIR` entries are stripped so user entries
/// survive.
pub(super) const PATH_LIST_VARS: &[&str] = &[
    "PATH",
    "LD_LIBRARY_PATH",
    "XDG_DATA_DIRS",
    "GSETTINGS_SCHEMA_DIR",
    "QT_PLUGIN_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "PERLLIB",
];

/// `value` (a `:`-separated path list) without the entries inside `appdir`;
/// `None` when nothing is left, so the variable can be removed rather than set
/// empty (an empty entry means the current directory to the dynamic loader).
pub(super) fn without_appdir(value: &str, appdir: &Path) -> Option<String> {
    let kept: Vec<&str> = value
        .split(':')
        .filter(|entry| !entry.is_empty() && !Path::new(entry).starts_with(appdir))
        .collect();
    (!kept.is_empty()).then(|| kept.join(":"))
}

/// Clean a `:`-separated path-list variable (`var`) of entries inside `appdir`.
///
/// `linuxdeploy-plugin-gtk.sh` sets
/// `XDG_DATA_DIRS="$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS"`, which turns an
/// unset `XDG_DATA_DIRS` into `"/usr/share"` once `$APPDIR` is stripped and
/// drops `/usr/local/share` from the XDG spec default. Returning `None` when
/// only `"/usr/share"` remains restores the unset default.
pub(super) fn clean_path_list(var: &str, value: &str, appdir: &Path) -> Option<String> {
    let kept = without_appdir(value, appdir)?;
    if var == "XDG_DATA_DIRS" && kept == "/usr/share" {
        return None;
    }
    Some(kept)
}

/// Directory `tmux` should start in when `spawn_tmux` was given no explicit
/// `working_dir`: `$OWD` (where the AppImage was launched from) when it is an
/// existing directory outside `appdir`, otherwise `home`. Avoids starting the
/// `tmux` daemon with `cwd = $APPDIR/usr`, which pins the FUSE mount.
pub(super) fn working_dir_outside_appdir(
    appdir: &Path,
    owd: Option<&Path>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    owd.filter(|d| !d.as_os_str().is_empty() && !d.starts_with(appdir) && d.is_dir())
        .or_else(|| {
            home.filter(|d| !d.as_os_str().is_empty() && !d.starts_with(appdir) && d.is_dir())
        })
        .map(Path::to_path_buf)
}

/// Mark any open file descriptor pointing inside `appdir` as `FD_CLOEXEC` so
/// spawned `tmux` processes do not inherit the AppImage FUSE mount descriptor.
#[cfg(unix)]
pub(super) fn close_appdir_fds_on_exec(appdir: &Path) {
    close_fds_in_on_exec(Path::new("/proc/self/fd"), appdir);
}

#[cfg(unix)]
fn close_fds_in_on_exec(proc_fd: &Path, appdir: &Path) {
    let Ok(entries) = std::fs::read_dir(proc_fd) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(fd) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<libc::c_int>().ok())
        else {
            continue;
        };
        let Ok(target) = std::fs::read_link(entry.path()) else {
            continue;
        };
        if target.starts_with(appdir) {
            // SAFETY: `fd` is a valid descriptor from `/proc/self/fd`, and
            // `F_GETFD`/`F_SETFD` only read/update its `FD_CLOEXEC` flag.
            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags >= 0 && (flags & libc::FD_CLOEXEC) == 0 {
                    libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const APPDIR: &str = "/tmp/.mount_tmuxyPdMlpc";

    #[test]
    fn the_bundles_own_library_dirs_go() {
        let value = "/tmp/.mount_tmuxyPdMlpc/usr/lib/:/tmp/.mount_tmuxyPdMlpc/usr/lib/x86_64-linux-gnu/:/tmp/.mount_tmuxyPdMlpc/lib/";
        assert_eq!(without_appdir(value, Path::new(APPDIR)), None);
    }

    #[test]
    fn the_bundles_own_bin_dirs_leave_path_while_system_entries_stay() {
        let value = "/tmp/.mount_tmuxyPdMlpc/usr/bin/:/tmp/.mount_tmuxyPdMlpc/bin/:/home/linuxbrew/.linuxbrew/bin:/usr/bin";
        assert_eq!(
            without_appdir(value, Path::new(APPDIR)).as_deref(),
            Some("/home/linuxbrew/.linuxbrew/bin:/usr/bin")
        );
    }

    #[test]
    fn a_directory_the_user_set_stays() {
        let value = "/tmp/.mount_tmuxyPdMlpc/usr/lib/:/opt/cuda/lib64:/tmp/.mount_tmuxyPdMlpc/lib/";
        assert_eq!(
            without_appdir(value, Path::new(APPDIR)).as_deref(),
            Some("/opt/cuda/lib64")
        );
    }

    #[test]
    fn a_sibling_whose_name_only_starts_the_same_is_not_the_bundle() {
        let value = "/tmp/.mount_tmuxyPdMlpcOTHER/usr/lib";
        assert_eq!(
            without_appdir(value, Path::new(APPDIR)).as_deref(),
            Some("/tmp/.mount_tmuxyPdMlpcOTHER/usr/lib")
        );
    }

    #[test]
    fn empty_entries_are_dropped_not_kept_as_the_current_directory() {
        assert_eq!(
            without_appdir("::/usr/local/lib:", Path::new(APPDIR)).as_deref(),
            Some("/usr/local/lib")
        );
    }

    #[test]
    fn xdg_data_dirs_injected_from_unset_env_is_removed_while_custom_dirs_stay() {
        let injected =
            "/tmp/.mount_tmuxyPdMlpc/usr/share/:/tmp/.mount_tmuxyPdMlpc/usr/share:/usr/share:";
        assert_eq!(
            clean_path_list("XDG_DATA_DIRS", injected, Path::new(APPDIR)),
            None
        );

        let with_custom = "/tmp/.mount_tmuxyPdMlpc/usr/share:/usr/share:/home/linuxbrew/.linuxbrew/share:/usr/local/share:/usr/share";
        assert_eq!(
            clean_path_list("XDG_DATA_DIRS", with_custom, Path::new(APPDIR)).as_deref(),
            Some("/usr/share:/home/linuxbrew/.linuxbrew/share:/usr/local/share:/usr/share")
        );
    }

    #[test]
    fn working_dir_prefers_owd_outside_appdir_and_falls_back_to_home() {
        let root = std::env::temp_dir().join(format!("tmuxy-appdir-cwd-{}", std::process::id()));
        let appdir = root.join("mount");
        let owd = root.join("owd");
        let home = root.join("home");
        std::fs::create_dir_all(appdir.join("usr")).unwrap();
        std::fs::create_dir_all(&owd).unwrap();
        std::fs::create_dir_all(&home).unwrap();

        assert_eq!(
            working_dir_outside_appdir(&appdir, Some(&owd), Some(&home)),
            Some(owd.clone())
        );
        // When OWD points inside appdir (or is missing), fall back to home.
        assert_eq!(
            working_dir_outside_appdir(&appdir, Some(&appdir.join("usr")), Some(&home)),
            Some(home.clone())
        );
        assert_eq!(
            working_dir_outside_appdir(&appdir, None, Some(&home)),
            Some(home)
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn open_descriptors_inside_appdir_are_marked_cloexec() {
        use std::os::fd::AsRawFd;

        let root = std::env::temp_dir().join(format!("tmuxy-appdir-fd-{}", std::process::id()));
        let appdir = root.join("mount");
        std::fs::create_dir_all(&appdir).unwrap();

        let dir_file = std::fs::File::open(&appdir).unwrap();
        let fd = dir_file.as_raw_fd();
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            assert!(flags >= 0);
            assert_eq!(libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC), 0);
            assert_eq!(libc::fcntl(fd, libc::F_GETFD) & libc::FD_CLOEXEC, 0);
        }

        close_appdir_fds_on_exec(&appdir);

        unsafe {
            assert_ne!(libc::fcntl(fd, libc::F_GETFD) & libc::FD_CLOEXEC, 0);
        }

        drop(dir_file);
        let _ = std::fs::remove_dir_all(&root);
    }
}
