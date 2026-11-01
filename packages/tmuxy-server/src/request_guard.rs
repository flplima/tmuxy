//! Where an API request came from, checked before any handler runs.
//!
//! The API is a remote shell — `/commands` runs any tmux command — and a
//! browser sends requests to it on behalf of whatever page its user has open. So every API request has to come from the
//! app itself:
//!
//! - `Sec-Fetch-Site`, which every current browser sends, must be `same-origin`
//!   (the app) or `none` (typed into the address bar). A page on any other
//!   origin says `cross-site` or `same-site` — another port on localhost is
//!   `same-site`, and so is a sandboxed page, whose origin is opaque.
//! - `Origin`, when present, must name the host the request was sent to. It
//!   covers a browser that predates Fetch Metadata.
//! - On a loopback bind, `Host` must be a loopback name, or one the operator
//!   allowed with `--allowed-host`. That is what stops DNS rebinding: a page
//!   whose domain was re-pointed at 127.0.0.1 is same-origin with the server as
//!   far as the browser knows, but it still sends its own domain as `Host`. A
//!   routable bind requires a password instead, and the browser holds no
//!   credentials for the rebound origin.
//!
//! A request with none of these headers is not a browser acting for a page —
//! `curl`, a script — and is let through. See docs/SECURITY.md.

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::IpAddr;
use std::sync::Arc;
use tracing::warn;

/// What a request's `Host` header may be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostPolicy {
    /// The server listens on loopback: `Host` must be a loopback name or one of
    /// these hostnames (a reverse proxy's public name, say).
    Loopback { allowed: Vec<String> },
    /// The server listens on a routable address. `Host` must still be one this
    /// server answers to — the address it bound, a loopback name, or an
    /// `--allowed-host`.
    ///
    /// This is what stops DNS rebinding: a hostile page cannot hold the
    /// browser's credentials for `http://<your-ip>:9000`, but it can point a
    /// name it owns at that address and have the browser send them. With
    /// `--no-auth` on a routable bind there are no credentials to need, and
    /// the rebind is a shell.
    ///
    /// `bound` is `None` for a wildcard bind (`0.0.0.0`, `::`), which answers
    /// on every address the machine has: any IP literal is one of them, and a
    /// hostname still has to be loopback or allowed. A container's published
    /// port is no boundary — Docker publishes on every host interface unless
    /// told otherwise — so the wildcard checks `Host` like any other bind.
    Bound {
        bound: Option<IpAddr>,
        allowed: Vec<String>,
    },
}

/// The hostname half of a `host[:port]` authority, brackets stripped from an
/// IPv6 literal.
fn hostname(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host)
}

/// `localhost`, anything under `.localhost` (browsers resolve those to loopback
/// themselves, never through DNS), or a loopback IP literal.
fn is_loopback_name(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Strip only the default port implied by `scheme`, lowercased, so
/// `Origin: https://example.com` matches `Host: example.com:443` while
/// `Origin: http://example.com` does not match `Host: example.com:443`.
fn normalized_authority_for_scheme(authority: &str, scheme: &str) -> Option<String> {
    let default_port = match scheme {
        "http" => ":80",
        "https" => ":443",
        _ => return None,
    };
    let authority = authority.to_ascii_lowercase();
    Some(
        authority
            .strip_suffix(default_port)
            .unwrap_or(&authority)
            .to_string(),
    )
}

/// Read at most one ASCII header value; fail closed when a header is repeated
/// or carries non-ASCII bytes so malformed security headers cannot look absent.
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, &'static str> {
    let mut values = headers.get_all(name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err("request carries duplicate security headers");
    }
    first
        .to_str()
        .map(Some)
        .map_err(|_| "request carries malformed security headers")
}

/// Decide whether a request may reach the API. The error names the rule it
/// broke, for the log and the 403 body.
#[cfg(test)]
fn check(headers: &HeaderMap, policy: &HostPolicy) -> Result<(), &'static str> {
    check_parts(&Method::GET, headers, None, policy)
}

/// Check a full HTTP request — including its method and HTTP/2 `:authority`
/// pseudo-header (`req.uri().authority()`) — against `policy`.
pub fn check_request<B>(req: &Request<B>, policy: &HostPolicy) -> Result<(), &'static str> {
    check_parts(
        req.method(),
        req.headers(),
        req.uri().authority().map(|a| a.as_str()),
        policy,
    )
}

