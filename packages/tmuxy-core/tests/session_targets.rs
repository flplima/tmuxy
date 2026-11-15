//! A session name is a whole name, against a real tmux on a scratch socket:
//! tmux resolves a bare `-t work` to `workbench` when that is the only
//! session it is a prefix of, so asking whether `work` exists, attaching to
//! it and grouping with it must each target the name exactly. Its own
//! binary, since the socket is process-wide.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use tmuxy_core::control_mode::ControlModeConnection;
use tmuxy_core::session::{session_exists, session_known, SessionName};
use tmuxy_core::TmuxError;

mod common;

#[tokio::test]
async fn a_session_is_found_by_its_whole_name_never_by_a_prefix() {
    let server = common::ScratchServer::process_wide("session-targets");
    server.tmux(&["-f", "/dev/null", "new-session", "-d", "-s", "workbench"]);
    // tmux itself matches the prefix: the case the targets have to rule out.
    server.tmux(&["has-session", "-t", "work"]);

    let work = SessionName::parse("work").unwrap();
    assert!(!session_exists(&work).unwrap(), "`work` read as existing");
    assert!(!session_known("work"));
    assert!(session_known("workbench"));

    let attach = ControlModeConnection::connect("work", None, None, false, None, None).await;
    assert!(
        matches!(attach, Err(TmuxError::SessionNotFound { ref name }) if name.starts_with("work (")),
        "attaching to `work` did not fail as a missing session: {:?}",
        attach.as_ref().err()
    );

    // A session that joins `workbench`'s group shares its windows.
    let joined =
        ControlModeConnection::connect("workbench~2", None, None, true, Some("workbench"), None)
            .await
            .expect("a session grouped with `workbench`");
    drop(joined);
    let grouped = server.tmux(&["list-sessions", "-F", "#{session_name} #{session_group}"]);
    assert!(
        grouped.lines().any(|l| l == "workbench~2 workbench"),
        "{grouped}"
    );
}

/// The targets the UI's kill-session and rename-session ops spell (`=name`):
/// with `work` gone, a bare `-t work` would take `work-2`, the one session
/// it is a prefix of.
#[test]
fn kill_and_rename_by_exact_name_leave_the_session_it_prefixes() {
    let server = common::ScratchServer::new("exact-ops");
    server.tmux(&["-f", "/dev/null", "new-session", "-d", "-s", "work"]);
    server.tmux(&["new-session", "-d", "-s", "work-2"]);
    let names = || server.tmux(&["list-sessions", "-F", "#{session_name}"]);

    server.tmux(&["rename-session", "-t", "=work", "--", "play"]);
    assert_eq!(names().lines().collect::<Vec<_>>(), ["play", "work-2"]);

    server.tmux(&["kill-session", "-t", "=play"]);
    assert_eq!(names(), "work-2");

    // The exact form of a missing name fails, where the bare one would hit `work-2`.
    let gone = tmuxy_core::session::local_tmux_on(&server.socket)
        .args(["kill-session", "-t", "=work"])
        .output()
        .expect("tmux runs");
    assert!(!gone.status.success());
    assert_eq!(names(), "work-2");
}
