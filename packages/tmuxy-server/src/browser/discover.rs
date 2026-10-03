//! Finding a browser engine to drive, without shipping one.
//!
//! tmuxy does not bundle a browser. The `tmuxy browser` commands need a
//! Chromium-family binary — one that speaks the DevTools Protocol — and the
//! machine almost certainly has one: Chrome, Chromium, Edge, Brave, or the
//! Chrome for Testing build Playwright installs. Using the user's own means the
//! engine is patched on their schedule instead of pinned to a tmuxy release,
//! which is the right side of that trade for a component with a browser's
//! attack surface. It also means a machine without one does not have the
//! feature, and has to be told so clearly rather than failing somewhere deeper.
//!
//! The ladder mirrors `tests/helpers/browser.js`, which has done the same thing
//! for the E2E suite for much longer: an explicit environment variable first,
//! then the platform's usual paths, then a refusal that names what to do.

use std::path::{Path, PathBuf};

/// The env var that overrides discovery entirely.
///
/// The escape hatch matters more than the probe list: a flatpak, a Nix store
/// path, a build nobody has heard of, or simply a second Chrome the user wants
/// used instead. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is honoured too, because
/// anyone who has run the E2E suite already has it set to a working binary.
pub const CHROME_ENV: &str = "TMUXY_CHROME";
const PLAYWRIGHT_ENV: &str = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";

/// Why no engine could be used, in the terms the user needs to fix it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    /// `TMUXY_CHROME` (or the Playwright variable) was set to something unusable.
    /// Named separately from "nothing found" because the two have opposite
    /// fixes, and silently falling back to a different browser than the one
    /// someone explicitly asked for is worse than failing.
    OverrideUnusable { var: &'static str, path: PathBuf },
    /// Nothing on the ladder existed.
    NotFound { looked_in: Vec<PathBuf> },
}

impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OverrideUnusable { var, path } => write!(
                f,
                "{var} points at {}, which is not an executable file. \
                 Fix it or unset it to fall back to the usual paths.",
                path.display()
            ),
            Self::NotFound { looked_in } => {
                write!(
                    f,
                    "no Chromium-based browser found. `tmuxy browser` drives one \
                     over the DevTools Protocol; tmuxy does not ship it.\n\n\
                     Install one:\n  \
                     macOS:  brew install --cask google-chrome\n  \
                     Debian: sudo apt install chromium\n  \
                     Fedora: sudo dnf install chromium\n\n\
                     Or point {CHROME_ENV} at a binary you already have.\n\n\
                     Looked in:"
                )?;
                for path in looked_in {
                    write!(f, "\n  {}", path.display())?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for DiscoveryError {}

/// Where a Chromium-family browser lives on this platform, most-preferred
/// first.
///
/// Chrome before Chromium before the other forks, and the stable channel before
/// the rest: any of them works, so the order only decides which one a user who
/// has several ends up driving, and that should be the one they would have
/// opened themselves. Chrome for Testing comes last — it is a build installed
/// by tooling, not a browser anyone uses — but it comes at all, because a
/// machine that has run the E2E suite has one even if it has nothing else.
#[cfg(target_os = "macos")]
fn candidate_paths() -> Vec<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn candidate_paths() -> Vec<PathBuf> {
    // Both `/usr/bin` and `/usr/local/bin` for each name: distributions
    // disagree, and a locally built or manually unpacked browser lands in the
    // latter. `chromium-browser` is Debian's older name and still what Ubuntu's
    // snap shim installs.
    let names = [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge-stable",
        "microsoft-edge",
        "brave-browser",
    ];
    let mut paths = Vec::with_capacity(names.len() * 2);
    for dir in ["/usr/bin", "/usr/local/bin"] {
        for name in names {
            paths.push(Path::new(dir).join(name));
        }
    }
    paths
}

#[cfg(not(unix))]
fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let base = PathBuf::from(base);
            paths.push(base.join(r"Google\Chrome\Application\chrome.exe"));
            paths.push(base.join(r"Microsoft\Edge\Application\msedge.exe"));
            paths.push(base.join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
        }
    }
    paths
}

/// Whether a path is something that can actually be launched.
///
/// Existence is not enough: a dangling symlink, a directory with a browser's
/// name, or a non-executable file would all pass an `exists()` check and fail
/// at launch with an error about the wrong thing. On unix the mode bits are
/// checked; elsewhere a regular file is as far as this can tell.
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        // metadata() follows symlinks, so a dangling one lands here.
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The browser binary to drive, or why there is none.
pub fn find_browser() -> Result<PathBuf, DiscoveryError> {
    find_browser_with(&candidate_paths(), is_executable_file, |var| {
        std::env::var_os(var).map(PathBuf::from)
    })
}

