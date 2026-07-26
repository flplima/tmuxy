//! Linux applications-menu registration.
//!
//! The Homebrew formula installs the release AppImage as a bare `bin/tmuxy`,
//! so nothing hands the desktop environment a `.desktop` entry: Homebrew's
//! own `share/applications` is not on `XDG_DATA_DIRS`, and Homebrew 6 runs
//! `post_install` with a read-only `$HOME`, so the formula cannot write one
//! either. tmuxy therefore registers itself: every launch from an AppImage
//! mirrors the bundled entry and icons into `$XDG_DATA_HOME`, which every
//! desktop environment scans.
//!
//! The write is skipped when the on-disk entry already matches byte for byte,
//! so the steady-state cost is a single small read. Set
//! `TMUXY_NO_DESKTOP_ENTRY` to opt out entirely.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Stamped into the entry so an upgrade rewrites it (and refreshes the icons)
/// even when every other key is unchanged.
const STAMP_KEY: &str = "X-Tmuxy-Version";

/// Keys we own. Anything else in the bundled entry (Name, Comment,
/// Categories, ...) is carried over untouched so this stays in sync with
/// `tauri.conf.json` instead of duplicating it.
const OWNED_KEYS: &[&str] = &["Exec", "Icon", "StartupWMClass", STAMP_KEY];

