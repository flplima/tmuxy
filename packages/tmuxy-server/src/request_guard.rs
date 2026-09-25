//! Where an API request came from, checked before any handler runs.
//!
//! The API is a remote shell — `/commands` runs any tmux command and
//! `/api/file` reads any file — and a browser sends requests to it on behalf of
//! whatever page its user has open. So every API request has to come from the
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
    http::{header, HeaderMap, Request, StatusCode},
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
    /// `bound` is `None` for a wildcard bind (`0.0.0.0`, `::`), where the
    /// server genuinely does not know which of its addresses a request
    /// arrived on. With no `allowed` list either, there is nothing left to
    /// check and any `Host` passes; that is the container case, where the
    /// published port is the boundary.
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

/// An authority with the port a scheme implies by default dropped, lowercased,
/// so `Origin: https://example.com` matches `Host: example.com:443`.
fn normalized_authority(authority: &str) -> String {
    let authority = authority.to_ascii_lowercase();
    for default_port in [":80", ":443"] {
        if let Some(bare) = authority.strip_suffix(default_port) {
            return bare.to_string();
        }
    }
    authority
}

/// Decide whether a request may reach the API. The error names the rule it
/// broke, for the log and the 403 body.
pub fn check(headers: &HeaderMap, policy: &HostPolicy) -> Result<(), &'static str> {
    let header_str = |name| headers.get(name).and_then(|v| v.to_str().ok());

    if let Some(site) = header_str("sec-fetch-site") {
        if site != "same-origin" && site != "none" {
            return Err("request sent by a page on another origin");
        }
    }

    let host = header_str(header::HOST.as_str());

    if let Some(origin) = header_str(header::ORIGIN.as_str()) {
        let origin_authority = origin.split_once("://").map(|(_, rest)| rest);
        let same = match (origin_authority, host) {
            (Some(from), Some(to)) => normalized_authority(from) == normalized_authority(to),
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
            // A wildcard bind with no allowed list has nothing to compare
            // against — see the variant's docs.
            if bound.is_none() && allowed.is_empty() {
                return Ok(());
            }
            let name = host.map(hostname).ok_or("request has no Host header")?;
            if !is_loopback_name(name) && !names_this_server(name, *bound, allowed) {
                return Err("request Host is not this server (see --allowed-host)");
            }
        }
    }

    Ok(())
}

/// Whether `name` is an address or hostname this server answers to: the
/// literal it bound, or one the operator listed with `--allowed-host`.
fn names_this_server(name: &str, bound: Option<IpAddr>, allowed: &[String]) -> bool {
    if let Some(bound) = bound {
        if name.parse::<IpAddr>().is_ok_and(|ip| ip == bound) {
            return true;
        }
    }
    allowed.iter().any(|a| a.eq_ignore_ascii_case(name))
}

