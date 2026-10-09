//! Launching the engine, and the arguments that decide what it is allowed to be.
//!
//! The flags here are the security posture in executable form: the throwaway
//! profile, headless, no extensions, and a debugging port that is loopback-only
//! and kernel-assigned. Each one is load-bearing and the reasoning is in
//! `docs/SECURITY.md` ("A Real Browser Driven From a Pane Changes Whose Network
//! This Is");
//! this module is where it is applied, so the comments say which property each
//! flag buys rather than restating the section.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chromiumoxide::browser::BrowserConfig;

/// How long to wait for the engine to print its websocket URL.
///
/// Generous: a cold Chromium on a loaded machine takes seconds to reach the
/// point where it announces itself, and failing early reads to a user as "the
/// feature is broken" rather than "the machine is busy".
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Where a session's throwaway profile lives.
///
/// Under the state dir rather than a temp dir: a profile is up to a few hundred
/// MB, and `/tmp` on some machines is a tmpfs sized for much less. Named by
/// session so two sessions cannot share one — Chromium locks a profile, and the
/// second engine would fail to start or, worse, attach to the first.
pub fn profile_dir(state_dir: &Path, session: &str) -> PathBuf {
    state_dir.join("browser-profiles").join(session)
}

/// The flags every launch carries, as plain strings.
///
/// Separate from the builder so they can be asserted on: these are a security
/// boundary, and a flag quietly lost in a refactor is the kind of regression
/// that leaves the feature working.
fn engine_args() -> Vec<String> {
    [
        // Nothing of the user's browser comes along: no extension can see the
        // pages tmuxy opens, and no extension's own permissions apply.
        "--disable-extensions",
        // The first-run flow, the default-browser prompt and the sign-in promos
        // are all modal in a profile that has never been used, and a headless
        // engine cannot be clicked out of them.
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
        // Nothing here should phone home: this engine exists to render the
        // pages it is told to, and a background request is both noise in the
        // trace and a request from the server's network position.
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--metrics-recording-only",
        "--no-pings",
        // A crash dialog in a headless process is a hang.
        "--disable-crash-reporter",
        // A server has no GPU and the fallback probe costs a second of startup.
        "--disable-gpu",
        // `/dev/shm` is 64MB in a default Docker container, which Chromium
        // exhausts and then crashes on a page of any size. The devcontainer and
        // the CI runner are both affected; the E2E harness passes the same flag
        // (`tests/helpers/browser.js`).
        "--disable-dev-shm-usage",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// The config for an engine serving one browser pane.
///
/// `port(0)` is the part worth reading twice. chromiumoxide speaks CDP over a
/// WebSocket, so unlike the pipe transport this used to carry there IS a
/// listening socket — and an unauthenticated one, since CDP has no auth. Three
/// things keep that honest: the port is chosen by the KERNEL rather than fixed
/// (chromiumoxide reads the real one back from Chromium's stderr, so nothing
/// has to agree on a number in advance), it is loopback-only, and it dies with
/// the pane. That is a weaker property than a pipe which opens no socket at
/// all, and `docs/SECURITY.md` says so rather than implying otherwise.
pub fn engine_config(browser: &Path, profile: &Path) -> Result<BrowserConfig, String> {
    BrowserConfig::builder()
        .chrome_executable(browser)
        // A profile of this session's own, removed when the session ends. No
        // cookie, token or logged-in account from the user's real browsing is
        // reachable from a page tmuxy opens, and nothing a page stores outlives
        // the session. Chrome 136+ also refuses remote debugging against the
        // DEFAULT profile, so this is what makes the connection work at all.
        .user_data_dir(profile)
        // There is no display on the machine this is most useful on — a server
        // reached over SSH — and a window nobody can see is worse than none.
        .new_headless_mode()
        // Kernel-assigned: never 9222, the number every scanner and every other
        // automation tool on the machine already tries.
        .port(0)
        .launch_timeout(LAUNCH_TIMEOUT)
        .args(engine_args())
        .build()
}

#[cfg(test)]
// A test's `expect` IS its assertion: the panic message is the failure report.
// CI does not lint test code (docs/TESTS.md, Known Gaps); this is for whoever
// runs clippy with --tests.
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// The number that must never appear. 9222 is the default every other tool
    /// and every scanner tries first; a kernel-assigned port is the whole point.
    #[test]
    fn no_fixed_debugging_port_is_ever_requested() {
        let args = engine_args();
        assert!(
            !args.iter().any(|a| a.contains("9222")),
            "9222 is the port every scanner already tries: {args:?}"
        );
        assert!(
            !args
                .iter()
                .any(|a| a.starts_with("--remote-debugging-port")),
            "the port is chosen by the kernel via `port(0)`, not hard-coded: {args:?}"
        );
    }

    /// A config that builds at all is the baseline; what matters is that it
    /// takes the binary and profile it was given, since those are what keep the
    /// user's real cookies out of reach.
    #[test]
    fn the_config_uses_the_given_binary_and_its_own_profile() {
        let config = engine_config(
            Path::new("/usr/bin/chromium"),
            Path::new("/state/browser-profiles/agent1"),
        );
        assert!(config.is_ok(), "{:?}", config.err());
    }

    /// Two sessions sharing a profile is not a tidiness question: Chromium
    /// locks it, so the second engine either fails to start or attaches to the
    /// first and they fight over every page.
    #[test]
    fn two_sessions_never_share_a_profile() {
        let state = Path::new("/state");
        assert_ne!(
            profile_dir(state, "agent1"),
            profile_dir(state, "agent2"),
            "a profile is locked by the engine using it"
        );
        assert_eq!(
            profile_dir(state, "agent1"),
            profile_dir(state, "agent1"),
            "a session has to find the profile it created"
        );
    }

    /// The profile goes under the state dir, not `/tmp`: it reaches a few
    /// hundred MB and `/tmp` is a size-capped tmpfs on some machines.
    #[test]
    fn the_profile_lives_under_the_state_dir() {
        let path = profile_dir(Path::new("/var/lib/tmuxy"), "s");
        assert!(path.starts_with("/var/lib/tmuxy"), "{}", path.display());
    }

    #[test]
    fn nothing_of_the_users_browser_comes_along() {
        let args = engine_args();
        assert!(args.iter().any(|a| a == "--disable-extensions"), "{args:?}");
    }

    /// A modal first-run or default-browser prompt in a profile that has never
    /// been used cannot be clicked away in a headless engine.
    #[test]
    fn the_first_run_prompts_are_suppressed() {
        let args = engine_args();
        for flag in [
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-search-engine-choice-screen",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}: {args:?}");
        }
    }

    /// A container's 64MB `/dev/shm` is exhausted by Chromium on a page of any
    /// size, and the crash looks like a tmuxy bug.
    #[test]
    fn the_container_shared_memory_workaround_is_present() {
        let args = engine_args();
        assert!(
            args.iter().any(|a| a == "--disable-dev-shm-usage"),
            "{args:?}"
        );
    }

    /// The engine should render what it is told to and nothing else: every
    /// background request it makes comes from the server's network position.
    #[test]
    fn background_networking_is_off() {
        let args = engine_args();
        for flag in [
            "--disable-background-networking",
            "--disable-component-update",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}: {args:?}");
        }
    }

    /// Every argument is a flag. A bare word would be read by Chromium as a URL
    /// to open — a page nobody asked for, fetched from the server's network.
    #[test]
    fn nothing_in_the_arguments_is_an_accidental_url() {
        for arg in engine_args() {
            assert!(
                arg.starts_with("--"),
                "{arg:?} is not a flag, so Chromium reads it as a URL to open"
            );
        }
    }
}
