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

/// A wildcard bind with no allowed list — `bin/dev-server` in a container.
fn wildcard_bind() -> HostPolicy {
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
}

/// SEC-CRIT-01. A wildcard bind with no allowed list let any `Host`
/// through, on the theory that a container's published port was the
/// boundary. Docker publishes on every host interface, and the dev server
/// runs `--no-auth` there, so a rebound name was a shell for any page the
/// developer opened.
#[test]
fn a_rebound_domain_is_refused_on_a_wildcard_bind() {
    let rebound = headers(&[
        ("host", "attacker.example:9000"),
        ("origin", "http://attacker.example:9000"),
        ("sec-fetch-site", "same-origin"),
    ]);
    assert!(check(&rebound, &wildcard_bind()).is_err());

    // Loopback, a published port's forwarded `localhost`, and any address
    // of the machine still reach it.
    for host in [
        "localhost:14089",
        "127.0.0.1:9000",
        "192.168.1.20:9000",
        "[fd00::1]:9000",
    ] {
        assert_eq!(
            check(&headers(&[("host", host)]), &wildcard_bind()),
            Ok(()),
            "{host}"
        );
    }
    assert!(check(&HeaderMap::new(), &wildcard_bind()).is_err());
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
fn an_allowed_host_written_with_a_port_or_brackets_still_matches() {
    let policy = HostPolicy::Loopback {
        allowed: vec![
            "example.com:8443".into(),
            "[fd00::1]".into(),
            "fd00::2".into(),
        ],
    };
    for host in [
        "example.com:8443",
        "example.com",
        "[fd00::1]:9000",
        "[fd00::2]:9000",
    ] {
        assert_eq!(
            check(&headers(&[("host", host)]), &policy),
            Ok(()),
            "{host}"
        );
    }
    assert!(check(&headers(&[("host", "other.com:8443")]), &policy).is_err());
}

#[test]
fn only_a_page_load_is_a_top_level_navigation() {
    let page = headers(&[
        ("sec-fetch-mode", "navigate"),
        ("sec-fetch-dest", "document"),
    ]);
    assert!(is_top_level_navigation(&page));
    let frame = headers(&[("sec-fetch-mode", "navigate"), ("sec-fetch-dest", "iframe")]);
    assert!(!is_top_level_navigation(&frame));
    let image = headers(&[("sec-fetch-mode", "no-cors"), ("sec-fetch-dest", "image")]);
    assert!(!is_top_level_navigation(&image));
    assert!(!is_top_level_navigation(&HeaderMap::new()));
}

#[test]
fn a_default_port_matches_its_absence_only_for_its_own_scheme() {
    let policy = HostPolicy::Loopback {
        allowed: vec!["example.com".into()],
    };
    let tls = headers(&[
        ("host", "example.com:443"),
        ("origin", "https://example.com"),
    ]);
    assert_eq!(check(&tls, &policy), Ok(()));

    let mismatched_scheme = headers(&[
        ("host", "example.com:443"),
        ("origin", "http://example.com"),
    ]);
    assert!(check(&mismatched_scheme, &policy).is_err());
}

#[test]
fn non_ascii_or_duplicate_security_headers_fail_closed() {
    let mut non_ascii = headers(&[("host", "localhost:9000")]);
    non_ascii.insert(
        "sec-fetch-site",
        HeaderValue::from_bytes(b"cross-site\xff").unwrap(),
    );
    assert!(check(&non_ascii, &loopback()).is_err());

    let mut dup = headers(&[("host", "localhost:9000")]);
    dup.append("sec-fetch-site", HeaderValue::from_static("same-origin"));
    dup.append("sec-fetch-site", HeaderValue::from_static("cross-site"));
    assert!(check(&dup, &loopback()).is_err());
}

#[test]
fn routable_bind_with_allowed_hosts_refuses_unlisted_localhost_and_checks_h2_authority() {
    let policy = HostPolicy::Bound {
        bound: Some("192.168.1.20".parse().unwrap()),
        allowed: vec!["demo.example".into()],
    };
    assert!(check(&headers(&[("host", "localhost:9000")]), &policy).is_err());
    assert_eq!(
        check(&headers(&[("host", "demo.example")]), &policy),
        Ok(())
    );

    let h2_ok = Request::get("https://demo.example/events")
        .body(Body::empty())
        .unwrap();
    assert_eq!(check_request(&h2_ok, &policy), Ok(()));

    let h2_conflict = Request::get("https://demo.example/events")
        .header("host", "attacker.example")
        .body(Body::empty())
        .unwrap();
    assert!(check_request(&h2_conflict, &policy).is_err());

    let nav_post = Request::post("/commands")
        .header("host", "localhost:9000")
        .header("sec-fetch-site", "none")
        .body(Body::empty())
        .unwrap();
    assert!(check_request(&nav_post, &loopback()).is_err());
}
