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

/// The commands that take an AppImage's variables out of a tmux server's
/// global environment, given what `show-environment -g` printed. A tmux
/// server an older tmuxy started from its AppImage kept that AppImage's
/// environment and handed it to every new pane, so git and curl in them still
/// loaded the bundle's libraries after an upgrade. The `APPDIR` the server
/// recorded names the bundle; without one there is nothing to clean.
pub fn global_env_cleanup(show_environment: &str) -> Vec<String> {
    let env: Vec<(&str, &str)> = show_environment
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    let value_of = |name: &str| env.iter().find(|(n, _)| *n == name).map(|(_, v)| *v);
    let Some(appdir) = value_of("APPDIR").filter(|dir| !dir.is_empty()) else {
        return Vec::new();
    };
    let appdir = Path::new(appdir);
    let unset = |var: &str| format!("set-environment -g -u {var}");
    let removed = VARS_TO_REMOVE
        .iter()
        .filter(|var| value_of(var).is_some())
        .map(|var| unset(var));
    let cleaned = PATH_LIST_VARS.iter().filter_map(|var| {
        let value = value_of(var)?;
        match clean_path_list(var, value, appdir) {
            Some(kept) if kept == value => None,
            Some(kept) => Some(format!(
                "set-environment -g {var} {}",
                crate::tmux_quote(&kept)
            )),
            None => Some(unset(var)),
        }
    });
    removed.chain(cleaned).collect()
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

/// Where a process started from an AppImage should be: `None` when `cwd` is
/// already outside the bundle, otherwise the first of `callers` that is an
/// existing directory outside it, or `home`.
fn dir_to_leave_appdir_for(
    appdir: &Path,
    cwd: Option<&Path>,
    callers: &[Option<&Path>],
    home: Option<&Path>,
) -> Option<PathBuf> {
    if cwd.is_some_and(|d| !d.starts_with(appdir)) {
        return None;
    }
    let usable = |d: &&Path| !d.as_os_str().is_empty() && !d.starts_with(appdir) && d.is_dir();
    callers
        .iter()
        .flatten()
        .copied()
        .chain(home)
        .find(usable)
        .map(Path::to_path_buf)
}

/// Run from an AppImage, a process starts in the bundle (`$APPDIR/usr`): the
/// bundle's AppRun changes into it. A verb there gave every tmux client it
/// started the bundle as its directory, so `tmuxy tab create` and `tmuxy pane
/// float` opened their pane in it, gone once the verb exited, and a relative
/// path would have been read from it too. This moves back to where the
/// AppImage was run from: `$OWD`, which the runtime sets when it mounts the
/// bundle, else `$PWD`, which the caller's shell exported and the AppRun's
/// change of directory leaves as it was (an AppImage run without FUSE, extracted
/// to /tmp, gets no `$OWD`), else home. Outside an AppImage it does nothing.
pub fn leave_appimage_mount() {
    let Some(appdir) = std::env::var_os("APPDIR") else {
        return;
    };
    let owd = std::env::var_os("OWD").map(PathBuf::from);
    let pwd = std::env::var_os("PWD").map(PathBuf::from);
    let home = dirs::home_dir();
    let cwd = std::env::current_dir().ok();
    if let Some(dir) = dir_to_leave_appdir_for(
        Path::new(&appdir),
        cwd.as_deref(),
        &[owd.as_deref(), pwd.as_deref()],
        home.as_deref(),
    ) {
        // A directory that vanished in between leaves the verb where it was.
        let _ = std::env::set_current_dir(dir);
    }
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
    fn a_tmux_server_started_from_an_appimage_loses_its_variables_and_keeps_the_users() {
        let env = "\
APPDIR=/tmp/.mount_tmuxyPdMlpc
ARGV0=tmuxy
HOME=/home/me
LD_LIBRARY_PATH=/tmp/.mount_tmuxyPdMlpc/usr/lib/:/tmp/.mount_tmuxyPdMlpc/lib/
PATH=/tmp/.mount_tmuxyPdMlpc/usr/bin/:/home/linuxbrew/.linuxbrew/bin:/usr/bin
QT_PLUGIN_PATH=/opt/qt/plugins
-TERM_PROGRAM
";
        assert_eq!(
            global_env_cleanup(env),
            vec![
                "set-environment -g -u APPDIR",
                "set-environment -g -u ARGV0",
                "set-environment -g PATH '/home/linuxbrew/.linuxbrew/bin:/usr/bin'",
                "set-environment -g -u LD_LIBRARY_PATH",
            ]
        );
    }

    #[test]
    fn a_tmux_server_with_no_appdir_is_left_as_it_is() {
        let env = "ARGV0=tmuxy\nPATH=/tmp/.mount_tmuxyPdMlpc/usr/bin:/usr/bin\n";
        assert!(global_env_cleanup(env).is_empty());
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

    #[test]
    fn a_verb_in_the_bundle_moves_to_where_it_was_called_and_one_outside_stays() {
        let root = std::env::temp_dir().join(format!("tmuxy-leave-mount-{}", std::process::id()));
        let appdir = root.join("mount");
        let owd = root.join("owd");
        let pwd = root.join("pwd");
        let home = root.join("home");
        std::fs::create_dir_all(appdir.join("usr")).unwrap();
        for dir in [&owd, &pwd, &home] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let in_bundle = appdir.join("usr");
        let leave = |cwd: Option<&Path>, callers: &[Option<&Path>]| {
            dir_to_leave_appdir_for(&appdir, cwd, callers, Some(&home))
        };

        // Mounted: the runtime's $OWD.
        assert_eq!(
            leave(Some(&in_bundle), &[Some(&owd), Some(&pwd)]),
            Some(owd.clone())
        );
        // Extracted without FUSE: no $OWD, the caller's $PWD.
        assert_eq!(
            leave(Some(&in_bundle), &[None, Some(&pwd)]),
            Some(pwd.clone())
        );
        // A $PWD inside the bundle, or one that is gone: home.
        assert_eq!(
            leave(Some(&in_bundle), &[None, Some(&in_bundle)]),
            Some(home.clone())
        );
        assert_eq!(
            leave(Some(&in_bundle), &[None, Some(&root.join("gone"))]),
            Some(home.clone())
        );
        // Already outside the bundle: stays put.
        assert_eq!(leave(Some(&home), &[Some(&owd), Some(&pwd)]), None);

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
