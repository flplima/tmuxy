//! Execution context with swappable backends.
//!
//! `Ctx` bundles the small set of capabilities that previously read
//! straight from `std::process`, `std::time`, and `std::fs`. Each capability
//! is a trait object so tests can substitute a fake without touching the
//! real tmux server, the system clock, or the filesystem.
//!
//! This is the seed for Phase 4.9's broader migration — initially the
//! production code path keeps using `executor::*` and `Instant::now()`
//! directly, with `Ctx` exposed for new code (and the test substitutes that
//! will arrive in Phases 4.9b / 5.7's retry middleware).
//!
//! The traits are intentionally narrow: each method maps to exactly one I/O
//! operation, so a `MockTmux` can record argv-by-argv and return canned
//! outputs without reproducing tmux's grammar.

use crate::error::TmuxError;
use crate::retry::RetryPolicy;
use std::sync::Arc;
use std::time::Instant;

/// Run-arbitrary-tmux-command capability.
///
/// `args` is the same flat argv the production `executor::execute_tmux_command`
/// uses, so call sites can swap to `ctx.tmux.run(&[...]).await` without
/// reshaping their tmux invocation.
#[async_trait::async_trait]
pub trait TmuxCommand: Send + Sync {
    async fn run(&self, args: &[&str]) -> Result<String, TmuxError>;
}

/// Monotonic-time capability. Tests use a `FakeClock` to step time
/// deterministically without actually sleeping.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// Minimal filesystem capability — just enough for `session.rs` config I/O.
/// Tests use `InMemoryFs` so config-touch behaviour can be asserted without
/// writing to disk.
pub trait FileSystem: Send + Sync {
    fn read_to_string(&self, path: &std::path::Path) -> Result<String, std::io::Error>;
    fn write(&self, path: &std::path::Path, content: &[u8]) -> Result<(), std::io::Error>;
    fn exists(&self, path: &std::path::Path) -> bool;
    fn create_dir_all(&self, path: &std::path::Path) -> Result<(), std::io::Error>;
}

/// The execution context threaded through the codebase.
///
/// Held behind `Arc` so background tasks can clone cheap handles. The
/// `retry_policy` lives here too so tests can swap in
/// `RetryPolicy::none()` per-call without rebuilding the entire context.
pub struct Ctx {
    pub tmux: Arc<dyn TmuxCommand>,
    pub clock: Arc<dyn Clock>,
    pub fs: Arc<dyn FileSystem>,
    pub retry_policy: RetryPolicy,
}

impl Ctx {
    /// Build a production context using the real tmux binary, system clock,
    /// and on-disk filesystem.
    pub fn live() -> Arc<Self> {
        Arc::new(Self {
            tmux: Arc::new(LiveTmux),
            clock: Arc::new(LiveClock),
            fs: Arc::new(LiveFs),
            retry_policy: RetryPolicy::standard(),
        })
    }

    /// Canonical async tmux dispatch through the standard Tower stack
    /// (`TraceLayer → RetryLayer → TimeoutLayer → TmuxService`). Used by every
    /// async caller — server SSE handlers and Tauri commands alike — so the
    /// resilience floor (retry on transient io, 5s per-call deadline, tracing
    /// span) is identical regardless of frontend.
    ///
    /// Sync `executor::*` helpers continue to call tmux directly because they
    /// cannot await; this method is for async paths only.
    pub async fn tmux_call(&self, args: Vec<String>, op_name: &str) -> Result<String, TmuxError> {
        self.tmux_call_with_policy(args, op_name, self.retry_policy)
            .await
    }

