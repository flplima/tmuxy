//! Shared fixture for the tests that drive a real tmux on a scratch socket.

/// Run one tmux command against the socket the test picked (`TMUX_SOCKET`)
/// and return what it printed. This is test scaffolding — setting the scene
/// before the monitor attaches, and tearing the server down after it has
/// detached — never something the crate itself does while a control-mode
/// client is attached.
pub fn tmux(args: &[&str]) -> Result<String, String> {
    let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    tmuxy_core::session::tmux_output(&argv)
}
