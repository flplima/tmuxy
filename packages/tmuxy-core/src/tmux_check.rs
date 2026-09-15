//! Is there a tmux tmuxy can drive?
//!
//! Checked once at startup by the desktop app and by `tmuxy server`, so a
//! missing or too-old tmux is a message a person can act on — rather than a
//! desktop app that vanishes on launch, or a web client stuck reconnecting to a
//! monitor that can never attach.

use std::fmt;

/// The oldest tmux tmuxy runs on. Control-mode flow control (`pause-after`,
/// `refresh-client -A`) needs 3.2; 3.3a is the oldest release the workarounds
/// in docs/TMUX.md were found and verified on.
pub const MIN_TMUX_VERSION: (u32, u32) = (3, 3);

const INSTALL_HINT: &str =
    "macOS: brew install tmux · Debian/Ubuntu: sudo apt install tmux · Fedora: sudo dnf install tmux";

/// Why tmuxy cannot start on this machine's tmux.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxCheckError {
    NotFound {
        binary: String,
        error: String,
    },
    Failed {
        binary: String,
        code: Option<i32>,
        stderr: String,
    },
    TooOld {
        binary: String,
        version: String,
    },
}

impl fmt::Display for TmuxCheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (major, minor) = MIN_TMUX_VERSION;
        match self {
            TmuxCheckError::NotFound { binary, error } => write!(
                f,
                "tmuxy needs tmux {major}.{minor} or newer, and could not find it.\n\n\
                 Install it, then start tmuxy again.\n{INSTALL_HINT}\n\n\
                 Looked for: {binary} ({error})"
            ),
            TmuxCheckError::TooOld { binary, version } => write!(
                f,
                "tmuxy needs tmux {major}.{minor} or newer; this machine has {version}.\n\n\
                 Update it, then start tmuxy again.\n{INSTALL_HINT}\n\n\
                 tmux binary: {binary}"
            ),
            TmuxCheckError::Failed {
                binary,
                code,
                stderr,
            } => write!(
                f,
                "tmux is installed but failed to run.\n\n\
                 tmux binary: {binary}\nexit code: {}\nstderr: {stderr}",
                code.map_or_else(|| "none".to_string(), |c| c.to_string())
            ),
        }
    }
}

impl std::error::Error for TmuxCheckError {}

/// The `(major, minor)` a `tmux -V` line reports: `tmux 3.5a` → `(3, 5)`,
/// `tmux next-3.6` → `(3, 6)`. `None` for a build that names no number
/// (`tmux master`, `tmux openbsd-7.4`).
pub fn parse_version(output: &str) -> Option<(u32, u32)> {
    let version = output.trim().strip_prefix("tmux ")?;
    let version = version.strip_prefix("next-").unwrap_or(version);
    let (major, rest) = version.split_once('.')?;
    let minor: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// Judge a `tmux -V` line against [`MIN_TMUX_VERSION`]. A build that reports
/// no number is given the benefit of the doubt.
fn judge(binary: &str, output: &str) -> Result<String, TmuxCheckError> {
    let line = output.trim().to_string();
    match parse_version(&line) {
        Some(found) if found < MIN_TMUX_VERSION => Err(TmuxCheckError::TooOld {
            binary: binary.to_string(),
            version: line,
        }),
        _ => Ok(line),
    }
}

/// Run `tmux -V` the way tmuxy will run tmux, and return its version line.
pub fn check_tmux() -> Result<String, TmuxCheckError> {
    let binary = crate::session::tmux_bin();
    let output = crate::session::tmux_command()
        .arg("-V")
        .output()
        .map_err(|e| TmuxCheckError::NotFound {
            binary: binary.clone(),
            error: e.to_string(),
        })?;
    if !output.status.success() {
        return Err(TmuxCheckError::Failed {
            binary,
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    judge(&binary, &String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_every_build_style_prints() {
        assert_eq!(parse_version("tmux 3.5a\n"), Some((3, 5)));
        assert_eq!(parse_version("tmux 3.7a"), Some((3, 7)));
        assert_eq!(parse_version("tmux 3.4"), Some((3, 4)));
        assert_eq!(parse_version("tmux next-3.6"), Some((3, 6)));
        assert_eq!(parse_version("tmux 3.3-rc"), Some((3, 3)));
        assert_eq!(parse_version("tmux 10.0"), Some((10, 0)));
        assert_eq!(parse_version("tmux master"), None);
        assert_eq!(parse_version("tmux openbsd-7.4"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn an_old_tmux_is_refused_with_the_version_it_found() {
        let err = judge("/usr/bin/tmux", "tmux 3.2a\n").unwrap_err();
        assert_eq!(
            err,
            TmuxCheckError::TooOld {
                binary: "/usr/bin/tmux".into(),
                version: "tmux 3.2a".into()
            }
        );
        let message = err.to_string();
        assert!(message.contains("3.3 or newer"), "{message}");
        assert!(message.contains("tmux 3.2a"), "{message}");
    }

    #[test]
    fn the_minimum_and_anything_newer_or_unnumbered_is_accepted() {
        assert_eq!(judge("tmux", "tmux 3.3a"), Ok("tmux 3.3a".into()));
        assert_eq!(judge("tmux", "tmux 4.0"), Ok("tmux 4.0".into()));
        assert_eq!(judge("tmux", "tmux master"), Ok("tmux master".into()));
    }

    #[test]
    fn a_missing_tmux_says_how_to_install_it() {
        let message = TmuxCheckError::NotFound {
            binary: "tmux".into(),
            error: "No such file or directory".into(),
        }
        .to_string();
        assert!(message.contains("could not find it"), "{message}");
        assert!(message.contains("brew install tmux"), "{message}");
    }
}