    /// Same as `tmux_call` but with a caller-chosen retry policy. The
    /// scrollback-fetch path uses this to keep its dedicated standard policy
    /// even if a future `Ctx::live()` swaps in a different default.
    pub async fn tmux_call_with_policy(
        &self,
        args: Vec<String>,
        op_name: &str,
        policy: RetryPolicy,
    ) -> Result<String, TmuxError> {
        use tower::{Service, ServiceExt};
        let mut svc = crate::tmux_service::build_tmux_stack(
            self.tmux.clone(),
            crate::tmux_service::TMUX_CALL_TIMEOUT,
            policy,
        );
        svc.ready()
            .await?
            .call(crate::tmux_service::TmuxRequest::with_name(args, op_name))
            .await
    }
}

// =============================================================================
// Live (production) backends
// =============================================================================

/// Production tmux backend — delegates to the existing
/// `executor::execute_tmux_command`. Wrapped in `spawn_blocking` so the
/// async-trait future doesn't park on a blocking subprocess wait.
struct LiveTmux;

#[async_trait::async_trait]
impl TmuxCommand for LiveTmux {
    async fn run(&self, args: &[&str]) -> Result<String, TmuxError> {
        // Materialise into owned strings so the spawn_blocking closure can
        // capture them — &str doesn't live long enough across the boundary.
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        tokio::task::spawn_blocking(move || {
            let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
            crate::executor::execute_tmux_command(&refs)
        })
        .await
        .map_err(|e| TmuxError::other(format!("spawn_blocking failure: {}", e)))?
    }
}

/// Production clock — wraps `std::time::Instant::now()`.
struct LiveClock;

impl Clock for LiveClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Production filesystem — wraps `std::fs`.
struct LiveFs;

impl FileSystem for LiveFs {
    fn read_to_string(&self, path: &std::path::Path) -> Result<String, std::io::Error> {
        std::fs::read_to_string(path)
    }

    fn write(&self, path: &std::path::Path, content: &[u8]) -> Result<(), std::io::Error> {
        std::fs::write(path, content)
    }

    fn exists(&self, path: &std::path::Path) -> bool {
        path.exists()
    }

    fn create_dir_all(&self, path: &std::path::Path) -> Result<(), std::io::Error> {
        std::fs::create_dir_all(path)
    }
}

// =============================================================================
// Test backends
//
// Each `Mutex::lock().unwrap()` below is on a brand-new test-only mutex that
// can only be poisoned by a panic *inside this module*; the failure mode is
// "the test already panicked", so the `unwrap` doesn't add risk.
// =============================================================================

/// Fake tmux backend that records every invocation and returns canned outputs
/// per argv. Tests configure expectations up front; unmatched argvs return a
/// `TmuxError::other` with the literal argv so failures are diagnosable
/// without a debugger.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
pub struct MockTmux {
    pub calls: std::sync::Mutex<Vec<Vec<String>>>,
    /// Responses are stored as `Result<String, String>` because `TmuxError`
    /// is `!Clone`; the test-side converts back to `TmuxError` via the
    /// existing `From<String>` bridge when the mock fires.
    pub responses: std::sync::Mutex<std::collections::HashMap<Vec<String>, Result<String, String>>>,
}

#[cfg(any(test, feature = "test-support"))]
#[allow(clippy::unwrap_used)]
impl MockTmux {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a canned response for an exact argv match.
    pub fn expect(&self, args: &[&str], response: Result<String, String>) {
        let key: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        self.responses.lock().unwrap().insert(key, response);
    }

    /// Snapshot the recorded argvs (oldest first).
    pub fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
}

#[cfg(any(test, feature = "test-support"))]
#[allow(clippy::unwrap_used)]
#[async_trait::async_trait]
impl TmuxCommand for MockTmux {
    async fn run(&self, args: &[&str]) -> Result<String, TmuxError> {
        let key: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        self.calls.lock().unwrap().push(key.clone());
        match self.responses.lock().unwrap().get(&key).cloned() {
            Some(Ok(s)) => Ok(s),
            Some(Err(msg)) => Err(TmuxError::other(msg)),
            None => Err(TmuxError::other(format!(
                "no MockTmux response for {:?}",
                args
            ))),
        }
    }
}