/// Axum middleware applying [`check`] to every API route.
pub async fn require_same_origin(
    State(policy): State<Arc<HostPolicy>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    match check(req.headers(), &policy) {
        Ok(()) => next.run(req).await,
        Err(reason) => {
            warn!(target: "tmuxy_server::request_guard", path = %req.uri().path(), reason, "refused API request");
            (StatusCode::FORBIDDEN, format!("forbidden: {reason}\n")).into_response()
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_static(value));
        }
        map
    }

    fn loopback() -> HostPolicy {
        HostPolicy::Loopback { allowed: vec![] }
    }

    /// A wildcard bind with no allowed list: the one shape that still accepts
    /// any `Host`, because the server knows no address of its own to compare.
    fn any_bind() -> HostPolicy {
        HostPolicy::Bound {
            bound: None,
            allowed: vec![],
        }
    }

    #[test]
    fn the_app_itself_gets_through() {
        let app = headers(&[
            ("host", "localhost:9000"),
            ("origin", "http://localhost:9000"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert_eq!(check(&app, &loopback()), Ok(()));
    }

    #[test]
    fn a_client_that_is_not_a_browser_gets_through() {
        assert_eq!(
            check(&headers(&[("host", "127.0.0.1:9000")]), &loopback()),
            Ok(())
        );
    }

    #[test]
    fn a_page_on_another_origin_is_refused_however_it_sends() {
        // The no-preflight POST a hostile page makes: text/plain, no-cors.
        let cross_site = headers(&[
            ("host", "localhost:9000"),
            ("origin", "https://evil.example"),
            ("sec-fetch-site", "cross-site"),
        ]);
        assert!(check(&cross_site, &loopback()).is_err());
        // Another port on localhost is a different origin but the same site.
        let other_port = headers(&[
            ("host", "localhost:9000"),
            ("origin", "http://localhost:3000"),
            ("sec-fetch-site", "same-site"),
        ]);
        assert!(check(&other_port, &loopback()).is_err());
        // A browser without Fetch Metadata still sends Origin on a POST.
        let origin_only = headers(&[
            ("host", "localhost:9000"),
            ("origin", "http://evil.example"),
        ]);
        assert!(check(&origin_only, &loopback()).is_err());
    }

    #[test]
    fn a_sandboxed_page_is_refused() {
        let sandboxed = headers(&[("host", "localhost:9000"), ("origin", "null")]);
        assert!(check(&sandboxed, &loopback()).is_err());
    }

    #[test]
    fn a_rebound_domain_is_refused_on_a_loopback_bind() {
        // DNS rebinding: the page and the server look same-origin to the browser.
        let rebound = headers(&[
            ("host", "attacker.example:9000"),
            ("origin", "http://attacker.example:9000"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert!(check(&rebound, &loopback()).is_err());
        assert_eq!(check(&rebound, &any_bind()), Ok(()));
    }

    #[test]
    fn every_loopback_spelling_and_an_allowed_host_pass() {
        for host in [
            "localhost:9000",
            "LOCALHOST",
            "127.0.0.1:9000",
            "[::1]:9000",
            "tmuxy.localhost:9000",
        ] {
            assert_eq!(
                check(&headers(&[("host", host)]), &loopback()),
                Ok(()),
                "{host}"
            );
        }
        let proxied = headers(&[
            ("host", "tmux.example.com"),
            ("origin", "https://tmux.example.com"),
            ("sec-fetch-site", "same-origin"),
        ]);
        let policy = HostPolicy::Loopback {
            allowed: vec!["tmux.example.com".into()],
        };
        assert_eq!(check(&proxied, &policy), Ok(()));
    }

    #[test]
    fn a_missing_host_is_refused_on_a_loopback_bind() {
        assert!(check(&HeaderMap::new(), &loopback()).is_err());
    }

    /// SEC-10. The `Host` rule used to run only under `Loopback`, and every
    /// routable bind got `Any` — so with `--no-auth` on a LAN address, a
    /// hostile page pointing a name it owns at that address had a shell. A
    /// browser holds no credentials for an IP literal, but it will happily
    /// send them to a name.
    #[test]
    fn a_rebound_domain_is_refused_on_a_routable_bind_too() {
        let bound = HostPolicy::Bound {
            bound: Some("192.168.1.20".parse().unwrap()),
            allowed: vec![],
        };
        let rebound = headers(&[
            ("host", "attacker.example:9000"),
            ("origin", "http://attacker.example:9000"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert!(check(&rebound, &bound).is_err());

        // The address it actually bound, and loopback, still reach it.
        for host in ["192.168.1.20:9000", "localhost:9000", "127.0.0.1"] {
            assert_eq!(check(&headers(&[("host", host)]), &bound), Ok(()), "{host}");
        }
    }

    /// SEC-15. A name the operator listed reaches the server on a routable
    /// bind, and one they did not does not — which is what the public demo's
    /// README already claimed.
    #[test]
    fn an_allowed_host_reaches_a_routable_bind_and_nothing_else_does() {
        let policy = HostPolicy::Bound {
            bound: None,
            allowed: vec!["demo.example".into()],
        };
        let allowed = headers(&[
            ("host", "demo.example"),
            ("origin", "https://demo.example"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert_eq!(check(&allowed, &policy), Ok(()));

        let other = headers(&[
            ("host", "attacker.example"),
            ("origin", "https://attacker.example"),
            ("sec-fetch-site", "same-origin"),
        ]);
        assert!(check(&other, &policy).is_err());
    }

    #[test]
    fn a_default_port_matches_its_absence() {
        let tls = headers(&[
            ("host", "example.com:443"),
            ("origin", "https://example.com"),
        ]);
        assert_eq!(check(&tls, &any_bind()), Ok(()));
    }
}
