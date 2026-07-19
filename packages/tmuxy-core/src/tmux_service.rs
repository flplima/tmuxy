//! Tower-style middleware composition for tmux command invocations.
//!
//! Wraps the `TmuxCommand` trait in a `tower::Service` so retry,
//! timeout, and tracing are all composed via `ServiceBuilder` rather than
//! hand-rolled inside each call site. The single composition point makes
//! "every tmux call gets a 1-second timeout" a one-line change.
//!
//! The service is built on top of `Ctx::tmux` so the test substitution
//! (`MockTmux`) still flows through — middleware composes around
//! the trait object, it doesn't replace it.

use crate::ctx::TmuxCommand;
use crate::error::TmuxError;
use crate::retry::RetryPolicy;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tower::{Service, ServiceBuilder, ServiceExt};
use tracing::{trace, Instrument};

/// Default per-call deadline for `Ctx::tmux_call`. Five seconds covers every
/// observed tmux roundtrip on the supported targets while keeping a wedged
/// `display-message` from hanging the UI's command queue indefinitely.
pub const TMUX_CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// Request type carried through the tower stack.
#[derive(Debug, Clone)]
pub struct TmuxRequest {
    pub args: Vec<String>,
    /// Human-readable description for logs / spans.
    /// Defaults to `args[0]` if unset.
    pub op_name: Option<String>,
}

impl TmuxRequest {
    pub fn with_name(args: Vec<String>, name: impl Into<String>) -> Self {
        Self {
            args,
            op_name: Some(name.into()),
        }
    }

    pub fn op_name(&self) -> &str {
        self.op_name
            .as_deref()
            .or_else(|| self.args.first().map(String::as_str))
            .unwrap_or("(unknown)")
    }
}

/// Adapter that lifts a `TmuxCommand` trait object into a `tower::Service`.
/// One instance per call site; cloned cheaply via the inner `Arc`.
#[derive(Clone)]
pub struct TmuxService {
    inner: Arc<dyn TmuxCommand>,
}

impl TmuxService {
    pub fn new(inner: Arc<dyn TmuxCommand>) -> Self {
        Self { inner }
    }
}

impl Service<TmuxRequest> for TmuxService {
    type Response = String;
    type Error = TmuxError;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, TmuxError>> + Send + 'static>,
    >;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: TmuxRequest) -> Self::Future {
        let inner = self.inner.clone();
        Box::pin(async move {
            let refs: Vec<&str> = req.args.iter().map(String::as_str).collect();
            inner.run(&refs).await
        })
    }
}

/// Build the standard middleware stack: tracing → retry → timeout → service.
///
/// Order matters. With `ServiceBuilder` the layer added FIRST becomes the
/// outermost wrap, so the chain from outer to inner is:
///
///   `TraceLayer` → `RetryLayer` → `TimeoutLayer` → `TmuxService`
///
/// Why this order:
///   - Trace at the outside: one span per *outer* call, attached to every
///     downstream emit regardless of how many retries fire.
///   - Retry next: each retry attempt creates a fresh call to the inner
///     timeout-wrapped service, so each attempt has its own deadline.
///   - Timeout closest to the service: an attempt that exceeds the deadline
///     surfaces as `TmuxError::Timeout`, which `is_retryable()` returns true
///     for — the retry layer picks it back up.
pub fn build_tmux_stack(
    ctx_tmux: Arc<dyn TmuxCommand>,
    per_call_timeout: Duration,
    retry_policy: RetryPolicy,
) -> impl Service<
    TmuxRequest,
    Response = String,
    Error = TmuxError,
    Future = impl std::future::Future<Output = Result<String, TmuxError>> + Send,
> + Clone {
    let inner = TmuxService::new(ctx_tmux);
    ServiceBuilder::new()
        .layer_fn(TraceLayer::new)
        .layer_fn(move |s| RetryLayer::new(s, retry_policy))
        .layer_fn(move |s| TimeoutLayer::new(s, per_call_timeout))
        .service(inner)
}

// =============================================================================
// Custom layers
//
// Tower ships generic timeout/retry layers but they assume `tower::Service`
// errors implement `From<Elapsed>` (timeout) and have a `Policy` impl (retry).
// Our `TmuxError` doesn't, so we ship narrow layers that convert into the
// typed error variants directly.
// =============================================================================

/// Wraps an inner service with `tokio::time::timeout`. Timeouts surface as
/// `TmuxError::Timeout { operation, after }` so the retry layer can decide
/// whether to back off.
#[derive(Clone)]
pub struct TimeoutLayer<S> {
    inner: S,
    duration: Duration,
}

impl<S> TimeoutLayer<S> {
    pub fn new(inner: S, duration: Duration) -> Self {
        Self { inner, duration }
    }
}

impl<S> Service<TmuxRequest> for TimeoutLayer<S>
where
    S: Service<TmuxRequest, Response = String, Error = TmuxError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = String;
    type Error = TmuxError;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, TmuxError>> + Send + 'static>,
    >;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: TmuxRequest) -> Self::Future {
        let op_name = req.op_name().to_string();
        let duration = self.duration;
        let mut inner = self.inner.clone();
        Box::pin(async move {
            match tokio::time::timeout(duration, inner.call(req)).await {
                Ok(r) => r,
                Err(_) => Err(TmuxError::Timeout {
                    operation: op_name,
                    after: duration,
                }),
            }
        })
    }
}

