//! Optional HTTP Basic authentication for the web server.
//!
//! When `tmuxy server --password <PW>` (or the `TMUXY_PASSWORD` env var) is
//! set, every HTTP route — the SSE stream, the command endpoint, the `/api/*`
//! handlers, and the embedded frontend itself — is gated behind Basic auth.
//! Only the password is checked; any username is accepted, so the browser's
//! native login prompt just needs the shared password. With no password
//! configured the layer is never installed and the server stays fully open
//! (unchanged default behaviour).
//!
//! The gate works transparently for the browser client: the first request 401s
//! with a `WWW-Authenticate` challenge, the browser prompts and then caches the
//! credentials for the origin, and every subsequent request — including the
//! `EventSource` SSE connection and `fetch` POSTs — carries the `Authorization`
//! header automatically. No frontend change is required. The Tauri desktop app
//! talks over local IPC, not HTTP, so it is unaffected.

use axum::{
    body::Body,
    extract::{ConnectInfo, State},
    http::{header, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::Engine as _;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::warn;

/// Realm shown in the browser's Basic-auth prompt.
const REALM: &str = "tmuxy";

/// Wrong passwords a peer may try before its next attempt is delayed.
///
/// A browser prompts, and a person mistypes; the allowance is for them. It is
/// not for the script that has the whole rockyou list.
const FREE_ATTEMPTS: u32 = 5;

/// The first delay after the allowance runs out; it doubles per failure.
const BASE_DELAY: Duration = Duration::from_secs(1);

/// The longest a refusal is held. Past this the delay stops growing — long
/// enough that guessing is hopeless, short enough that the connection is not
/// itself a resource a flood can pin.
const MAX_DELAY: Duration = Duration::from_secs(30);

/// How long a peer's failures are remembered after its last attempt.
const FORGET_AFTER: Duration = Duration::from_secs(600);

/// The most peers tracked at once, so the tracker cannot become the memory
/// exhaustion it exists to prevent. Past it the oldest entry is dropped.
const MAX_TRACKED_PEERS: usize = 4096;

/// Per-peer failed-attempt counts, and what they cost.
///
/// Basic auth over a routable bind is the recommended VPN/mobile setup
/// (docs/SECURITY.md), and a password is the only thing between the network
/// and a shell. The comparison is constant-time, but nothing stopped a peer
/// trying passwords as fast as it could open connections.
#[derive(Default)]
pub struct AuthThrottle {
    peers: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl AuthThrottle {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a failure for `peer` and return how long to hold the refusal.
    fn penalise(&self, peer: IpAddr, now: Instant) -> Duration {
        let Ok(mut peers) = self.peers.lock() else {
            // A poisoned lock means another thread panicked holding it. Refuse
            // without a delay rather than propagate the panic.
            return Duration::ZERO;
        };
        peers.retain(|_, (_, last)| now.duration_since(*last) < FORGET_AFTER);
        if peers.len() >= MAX_TRACKED_PEERS && !peers.contains_key(&peer) {
            if let Some(oldest) = peers
                .iter()
                .min_by_key(|(_, (_, last))| *last)
                .map(|(ip, _)| *ip)
            {
                peers.remove(&oldest);
            }
        }
        let entry = peers.entry(peer).or_insert((0, now));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = now;
        delay_for_failures(entry.0)
    }

    /// Forget `peer`: it got the password right.
    fn forgive(&self, peer: IpAddr) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.remove(&peer);
        }
    }
}

/// What the nth consecutive failure costs: nothing while a person could still
/// be mistyping, then doubling from [`BASE_DELAY`] up to [`MAX_DELAY`].
fn delay_for_failures(failures: u32) -> Duration {
    if failures <= FREE_ATTEMPTS {
        return Duration::ZERO;
    }
    let steps = failures - FREE_ATTEMPTS - 1;
    BASE_DELAY
        .checked_mul(1u32.checked_shl(steps.min(31)).unwrap_or(u32::MAX))
        .unwrap_or(MAX_DELAY)
        .min(MAX_DELAY)
}

/// Constant-time comparison so a wrong password can't be recovered by timing
/// the response. The length check leaks only the password's length, which is
/// not sensitive.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extract the password half of a `Basic <base64(user:pass)>` header value.
/// Splits on the FIRST colon so passwords may themselves contain colons.
fn password_from_header(value: &str) -> Option<Vec<u8>> {
    let encoded = value.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let colon = decoded.iter().position(|&b| b == b':')?;
    Some(decoded[colon + 1..].to_vec())
}

/// What the auth layer is given: the password, and the failures so far.
pub struct AuthState {
    pub password: String,
    pub throttle: AuthThrottle,
}

/// Axum middleware enforcing HTTP Basic auth against the configured password.
///
/// A wrong password costs the peer time once it has spent its allowance, and
/// every refusal is logged with the address it came from. Behind a reverse
/// proxy the peer IS the proxy, so the delay is then shared by everyone behind
/// it — which is why the proxy is expected to do its own limiting, and why
/// `X-Forwarded-For` is deliberately not trusted here (anyone can send one).
pub async fn require_basic_auth(
    State(state): State<Arc<AuthState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(password_from_header)
        .is_some_and(|pw| constant_time_eq(&pw, state.password.as_bytes()));

    if ok {
        state.throttle.forgive(peer.ip());
        return next.run(req).await;
    }

    let delay = state.throttle.penalise(peer.ip(), Instant::now());
    warn!(
        target: "tmuxy_server::auth",
        peer = %peer.ip(),
        path = %req.uri().path(),
        delay_ms = delay.as_millis() as u64,
        "refused a request with no or wrong password"
    );
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }

    (
        StatusCode::UNAUTHORIZED,
        [(
            header::WWW_AUTHENTICATE,
            format!("Basic realm=\"{REALM}\", charset=\"UTF-8\""),
        )],
        "Unauthorized\n",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basic(user: &str, pass: &str) -> String {
        let raw = format!("{user}:{pass}");
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        )
    }

    /// SEC-08. The comparison is constant time, but nothing stopped a peer
    /// trying passwords as fast as it could open connections — and a password
    /// is the only thing between a routable bind and a shell.
    #[test]
    fn a_person_mistyping_is_not_punished_but_a_guesser_is() {
        // The allowance is for someone at a browser prompt.
        for attempt in 1..=FREE_ATTEMPTS {
            assert_eq!(delay_for_failures(attempt), Duration::ZERO, "{attempt}");
        }
        // Then it doubles.
        assert_eq!(delay_for_failures(FREE_ATTEMPTS + 1), BASE_DELAY);
        assert_eq!(delay_for_failures(FREE_ATTEMPTS + 2), BASE_DELAY * 2);
        assert_eq!(delay_for_failures(FREE_ATTEMPTS + 3), BASE_DELAY * 4);
    }

    #[test]
    fn the_delay_stops_growing_rather_than_overflowing() {
        // However many failures, the refusal is held for a bounded time: the
        // connection it holds is a resource too.
        for failures in [20u32, 100, 10_000, u32::MAX] {
            assert_eq!(delay_for_failures(failures), MAX_DELAY, "{failures}");
        }
    }

    #[test]
    fn failures_are_counted_per_peer_and_cleared_by_success() {
        let throttle = AuthThrottle::new();
        let now = Instant::now();
        let guesser: IpAddr = "203.0.113.9".parse().unwrap();
        let bystander: IpAddr = "203.0.113.10".parse().unwrap();

        for _ in 0..FREE_ATTEMPTS {
            assert_eq!(throttle.penalise(guesser, now), Duration::ZERO);
        }
        assert_eq!(throttle.penalise(guesser, now), BASE_DELAY);

        // Someone else's first attempt is their first attempt.
        assert_eq!(throttle.penalise(bystander, now), Duration::ZERO);

        // Getting it right clears the slate: a person who finally remembers
        // their password is not left waiting on the next request.
        throttle.forgive(guesser);
        assert_eq!(throttle.penalise(guesser, now), Duration::ZERO);
    }

    #[test]
    fn a_peer_that_stops_trying_is_forgotten() {
        let throttle = AuthThrottle::new();
        let start = Instant::now();
        let peer: IpAddr = "203.0.113.11".parse().unwrap();

        for _ in 0..=FREE_ATTEMPTS {
            throttle.penalise(peer, start);
        }
        // Coming back much later starts over, so a shared or recycled address
        // does not inherit someone else's penalty forever.
        let later = start + FORGET_AFTER + Duration::from_secs(1);
        assert_eq!(throttle.penalise(peer, later), Duration::ZERO);
    }

    #[test]
    fn the_tracker_is_bounded_so_it_cannot_become_the_exhaustion_it_prevents() {
        let throttle = AuthThrottle::new();
        let now = Instant::now();
        for i in 0..(MAX_TRACKED_PEERS + 50) {
            let ip = IpAddr::from(std::net::Ipv6Addr::from(i as u128));
            throttle.penalise(ip, now);
        }
        let tracked = throttle.peers.lock().unwrap().len();
        assert!(
            tracked <= MAX_TRACKED_PEERS,
            "tracking {tracked} peers, over the {MAX_TRACKED_PEERS} cap"
        );
    }

    #[test]
    fn accepts_correct_password_any_username() {
        assert_eq!(
            password_from_header(&basic("anyone", "s3cret")),
            Some(b"s3cret".to_vec())
        );
        assert_eq!(
            password_from_header(&basic("", "s3cret")),
            Some(b"s3cret".to_vec())
        );
    }

    #[test]
    fn password_may_contain_colons() {
        assert_eq!(
            password_from_header(&basic("u", "a:b:c")),
            Some(b"a:b:c".to_vec())
        );
    }

    #[test]
    fn rejects_malformed_headers() {
        assert_eq!(password_from_header("Bearer xyz"), None);
        assert_eq!(password_from_header("Basic not-base64!!"), None);
        // No colon at all → not a valid user:pass pair.
        let no_colon = base64::engine::general_purpose::STANDARD.encode("nopass");
        assert_eq!(password_from_header(&format!("Basic {no_colon}")), None);
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }
}