fn check_parts(
    method: &Method,
    headers: &HeaderMap,
    uri_authority: Option<&str>,
    policy: &HostPolicy,
) -> Result<(), &'static str> {
    let site = single_header(headers, "sec-fetch-site")?;
    let mode = single_header(headers, "sec-fetch-mode")?;

    if let Some(site) = site {
        if site != "same-origin" && site != "none" {
            return Err("request sent by a page on another origin");
        }
        // Navigating to a URL or submitting from `Sec-Fetch-Site: none` never
        // legitimately POSTs to the app's JSON/preview APIs; only the app's own
        // `same-origin` scripts (or non-browser CLI tools with no Fetch
        // Metadata) do.
        if method != Method::GET && method != Method::HEAD && site == "none" {
            return Err("mutating request was not sent by the app itself");
        }
    }
    if method != Method::GET && method != Method::HEAD && mode == Some("navigate") {
        return Err("mutating request was sent as a navigation");
    }

    let host_header = single_header(headers, header::HOST.as_str())?;
    if let (Some(h), Some(a)) = (host_header, uri_authority) {
        if !h.eq_ignore_ascii_case(a) {
            return Err("request Host and :authority disagree");
        }
    }
    let host = host_header.or(uri_authority);

    if let Some(origin) = single_header(headers, header::ORIGIN.as_str())? {
        let same = match (origin.split_once("://"), host) {
            (Some((scheme, from)), Some(to)) => {
                let scheme = scheme.to_ascii_lowercase();
                match (
                    normalized_authority_for_scheme(from, &scheme),
                    normalized_authority_for_scheme(to, &scheme),
                ) {
                    (Some(from), Some(to)) => from == to,
                    _ => false,
                }
            }
            _ => false,
        };
        if !same {
            return Err("request Origin does not match the server it was sent to");
        }
    }

    match policy {
        HostPolicy::Loopback { allowed } => {
            let name = host.map(hostname).ok_or("request has no Host header")?;
            if !is_loopback_name(name) && !names_this_server(name, None, allowed) {
                return Err("request Host is not this server (see --allowed-host)");
            }
        }
        HostPolicy::Bound { bound, allowed } => {
            let name = host.map(hostname).ok_or("request has no Host header")?;
            let loopback_ok = allowed.is_empty() && is_loopback_name(name);
            if !loopback_ok && !names_this_server(name, *bound, allowed) {
                return Err("request Host is not this server (see --allowed-host)");
            }
        }
    }

    Ok(())
}

/// Whether `name` is an address or hostname this server answers to: the
/// literal it bound (any literal, for a wildcard bind), or one the operator
/// listed with `--allowed-host`. An IP literal is never a rebound name — a
/// page whose origin is that address was served by it. An allowed entry is
/// compared by its hostname, as `name` is, so one written with a port or IPv6
/// brackets (`example.com:8443`, `[::1]`) still matches.
fn names_this_server(name: &str, bound: Option<IpAddr>, allowed: &[String]) -> bool {
    if let Ok(ip) = name.parse::<IpAddr>() {
        if bound.is_none_or(|bound| bound == ip) {
            return true;
        }
    }
    allowed
        .iter()
        .any(|a| allowed_hostname(a).eq_ignore_ascii_case(name))
}

/// An `--allowed-host` entry's hostname. A bare IPv6 literal (`::1`) is
/// already one; anything else is read as a `host[:port]` authority.
fn allowed_hostname(entry: &str) -> &str {
    if entry.parse::<IpAddr>().is_ok() {
        entry
    } else {
        hostname(entry)
    }
}

/// A browser opening the server as a page of its own (the address bar, a
/// link, a bookmark), rather than a page fetching from it or framing it.
/// Such a request may come from another site and still be the user's.
pub fn is_top_level_navigation(headers: &HeaderMap) -> bool {
    matches!(
        single_header(headers, "sec-fetch-mode"),
        Ok(Some("navigate"))
    ) && matches!(
        single_header(headers, "sec-fetch-dest"),
        Ok(Some("document"))
    )
}

/// Axum middleware applying [`check_request`] to every API route.
pub async fn require_same_origin(
    State(policy): State<Arc<HostPolicy>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    match check_request(&req, &policy) {
        Ok(()) => next.run(req).await,
        Err(reason) => {
            warn!(target: "tmuxy_server::request_guard", path = %req.uri().path(), reason, "refused API request");
            (StatusCode::FORBIDDEN, format!("forbidden: {reason}\n")).into_response()
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
