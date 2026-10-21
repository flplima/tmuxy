//! Shared fixture for the tests that drive a real tmux on a scratch socket.

use std::future::Future;
use std::time::Duration;

/// Run one tmux command against the socket the test picked (`TMUX_SOCKET`)
/// and return what it printed. This is test scaffolding — setting the scene
/// before the monitor attaches, and tearing the server down after it has
/// detached — never something the crate itself does while a control-mode
/// client is attached.
pub fn tmux(args: &[&str]) -> Result<String, tmuxy_core::TmuxError> {
    let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    tmuxy_core::session::tmux_output(&argv)
}

/// Poll `check` until it holds, or fail once `within` has passed. The
/// duration is a ceiling, never a wait: a test that slept a fixed time
/// instead failed on a slow runner and spent the whole time on a fast one.
#[allow(dead_code)]
pub async fn wait_until<F, Fut>(what: &str, within: Duration, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + within;
    while !check().await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
