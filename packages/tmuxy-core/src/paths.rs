//! Where tmuxy keeps per-machine state: the trace file, session snapshots,
//! browser profiles and screenshots.
//!
//! One resolution for every host and every verb, so a `tmuxy trace --mark`
//! stamps the file the server is writing and a test's `TMUXY_STATE_DIR` moves
//! all of it at once. The directory is deliberately nowhere any route serves
//! files from (docs/SECURITY.md).

use std::ffi::OsString;
use std::path::PathBuf;

/// The state directory: `TMUXY_STATE_DIR`, else the XDG state dir (macOS has
/// none, so `~/Library/Application Support`), under `tmuxy`. Resolving it
/// creates nothing.
pub fn state_dir() -> PathBuf {
    state_dir_from(std::env::var_os("TMUXY_STATE_DIR"))
}

/// The file the action trace is written to (docs/TELEMETRY.md), unless
/// `--trace <path>` names another.
pub fn trace_file() -> PathBuf {
    state_dir().join("trace.ndjson")
}

/// [`state_dir`] as a function of the override, so the rule is testable
/// without touching the process environment.
fn state_dir_from(override_dir: Option<OsString>) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
        .unwrap_or_else(std::env::temp_dir)
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
}
