//! Launching the engine, and the arguments that decide what it is allowed to be.
//!
//! The flags here are the security posture in executable form: the throwaway
//! profile, the pipe instead of a port, headless, no extensions. Each one is
//! load-bearing and the reasoning is in `docs/SECURITY.md` ("A Server-Side
//! Browser Changes Whose Network This Is") — this module is where it is applied,
//! so the comments say which property each flag is buying rather than restating
//! the section.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The command line for an engine serving one tmuxy browser session.
///
/// Built as data rather than assembled at the call site so it can be asserted
/// on: these flags are a security boundary, and a flag quietly lost in a
/// refactor is the kind of regression that leaves the feature working.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

/// Where a session's throwaway profile lives.
///
/// Under the state dir rather than a temp dir: a profile is up to a few hundred
/// MB, and `/tmp` on some machines is a tmpfs sized for much less. Named by
/// session so two sessions cannot share one — Chromium locks a profile, and the
/// second engine would fail to start or, worse, attach to the first.
pub fn profile_dir(state_dir: &Path, session: &str) -> PathBuf {
    state_dir.join("browser-profiles").join(session)
}

/// Assemble the command line for one session's engine.
pub fn engine_command(browser: &Path, profile: &Path) -> EngineCommand {
    let args: Vec<OsString> = vec![
        // The whole reason this module does not use a CDP client library.
        // A port is discoverable by anything on the machine and authenticates
        // nobody; this speaks over inherited fds 3 and 4 and opens no socket.
        // Chrome 136+ also refuses remote debugging against the DEFAULT
        // profile, so the flag below is not merely good hygiene — without it
        // this flag is ignored and the engine comes up undriveable.
        "--remote-debugging-pipe".into(),
        // A profile of this session's own, removed when the session ends. No
        // cookie, token or logged-in account from the user's real browsing is
        // reachable from a page tmuxy opens, and nothing a page stores outlives
        // the session.
        {
            let mut flag = OsString::from("--user-data-dir=");
            flag.push(profile);
            flag
        },
        // There is no display on the machine this is most useful on — a server
        // reached over SSH — and a window nobody can see is worse than none.
        "--headless=new".into(),
        // Nothing of the user's browser comes along: no extension can see the
        // pages tmuxy opens, and no extension's own permissions apply.
        "--disable-extensions".into(),
        // The first-run flow, the default-browser prompt and the sign-in
        // promos are all modal in a profile that has never been used, and a
        // headless engine cannot be clicked out of them.
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-search-engine-choice-screen".into(),
        // Nothing here should phone home: this engine exists to render the
        // pages it is told to, and a background request is both noise in the
        // trace and a request from the server's network position.
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-domain-reliability".into(),
        "--metrics-recording-only".into(),
        "--no-pings".into(),
        // A crash dialog in a headless process is a hang.
        "--disable-crash-reporter".into(),
        // Chromium's own default when it cannot find a usable GPU, but stated:
        // a server has no GPU and the fallback probe costs a second of startup.
        "--disable-gpu".into(),
        // `/dev/shm` is 64MB in a default Docker container, which Chromium
        // exhausts and then crashes on a page of any size. The devcontainer and
        // the CI runner are both affected; the E2E harness passes the same flag
        // (`tests/helpers/browser.js`).
        "--disable-dev-shm-usage".into(),
        // A window size, because headless defaults to 800x600 and a page
        // rendered at that width is not the page anyone is looking at. The real
        // viewport is set per-session over CDP once the pane's size is known;
        // this is only what the first paint happens at.
        "--window-size=1280,800".into(),
        // about:blank, so the engine comes up with a page attached and nothing
        // loaded. Without a URL some builds open the new-tab page, which makes
        // a network request before anyone has asked for one.
        "about:blank".into(),
    ];

    EngineCommand {
        program: browser.to_path_buf(),
        args,
    }
}

#[cfg(test)]
// A test's `expect` IS its assertion: the panic message is the failure report.
// CI does not lint test code (docs/TESTS.md, Known Gaps); this is for whoever
// runs clippy with --tests.
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn command() -> EngineCommand {
        engine_command(
            Path::new("/usr/bin/chromium"),
            Path::new("/state/browser-profiles/agent1"),
        )
    }

    fn args_as_strings(cmd: &EngineCommand) -> Vec<String> {
        cmd.args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    /// The flag that decides whether CDP is reachable by anything else on the
    /// machine. Losing it in a refactor would leave the feature working and the
    /// boundary gone, which is why it is asserted rather than trusted.
    #[test]
    fn the_engine_speaks_over_a_pipe_and_never_opens_a_port() {
        let args = args_as_strings(&command());
        assert!(
            args.iter().any(|a| a == "--remote-debugging-pipe"),
            "the pipe transport is the security boundary; see docs/SECURITY.md"
        );
        assert!(
            !args
                .iter()
                .any(|a| a.starts_with("--remote-debugging-port")),
            "a debugging PORT authenticates nobody and is discoverable: {args:?}"
        );
        assert!(
            !args.iter().any(|a| a.contains("9222")),
            "9222 is the number every scanner and every other tool already tries"
        );
    }

    /// Chrome 136+ ignores remote debugging against the default profile, so
    /// this flag is what makes the pipe work at all — and it is also what keeps
    /// the user's real cookies out of reach.
    #[test]
    fn the_profile_is_the_sessions_own() {
        let args = args_as_strings(&command());
        assert!(
            args.iter()
                .any(|a| a == "--user-data-dir=/state/browser-profiles/agent1"),
            "{args:?}"
        );
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
    fn the_engine_runs_headless_with_no_extensions() {
        let args = args_as_strings(&command());
        assert!(args.iter().any(|a| a.starts_with("--headless")), "{args:?}");
        assert!(args.iter().any(|a| a == "--disable-extensions"), "{args:?}");
    }

    /// A modal first-run or default-browser prompt in a profile that has never
    /// been used cannot be clicked away in a headless engine.
    #[test]
    fn the_first_run_prompts_are_suppressed() {
        let args = args_as_strings(&command());
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
        let args = args_as_strings(&command());
        assert!(
            args.iter().any(|a| a == "--disable-dev-shm-usage"),
            "{args:?}"
        );
    }

    /// The engine should render what it is told to and nothing else: every
    /// background request it makes comes from the server's network position.
    #[test]
    fn background_networking_is_off() {
        let args = args_as_strings(&command());
        for flag in [
            "--disable-background-networking",
            "--disable-component-update",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}: {args:?}");
        }
    }

    /// A bare engine opens the new-tab page on some builds, which is a network
    /// request before anyone has asked for one.
    #[test]
    fn it_starts_on_a_blank_page_rather_than_the_new_tab_page() {
        let cmd = command();
        let args = args_as_strings(&cmd);
        assert_eq!(
            args.last().map(String::as_str),
            Some("about:blank"),
            "{args:?}"
        );
        assert_eq!(cmd.program, PathBuf::from("/usr/bin/chromium"));
    }

    /// Every argument must be a flag or the trailing URL. A bare word would be
    /// read by Chromium as another URL to open.
    #[test]
    fn nothing_in_the_command_line_is_an_accidental_url() {
        let args = args_as_strings(&command());
        let (url, flags) = args.split_last().expect("at least one argument");
        assert_eq!(url, "about:blank");
        for flag in flags {
            assert!(
                flag.starts_with("--"),
                "{flag:?} is not a flag, so Chromium reads it as a URL to open"
            );
        }
    }
}