/// The ladder itself, with the filesystem and environment injected.
///
/// Split out so the ordering and the refusals can be tested without a browser
/// installed, a real `/Applications`, or a mutated process environment — the
/// last of which is a global, and a test that writes it breaks whichever other
/// test happens to be running beside it.
pub fn find_browser_with(
    candidates: &[PathBuf],
    usable: impl Fn(&Path) -> bool,
    env: impl Fn(&'static str) -> Option<PathBuf>,
) -> Result<PathBuf, DiscoveryError> {
    for var in [CHROME_ENV, PLAYWRIGHT_ENV] {
        if let Some(path) = env(var) {
            // An empty value is "unset" — a shell that exports a variable it
            // could not resolve leaves it empty, and treating that as a
            // deliberate choice would refuse the command over a typo in a
            // profile.
            if path.as_os_str().is_empty() {
                continue;
            }
            if usable(&path) {
                return Ok(path);
            }
            return Err(DiscoveryError::OverrideUnusable { var, path });
        }
    }

    candidates
        .iter()
        .find(|path| usable(path))
        .cloned()
        .ok_or_else(|| DiscoveryError::NotFound {
            looked_in: candidates.to_vec(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTHING_SET: fn(&'static str) -> Option<PathBuf> = |_| None;

    fn paths(items: &[&str]) -> Vec<PathBuf> {
        items.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn the_first_usable_candidate_wins() {
        let candidates = paths(&["/no/chrome", "/yes/chromium", "/yes/edge"]);
        let found = find_browser_with(&candidates, |p| p.starts_with("/yes"), NOTHING_SET);
        assert_eq!(found, Ok(PathBuf::from("/yes/chromium")));
    }

    #[test]
    fn the_env_override_beats_every_candidate() {
        let candidates = paths(&["/yes/chrome"]);
        let found = find_browser_with(
            &candidates,
            |_| true,
            |var| (var == CHROME_ENV).then(|| PathBuf::from("/my/own/browser")),
        );
        assert_eq!(found, Ok(PathBuf::from("/my/own/browser")));
    }

    /// Anyone who has run the E2E suite has this set already, and it points at
    /// a binary that works.
    #[test]
    fn the_playwright_path_is_accepted_when_tmuxy_chrome_is_unset() {
        let found = find_browser_with(
            &[],
            |_| true,
            |var| {
                (var == "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
                    .then(|| PathBuf::from("/ms-playwright/chrome"))
            },
        );
        assert_eq!(found, Ok(PathBuf::from("/ms-playwright/chrome")));
    }

    /// Falling back silently would drive a different browser than the one the
    /// user named, which is worse than refusing: the symptom would be a feature
    /// that works but ignores the setting.
    #[test]
    fn an_override_pointing_at_nothing_is_an_error_not_a_fallback() {
        let candidates = paths(&["/yes/chrome"]);
        let found = find_browser_with(
            &candidates,
            |p| p.starts_with("/yes"),
            |var| (var == CHROME_ENV).then(|| PathBuf::from("/gone")),
        );
        assert_eq!(
            found,
            Err(DiscoveryError::OverrideUnusable {
                var: CHROME_ENV,
                path: PathBuf::from("/gone"),
            })
        );
    }

    /// A shell that exports a variable it could not resolve leaves it empty.
    /// Reading that as a deliberate choice would refuse the command over a typo
    /// in someone's profile.
    #[test]
    fn an_empty_override_is_ignored_rather_than_obeyed() {
        let candidates = paths(&["/yes/chrome"]);
        let found = find_browser_with(
            &candidates,
            |p| p.starts_with("/yes"),
            |var| (var == CHROME_ENV).then(PathBuf::new),
        );
        assert_eq!(found, Ok(PathBuf::from("/yes/chrome")));
    }

    #[test]
    fn nothing_found_lists_where_it_looked() {
        let candidates = paths(&["/a", "/b"]);
        let found = find_browser_with(&candidates, |_| false, NOTHING_SET);
        assert_eq!(
            found,
            Err(DiscoveryError::NotFound {
                looked_in: candidates
            })
        );
    }

    /// The message is the whole value of this error — it is what a user acts
    /// on, and it is the only place the feature explains that tmuxy ships no
    /// browser.
    #[test]
    fn the_not_found_message_says_how_to_fix_it() {
        let message = DiscoveryError::NotFound {
            looked_in: paths(&["/usr/bin/chromium"]),
        }
        .to_string();
        assert!(message.contains(CHROME_ENV), "names the escape hatch");
        assert!(message.contains("brew install"), "says how to install one");
        assert!(
            message.contains("/usr/bin/chromium"),
            "says where it looked"
        );
    }

    /// A directory named like a browser, and a file nobody may execute, both
    /// pass `exists()` and fail at launch with an error about something else.
    #[test]
    fn a_directory_or_an_unexecutable_file_is_not_a_browser() {
        let dir = std::env::temp_dir().join(format!("tmuxy-discover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Chromium")).expect("temp dir");
        let plain = dir.join("chrome");
        std::fs::write(&plain, b"#!/bin/sh\n").expect("write file");

        assert!(
            !is_executable_file(&dir.join("Chromium")),
            "a directory is not a binary"
        );
        assert!(
            !is_executable_file(&dir.join("absent")),
            "a missing path is not a binary"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(!is_executable_file(&plain), "mode 644 is not executable");
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
            assert!(is_executable_file(&plain), "mode 755 is");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Not an assertion about any particular machine — just that the platform
    /// list is non-empty and absolute, since a relative path would be resolved
    /// against the server's cwd, which is wherever it happened to be started.
    #[test]
    fn this_platform_has_somewhere_to_look() {
        let candidates = candidate_paths();
        assert!(
            !candidates.is_empty(),
            "no candidate paths for this platform"
        );
        for path in &candidates {
            assert!(path.is_absolute(), "{} is not absolute", path.display());
        }
    }
}