/// Mirror the AppImage's desktop entry and icons into `$XDG_DATA_HOME`.
///
/// Best-effort and silent: a missing `$HOME`, a read-only data dir, or a
/// non-AppImage build all just mean no menu entry, never a failed launch or
/// stray output on a CLI path.
pub fn ensure_entry() {
    if std::env::var_os("TMUXY_NO_DESKTOP_ENTRY").is_some() {
        return;
    }

    let Some(appdir) = std::env::var_os("APPDIR").map(PathBuf::from) else {
        return; // Not running from an AppImage — nothing bundled to mirror.
    };
    let Some(exec) = exec_path() else { return };
    let Some(data_home) = data_home() else { return };

    let bundled = appdir.join("usr/share/applications/tmuxy.desktop");
    let Ok(source) = std::fs::read_to_string(&bundled) else {
        return;
    };
    let entry = rewrite_entry(&source, &exec);

    let apps_dir = data_home.join("applications");
    let dest = apps_dir.join("tmuxy.desktop");
    if std::fs::read_to_string(&dest).is_ok_and(|current| current == entry) {
        return; // Already current — including the version stamp.
    }

    if std::fs::create_dir_all(&apps_dir).is_err() || std::fs::write(&dest, &entry).is_err() {
        return;
    }

    copy_icons(&appdir.join("usr/share/icons/hicolor"), &data_home);

    // Menus that cache the entry index need a nudge; those that watch the
    // directory do not, and either way a failure here is not fatal.
    let _ = std::process::Command::new("update-desktop-database")
        .arg(&apps_dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// `$XDG_DATA_HOME`, falling back to the spec default of `~/.local/share`.
fn data_home() -> Option<PathBuf> {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")),
    }
}

/// The path the menu entry should launch.
///
/// `$APPIMAGE` points at the AppImage that is running, which under Homebrew
/// is the versioned Cellar path — a path that disappears on the next
/// `brew upgrade`, taking the launcher with it. Rewrite those to the
/// equivalent `opt/<formula>` symlink, which Homebrew repoints on upgrade.
fn exec_path() -> Option<String> {
    let appimage = std::env::var("APPIMAGE").ok()?;
    Some(cellar_to_opt(&appimage).unwrap_or(appimage))
}

/// `<prefix>/Cellar/<formula>/<version>/<rest>` → `<prefix>/opt/<formula>/<rest>`,
/// and `None` for any path that is not inside a Cellar or whose `opt` twin
/// does not exist.
fn cellar_to_opt(appimage: &str) -> Option<String> {
    let (prefix, tail) = appimage.split_once("/Cellar/")?;
    let mut parts = tail.splitn(3, '/');
    let formula = parts.next()?;
    parts.next()?; // version
    let rest = parts.next()?;

    let opt = format!("{prefix}/opt/{formula}/{rest}");
    Path::new(&opt).exists().then_some(opt)
}

/// Rebuild the bundled entry with our keys overridden and the rest kept.
fn rewrite_entry(source: &str, exec: &str) -> String {
    let mut out = String::with_capacity(source.len() + 128);

    for line in source.lines() {
        let owned = line
            .split_once('=')
            .is_some_and(|(key, _)| OWNED_KEYS.contains(&key.trim()));
        if !owned {
            out.push_str(line);
            out.push('\n');
        }
    }

    // Quoted per the Desktop Entry spec so a prefix containing spaces (or any
    // other reserved character) still launches.
    out.push_str(&format!("Exec=\"{exec}\" gui\n"));
    out.push_str("Icon=tmuxy\n");
    out.push_str("StartupWMClass=tmuxy\n");
    out.push_str(&format!("{STAMP_KEY}={}\n", env!("CARGO_PKG_VERSION")));
    out
}

/// Copy every `<size>/apps/tmuxy.*` icon out of the AppImage into the user's
/// hicolor theme. Sizes are whatever the bundle happens to ship.
fn copy_icons(source_theme: &Path, data_home: &Path) {
    let Ok(sizes) = std::fs::read_dir(source_theme) else {
        return;
    };

    for size in sizes.flatten() {
        let apps = size.path().join("apps");
        let Ok(icons) = std::fs::read_dir(&apps) else {
            continue;
        };

        for icon in icons.flatten() {
            let path = icon.path();
            if path.file_stem() != Some(OsStr::new("tmuxy")) {
                continue;
            }
            let Some(name) = path.file_name() else {
                continue;
            };

            let dest_dir = data_home
                .join("icons/hicolor")
                .join(size.file_name())
                .join("apps");
            if std::fs::create_dir_all(&dest_dir).is_ok() {
                let _ = std::fs::copy(&path, dest_dir.join(name));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_owned_keys_and_keeps_the_rest() {
        let source = "[Desktop Entry]\n\
                      Categories=Development;\n\
                      Comment=Tmuxy Tauri desktop application\n\
                      Exec=tmuxy\n\
                      Icon=tmuxy\n\
                      Name=tmuxy\n\
                      StartupWMClass=tmuxy\n\
                      Terminal=false\n\
                      Type=Application\n";

        let entry = rewrite_entry(source, "/opt/tmuxy/bin/tmuxy");
        let lines: Vec<&str> = entry.lines().collect();

        assert_eq!(lines[0], "[Desktop Entry]");
        assert!(lines.contains(&"Categories=Development;"));
        assert!(lines.contains(&"Name=tmuxy"));
        assert!(lines.contains(&"Exec=\"/opt/tmuxy/bin/tmuxy\" gui"));
        // Overridden, not duplicated.
        assert_eq!(lines.iter().filter(|l| l.starts_with("Exec=")).count(), 1);
        assert_eq!(lines.iter().filter(|l| l.starts_with("Icon=")).count(), 1);
        assert!(entry.contains(&format!("{STAMP_KEY}={}", env!("CARGO_PKG_VERSION"))));
    }

    #[test]
    fn rewrite_is_stable_across_repeated_runs() {
        let source = "[Desktop Entry]\nExec=tmuxy\nName=tmuxy\nType=Application\n";
        let once = rewrite_entry(source, "/opt/tmuxy/bin/tmuxy");
        assert_eq!(rewrite_entry(&once, "/opt/tmuxy/bin/tmuxy"), once);
    }

    #[test]
    fn leaves_non_cellar_paths_alone() {
        assert_eq!(cellar_to_opt("/home/me/Applications/tmuxy.AppImage"), None);
        assert_eq!(cellar_to_opt("/usr/local/bin/tmuxy"), None);
    }

    #[test]
    fn maps_cellar_paths_onto_the_opt_symlink() {
        let prefix = std::env::temp_dir().join(format!("tmuxy-cellar-{}", std::process::id()));
        std::fs::create_dir_all(prefix.join("opt/tmuxy/bin")).unwrap();
        std::fs::write(prefix.join("opt/tmuxy/bin/tmuxy"), "").unwrap();

        let prefix = prefix.to_string_lossy().into_owned();
        let cellar = format!("{prefix}/Cellar/tmuxy/0.0.10-alpha.43/bin/tmuxy");
        assert_eq!(
            cellar_to_opt(&cellar),
            Some(format!("{prefix}/opt/tmuxy/bin/tmuxy"))
        );

        std::fs::remove_dir_all(&prefix).unwrap();
    }

    #[test]
    fn keeps_the_cellar_path_when_no_opt_twin_exists() {
        assert_eq!(
            cellar_to_opt("/nonexistent/Cellar/tmuxy/0.0.1/bin/tmuxy"),
            None
        );
    }
}
