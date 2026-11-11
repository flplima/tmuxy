//! One connection's commands, run in the order the client issued them.
//!
//! The web client pipelines its `POST /commands`: it sends the next without
//! waiting for the previous answer, so a key costs one round trip however
//! fast the user types. Each POST is its own task here, and over several
//! HTTP connections two can arrive reversed. The client stamps each with
//! `X-Command-Seq` (1, 2, 3… per connection id), and a request waits at its
//! connection's [`CommandGate`] until every lower number has been handed to
//! tmux (S7 in `docs/INVARIANTS.md`).

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;

/// How long the gate waits for a number that has not arrived before the
/// lowest one waiting goes ahead. A request whose connection had to be
/// opened first, or that lost a packet, trails its successors by a few round
/// trips; one that never left the client must not hold the keyboard for good.
pub(super) const LOST_SEQ_TIMEOUT: Duration = Duration::from_secs(5);

/// Past this many waiting requests a connection is refused more: each holds
/// a parsed command of up to `COMMANDS_MAX_BYTES`.
pub(super) const MAX_WAITING: usize = 256;

#[derive(Debug)]
struct State {
    /// The lowest number not yet run.
    next: u64,
    running: bool,
    /// Since when nothing has run.
    idle_since: Instant,
    waiting: BTreeSet<u64>,
}

#[derive(Debug)]
pub struct CommandGate {
    state: Mutex<State>,
    changed: Notify,
}

/// The gate is full: the client sent more out-of-turn requests than
/// [`MAX_WAITING`].
#[derive(Debug)]
pub(super) struct Full;

impl Default for CommandGate {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                next: 1,
                running: false,
                idle_since: Instant::now(),
                waiting: BTreeSet::new(),
            }),
            changed: Notify::new(),
        }
    }
}

impl CommandGate {
    /// Wait for `seq`'s turn. The turn lasts until the returned guard drops:
    /// hold it until the command is on the monitor's channel.
    pub(super) async fn enter(self: &Arc<Self>, seq: u64) -> Result<Turn, Full> {
        let arrived = Instant::now();
        let mut place = Waiting {
            gate: self,
            seq,
            listed: false,
        };
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            // Registered before the state is read, so a release between the
            // read and the wait is not missed.
            changed.as_mut().enable();
            let deadline = {
                let mut state = self.lock();
                // A missing number is timed from when the gate last had both
                // nothing running and this request waiting on it.
                let give_up = state.idle_since.max(arrived) + LOST_SEQ_TIMEOUT;
                let lowest_waiting = state.waiting.first().is_none_or(|&first| seq <= first);
                let lost = lowest_waiting && Instant::now() >= give_up;
                if !state.running && (seq <= state.next || lost) {
                    state.running = true;
                    state.waiting.remove(&seq);
                    place.listed = false;
                    return Ok(Turn {
                        gate: Arc::clone(self),
                        seq,
                    });
                }
                if !place.listed {
                    if state.waiting.len() >= MAX_WAITING {
                        return Err(Full);
                    }
                    state.waiting.insert(seq);
                    place.listed = true;
                }
                (!state.running && state.waiting.first() == Some(&seq)).then_some(give_up)
            };
            match deadline {
                Some(deadline) => {
                    tokio::select! {
                        () = &mut changed => {}
                        () = tokio::time::sleep_until(deadline) => {}
                    }
                }
                None => changed.await,
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // The state is counters and a set, valid whatever panicked holding it.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A request's place in the line; leaves it if the request is dropped while
/// waiting (its client went away), so the next one is not timed against it.
struct Waiting<'a> {
    gate: &'a Arc<CommandGate>,
    seq: u64,
    listed: bool,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if self.listed {
            self.gate.lock().waiting.remove(&self.seq);
            self.gate.changed.notify_waiters();
        }
    }
}

/// The right to run now. Dropping it lets the next number in.
#[derive(Debug)]
pub(super) struct Turn {
    gate: Arc<CommandGate>,
    seq: u64,
}

impl Drop for Turn {
    fn drop(&mut self) {
        {
            let mut state = self.gate.lock();
            state.running = false;
            state.next = state.next.max(self.seq.saturating_add(1));
            state.idle_since = Instant::now();
        }
        self.gate.changed.notify_waiters();
    }
}
