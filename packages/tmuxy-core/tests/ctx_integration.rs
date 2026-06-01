//! Integration test demonstrating `Ctx` with a fully-substituted `MockTmux`,
//! `FakeClock`, and `InMemoryFs`. Asserts that consumer code written against
//! `Arc<Ctx>` can be driven end-to-end without real tmux, real time, or real
//! filesystem access.

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(feature = "test-support")]

use std::time::Duration;
use tmuxy_core::ctx::test_ctx;
use tmuxy_core::{Clock, FileSystem};

/// A small piece of consumer code that takes a `Ctx` and combines all three
/// capabilities. Stand-in for what Phase 4.9b's port of `session.rs::create_or_attach`
/// will look like.
async fn ensure_session_logged(ctx: &tmuxy_core::Ctx, session: &str, log_path: &std::path::Path) {
    let _ = ctx.tmux.run(&["has-session", "-t", session]).await;
    let now = ctx.clock.now();
    let entry = format!("session={} stamp={:?}\n", session, now);
    ctx.fs.write(log_path, entry.as_bytes()).unwrap();
}

#[tokio::test]
async fn ctx_flows_through_full_substitution() {
    let (ctx, tmux, clock, fs) = test_ctx();
    tmux.expect(&["has-session", "-t", "demo"], Ok("".into()));

    let log_path = std::path::Path::new("/tmp/test.log");
    let stamp_before = clock.now();
    ensure_session_logged(&ctx, "demo", log_path).await;

    // The mock recorded exactly one tmux invocation.
    let calls = tmux.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0], vec!["has-session", "-t", "demo"]);

    // The in-memory FS holds the log entry the consumer wrote.
    let log_contents = fs.read_to_string(log_path).unwrap();
    assert!(log_contents.contains("session=demo"));

    // Advance the clock and confirm the consumer's next call observes the
    // new value — proves the clock substitution flows through Arc<Ctx>.
    clock.advance(Duration::from_millis(250));
    let stamp_after = ctx.clock.now();
    let elapsed: Duration = stamp_after.duration_since(stamp_before);
    assert_eq!(elapsed, Duration::from_millis(250));
}
