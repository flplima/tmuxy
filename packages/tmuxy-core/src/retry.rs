//! Retry policy as data.
//!
//! Effect.ts-style "policy as data" for retry-eligible operations. Retries
//! apply only to dispatch through `Ctx::tmux_call` (the tower stack in
//! `tmux_service.rs`) — the sync executor helpers don't route through this
//! module. Each call site declares the intent — "this is a transient query
//! that's safe to retry" — and the policy decides how many attempts, what
//! backoff, and whether jitter applies.
//!
//! **Not** for control-mode command sends (`ControlModeConnection` and
//! friends). Those are once-only: a retry would race the original response. The is_retryable() classifier on
//! `TmuxError` keeps the distinction explicit — `ControlMode` errors aren't
//! marked retryable by default.

use crate::error::TmuxError;
use backon::{ExponentialBuilder, Retryable};
use std::future::Future;
use std::time::Duration;

/// A retry policy parameterised at the call site. Built from `RetryPolicy`
/// rather than hand-rolling per-call `for` loops.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub jitter: bool,
}

impl RetryPolicy {
    /// Standard policy for query-style tmux helpers (`has-session`, `list-panes`,
    /// `display-message`). Three attempts, exponential backoff from 50ms to
    /// 500ms, with jitter so two clients reconnecting together don't sync up.
    pub const fn standard() -> Self {
        Self {
            max_attempts: 3,
            initial_backoff: Duration::from_millis(50),
            max_backoff: Duration::from_millis(500),
            jitter: true,
        }
    }

    /// Disable retries entirely. Useful in tests so a synthetic failure isn't
    /// silently masked by retry logic.
    pub const fn none() -> Self {
        Self {
            max_attempts: 1,
            initial_backoff: Duration::from_millis(0),
            max_backoff: Duration::from_millis(0),
            jitter: false,
        }
    }

    /// Build the `backon::ExponentialBuilder` this policy describes. Kept
    /// internal so call sites consume the higher-level `retry_with`.
    fn into_builder(self) -> ExponentialBuilder {
        let mut b = ExponentialBuilder::default()
            .with_min_delay(self.initial_backoff)
            .with_max_delay(self.max_backoff)
            .with_max_times(self.max_attempts.saturating_sub(1) as usize);
        if self.jitter {
            b = b.with_jitter();
        }
        b
    }
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::standard()
    }
}

/// Run `op` with the supplied policy. Only retries when the returned error is
/// `TmuxError::is_retryable()` — so a `SessionNotFound` won't waste a
/// retry budget.
pub async fn retry_with<F, Fut, T>(policy: RetryPolicy, op: F) -> Result<T, TmuxError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, TmuxError>>,
{
    op.retry(policy.into_builder())
        .when(|e: &TmuxError| e.is_retryable())
        .await
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn retries_until_success() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let result: Result<u32, TmuxError> = retry_with(RetryPolicy::standard(), move || {
            let calls = calls_c.clone();
            async move {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if n < 3 {
                    Err(TmuxError::Timeout {
                        operation: "test".into(),
                        after: Duration::from_millis(1),
                    })
                } else {
                    Ok(42)
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn non_retryable_errors_bypass_retry() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let result: Result<u32, TmuxError> = retry_with(RetryPolicy::standard(), move || {
            let calls = calls_c.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(TmuxError::SessionNotFound { name: "foo".into() })
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn none_policy_runs_exactly_once() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let result: Result<u32, TmuxError> = retry_with(RetryPolicy::none(), move || {
            let calls = calls_c.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(TmuxError::Timeout {
                    operation: "test".into(),
                    after: Duration::from_millis(1),
                })
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