/// Manually-advanced clock. Initialise with a base `Instant` and step it
/// with `advance(Duration)` between assertions.
#[cfg(any(test, feature = "test-support"))]
pub struct FakeClock {
    inner: std::sync::Mutex<Instant>,
}

#[cfg(any(test, feature = "test-support"))]
#[allow(clippy::unwrap_used)]
impl FakeClock {
    pub fn new(base: Instant) -> Self {
        Self {
            inner: std::sync::Mutex::new(base),
        }
    }

    pub fn advance(&self, by: std::time::Duration) {
        let mut g = self.inner.lock().unwrap();
        *g += by;
    }
}

#[cfg(any(test, feature = "test-support"))]
#[allow(clippy::unwrap_used)]
impl Clock for FakeClock {
    fn now(&self) -> Instant {
        *self.inner.lock().unwrap()
    }
}

/// In-memory filesystem stub. Stores written bytes; reads return them back.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
pub struct InMemoryFs {
    pub files: std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Vec<u8>>>,
}

#[cfg(any(test, feature = "test-support"))]
#[allow(clippy::unwrap_used)]
impl FileSystem for InMemoryFs {
    fn read_to_string(&self, path: &std::path::Path) -> Result<String, std::io::Error> {
        match self.files.lock().unwrap().get(path) {
            Some(bytes) => String::from_utf8(bytes.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("InMemoryFs: no entry for {:?}", path),
            )),
        }
    }

    fn write(&self, path: &std::path::Path, content: &[u8]) -> Result<(), std::io::Error> {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), content.to_vec());
        Ok(())
    }

    fn exists(&self, path: &std::path::Path) -> bool {
        self.files.lock().unwrap().contains_key(path)
    }

    fn create_dir_all(&self, _path: &std::path::Path) -> Result<(), std::io::Error> {
        // In-memory FS doesn't model directories separately — the file map
        // is keyed by full path. create_dir_all is a no-op here.
        Ok(())
    }
}

/// Build a fully-substituted `Ctx` for tests. Defaults to retry-disabled so a
/// test asserting failure doesn't get masked.
#[cfg(any(test, feature = "test-support"))]
pub fn test_ctx() -> (Arc<Ctx>, Arc<MockTmux>, Arc<FakeClock>, Arc<InMemoryFs>) {
    let tmux = Arc::new(MockTmux::new());
    let clock = Arc::new(FakeClock::new(Instant::now()));
    let fs = Arc::new(InMemoryFs::default());
    let ctx = Arc::new(Ctx {
        tmux: tmux.clone(),
        clock: clock.clone(),
        fs: fs.clone(),
        retry_policy: RetryPolicy::none(),
    });
    (ctx, tmux, clock, fs)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn mock_tmux_returns_canned_response() {
        let (ctx, tmux, _, _) = test_ctx();
        tmux.expect(&["has-session", "-t", "foo"], Ok("".into()));
        let out = ctx.tmux.run(&["has-session", "-t", "foo"]).await.unwrap();
        assert_eq!(out, "");
        assert_eq!(tmux.calls()[0], vec!["has-session", "-t", "foo"]);
    }

    #[tokio::test]
    async fn mock_tmux_unexpected_argv_errors() {
        let (ctx, _, _, _) = test_ctx();
        let err = ctx.tmux.run(&["list-sessions"]).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("list-sessions"));
    }

    #[test]
    fn fake_clock_advances_deterministically() {
        let base = Instant::now();
        let clock = FakeClock::new(base);
        assert_eq!(clock.now(), base);
        clock.advance(Duration::from_millis(250));
        assert_eq!(clock.now() - base, Duration::from_millis(250));
    }

    #[test]
    fn in_memory_fs_round_trip() {
        let fs = InMemoryFs::default();
        let path = std::path::Path::new("/tmp/test.conf");
        assert!(!fs.exists(path));
        fs.write(path, b"hello").unwrap();
        assert!(fs.exists(path));
        assert_eq!(fs.read_to_string(path).unwrap(), "hello");
    }
}
