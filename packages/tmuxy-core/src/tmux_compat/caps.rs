//! What the tmux server in use can do, from the version it reports.
//!
//! The version is read from the server itself, over the monitor's own
//! control-mode connection (`#{version}`, `Markers::version_read_command`), so
//! a server reached over SSH is judged by its own tmux, not by the `tmux` on
//! this machine. Until it has answered, every workaround stays on: a version
//! not known yet is treated as the oldest supported one.

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

/// The version a server reported, as far as it can be compared.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Version {
    /// Not asked yet, or the answer never came.
    #[default]
    Unknown,
    /// `3.5a` → `(3, 5)`; `next-3.8` and `3.8-rc` read as their number.
    Numbered(u32, u32),
    /// A build of tmux's own development branch (`master`): as new as any
    /// released version. A distribution's own tag (`openbsd-7.4`) says
    /// nothing of the tmux behind it, so it stays `Unknown`.
    Unnumbered,
}

/// The behaviour of one tmux server that depends on its version. Each
/// capability is a method named for what it lets tmuxy rely on, with the
/// version it arrived in; `docs/TMUX-VERSION-BUGS.md` lists them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TmuxCaps {
    version: Version,
}

impl TmuxCaps {
    /// From what `#{version}` expands to: `3.5a`, `next-3.8`, `3.8-rc`,
    /// `master`. An empty answer, or one with no number that is not
    /// `master`, is no answer.
    pub fn from_version(version: &str) -> Self {
        let version = version.trim();
        let version = match parse_version(&format!("tmux {version}")) {
            Some((major, minor)) => Version::Numbered(major, minor),
            None if version == "master" => Version::Unnumbered,
            None => Version::Unknown,
        };
        Self { version }
    }

    /// The server is `major.minor` or newer; `false` while its version is
    /// not known.
    pub fn at_least(self, major: u32, minor: u32) -> bool {
        match self.version {
            Version::Unknown => false,
            Version::Numbered(a, b) => (a, b) >= (major, minor),
            Version::Unnumbered => true,
        }
    }

    /// `swap-pane` is followed by a `%layout-change` (3.3; 3.2 sends none).
    pub fn announces_pane_swaps(self) -> bool {
        self.at_least(3, 3)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_read_as_tmux_reports_it() {
        let caps = TmuxCaps::from_version;
        assert!(caps("3.2a").at_least(3, 2));
        assert!(!caps("3.2a").at_least(3, 3));
        assert!(caps("3.5a").at_least(3, 3));
        assert!(caps("next-3.8").at_least(3, 8));
        assert!(caps("3.8-rc").at_least(3, 8));
        assert!(!caps("3.7a").at_least(3, 8));
        assert!(caps("10.0").at_least(3, 8));
    }

    /// Not asked, an empty answer, or a distribution's tag: the oldest
    /// behaviour, every workaround on. tmux's development branch: the newest.
    #[test]
    fn an_unknown_version_keeps_every_workaround_and_master_needs_none() {
        for unknown in ["", "  ", "openbsd-7.4"].map(TmuxCaps::from_version) {
            assert!(!unknown.at_least(3, 2));
            assert!(!unknown.announces_pane_swaps());
        }
        assert!(!TmuxCaps::default().at_least(3, 2));
        assert!(TmuxCaps::from_version("master").at_least(3, 8));
    }

    #[test]
    fn pane_swaps_are_announced_from_3_3() {
        assert!(!TmuxCaps::from_version("3.2a").announces_pane_swaps());
        assert!(TmuxCaps::from_version("3.3a").announces_pane_swaps());
        assert!(TmuxCaps::from_version("3.6a").announces_pane_swaps());
    }
}