/// Retry layer driven by `RetryPolicy`. Reuses `retry::retry_with` for the
/// backoff math; this layer is a thin adapter around it.
#[derive(Clone)]
pub struct RetryLayer<S> {
    inner: S,
    policy: RetryPolicy,
}

impl<S> RetryLayer<S> {
    pub fn new(inner: S, policy: RetryPolicy) -> Self {
        Self { inner, policy }
    }
}

impl<S> Service<TmuxRequest> for RetryLayer<S>
where
    S: Service<TmuxRequest, Response = String, Error = TmuxError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = String;
    type Error = TmuxError;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, TmuxError>> + Send + 'static>,
    >;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: TmuxRequest) -> Self::Future {
        let inner = self.inner.clone();
        let policy = self.policy;
        Box::pin(async move {
            crate::retry::retry_with(policy, move || {
                let req = req.clone();
                let mut inner = inner.clone();
                async move { inner.ready().await?.call(req).await }
            })
            .await
        })
    }
}

/// Emits a tracing span around each call. Single point of instrumentation so
/// inline `#[instrument]` on individual fns is no longer needed; the span
/// fields (`op`, `args_count`) attach to every inner emit.
#[derive(Clone)]
pub struct TraceLayer<S> {
    inner: S,
}

impl<S> TraceLayer<S> {
    pub fn new(inner: S) -> Self {
        Self { inner }
    }
}

impl<S> Service<TmuxRequest> for TraceLayer<S>
where
    S: Service<TmuxRequest, Response = String, Error = TmuxError> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = String;
    type Error = TmuxError;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, TmuxError>> + Send + 'static>,
    >;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: TmuxRequest) -> Self::Future {
        // Build the span manually and attach it to the FUTURE. `#[instrument]`
        // on this fn would only cover future *construction* — it would open and
        // close before the dispatch, timeout and retries ever ran, so none of
        // the inner emits would carry these fields.
        let span = tracing::info_span!("tmux_call", op = req.op_name(), argc = req.args.len());
        let mut inner = self.inner.clone();
        Box::pin(
            async move {
                trace!("dispatching tmux service request");
                inner.call(req).await
            }
            .instrument(span),
        )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::ctx::MockTmux;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn stack_calls_inner_once_on_success() {
        let mock = Arc::new(MockTmux::new());
        mock.expect(&["display-message", "-p", "x"], Ok("ok".into()));
        let mut svc = build_tmux_stack(
            mock.clone(),
            Duration::from_millis(500),
            RetryPolicy::standard(),
        );
        let out = svc
            .ready()
            .await
            .unwrap()
            .call(TmuxRequest::with_name(
                vec!["display-message".into(), "-p".into(), "x".into()],
                "display-message",
            ))
            .await
            .unwrap();
        assert_eq!(out, "ok");
        assert_eq!(mock.calls().len(), 1);
    }

    #[tokio::test]
    async fn timeout_layer_converts_slow_call_to_typed_timeout() {
        struct SlowMock {
            count: AtomicU32,
        }
        #[async_trait::async_trait]
        impl TmuxCommand for SlowMock {
            async fn run(&self, _args: &[&str]) -> Result<String, TmuxError> {
                self.count.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(10)).await;
                Ok("never".into())
            }
        }
        let mock = Arc::new(SlowMock {
            count: AtomicU32::new(0),
        });
        let mut svc = build_tmux_stack(
            mock,
            Duration::from_millis(20),
            // No retries so the test resolves quickly — a single attempt times
            // out into TmuxError::Timeout, the outer retry policy sees it,
            // and with max_attempts=1 surfaces it.
            RetryPolicy::none(),
        );
        let err = svc
            .ready()
            .await
            .unwrap()
            .call(TmuxRequest::with_name(vec!["sleep".into()], "sleep-op"))
            .await
            .unwrap_err();
        match err {
            TmuxError::Timeout {
                ref operation,
                after,
            } => {
                assert_eq!(operation, "sleep-op");
                assert_eq!(after, Duration::from_millis(20));
            }
            other => panic!("expected Timeout, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn retry_layer_re_runs_on_timeout() {
        // Slow on the first 2 calls; fast on the third.
        struct FlakyMock {
            count: AtomicU32,
        }
        #[async_trait::async_trait]
        impl TmuxCommand for FlakyMock {
            async fn run(&self, _args: &[&str]) -> Result<String, TmuxError> {
                let n = self.count.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    Ok("never".into())
                } else {
                    Ok("ok".into())
                }
            }
        }
        let mock = Arc::new(FlakyMock {
            count: AtomicU32::new(0),
        });
        let mut svc = build_tmux_stack(
            mock.clone(),
            Duration::from_millis(20),
            RetryPolicy::standard(),
        );
        let out = svc
            .ready()
            .await
            .unwrap()
            .call(TmuxRequest::with_name(vec!["op".into()], "op"))
            .await
            .unwrap();
        assert_eq!(out, "ok");
        assert_eq!(mock.count.load(Ordering::SeqCst), 3);
    }
}
