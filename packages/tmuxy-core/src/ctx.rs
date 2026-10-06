//! Execution context for the monitor.
//!
//! `Ctx` carries the capabilities the monitor would otherwise read straight
//! from `std::time`, each behind a trait object so a test can substitute its
//! own. Every tmux command goes over the monitor's control-mode connection,
//! so there is no tmux capability here.

use std::sync::Arc;
use std::time::Instant;

/// Monotonic-time capability: the settling and throttling deadlines in the
/// monitor loop are computed from this rather than from `Instant::now()`.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// The execution context threaded into `TmuxMonitor::connect`. Held behind
/// `Arc` so a reconnecting loop can hand the same one to every attempt.
pub struct Ctx {
    pub clock: Arc<dyn Clock>,
}

impl Ctx {
    /// The production context: the system clock.
    pub fn live() -> Arc<Self> {
        Arc::new(Self {
            clock: Arc::new(LiveClock),
        })
    }
}

/// Production clock — wraps `std::time::Instant::now()`.
struct LiveClock;

impl Clock for LiveClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}
