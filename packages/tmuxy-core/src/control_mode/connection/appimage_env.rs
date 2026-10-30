//! What an AppImage puts in its own environment, kept out of the tmux server
//! tmuxy starts from it.
//!
//! An AppImage's launcher points `LD_LIBRARY_PATH` at the libraries bundled in
//! its mount (`$APPDIR/usr/lib`, …) so the app finds them. Passed on to tmux,
//! every shell in every pane inherits it, and any system program then loads
//! the bundle's older copies before the system's own: on Ubuntu, `node` died
//! with `undefined symbol: nghttp2_option_set_no_rfc9113_…` from the bundle's
//! libnghttp2. Only the AppImage's entries are dropped; a directory the user
//! put there themselves stays.

use std::path::Path;

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

#[cfg(test)]
mod tests {
    use super::without_appdir;
    use std::path::Path;

    const APPDIR: &str = "/tmp/.mount_tmuxyPdMlpc";

    #[test]
    fn the_bundles_own_library_dirs_go() {
        let value = "/tmp/.mount_tmuxyPdMlpc/usr/lib/:/tmp/.mount_tmuxyPdMlpc/usr/lib/x86_64-linux-gnu/:/tmp/.mount_tmuxyPdMlpc/lib/";
        assert_eq!(without_appdir(value, Path::new(APPDIR)), None);
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
}
