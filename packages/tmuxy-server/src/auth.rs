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
    extract::State,
    http::{header, Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::Engine as _;
use std::sync::Arc;

/// Realm shown in the browser's Basic-auth prompt.
const REALM: &str = "tmuxy";

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

/// Axum middleware enforcing HTTP Basic auth against `expected`.
pub async fn require_basic_auth(
    State(expected): State<Arc<String>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    // Let CORS preflight through unauthenticated — an OPTIONS request carries
    // no credentials and returns only CORS headers, no data.
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }

    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(password_from_header)
        .is_some_and(|pw| constant_time_eq(&pw, expected.as_bytes()));

    if ok {
        next.run(req).await
    } else {
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
