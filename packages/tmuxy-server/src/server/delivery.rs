//! How the server's answers cross a link that is not loopback: compressed
//! when the client takes it, cached when the name says the bytes can never
//! change, revalidated when it cannot say so, and written to the socket the
//! moment they are ready.

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::CompressionLayer;

/// A year, the longest a cache is asked to keep anything.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Kept, and asked about before every use: the answer is a 304 while the
/// bytes stand.
const REVALIDATE: &str = "no-cache";

/// gzip or brotli over every answer that shrinks: the bundle, a full state,
/// a pane's scrollback. Never the event stream, whose frames must leave as
/// they are written, and never what is compressed already (pictures, fonts).
pub(super) fn compressed(app: axum::Router) -> axum::Router {
    let shrinks = DefaultPredicate::new().and(NotForContentType::const_new("font/"));
    app.layer(
        CompressionLayer::new()
            .gzip(true)
            .br(true)
            .compress_when(shrinks),
    )
}

/// A state delta is a small write; Nagle's algorithm would hold each one
/// back until the client has acknowledged the one before.
pub(super) fn send_without_delay(connection: &mut tokio::net::TcpStream) {
    if let Err(error) = connection.set_nodelay(true) {
        tracing::debug!(%error, "could not set TCP_NODELAY on a connection");
    }
}

/// Whether `path` is a build output named after its own content
/// (`assets/index-DcgKV4k9.js`): Vite puts eight characters of the file's
/// hash before the extension, so a new build is a new name.
pub(super) fn is_fingerprinted(path: &str) -> bool {
    let Some(file) = path.strip_prefix("assets/") else {
        return false;
    };
    let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
    // The hash is base64url, so it may itself hold a `-`: it is the last
    // eight characters, whatever they are, after the `-` that ends the name.
    let Some(split) = stem
        .len()
        .checked_sub(8)
        .filter(|&at| stem.is_char_boundary(at))
    else {
        return false;
    };
    let (name, hash) = stem.split_at(split);
    name.len() > 1
        && name.ends_with('-')
        && hash
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The validator of `body`: a quoted digest, as `ETag` and `If-None-Match` carry it.
pub(super) fn etag_of(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    let hex: String = digest[..12].iter().map(|b| format!("{b:02x}")).collect();
    format!("\"{hex}\"")
}

fn names(if_none_match: &HeaderValue, etag: &str) -> bool {
    if_none_match.to_str().is_ok_and(|sent| {
        sent.split(',')
            .any(|tag| tag.trim() == etag || tag.trim() == "*")
    })
}

/// A file of the embedded frontend, for a browser that may already hold it.
/// A fingerprinted one is kept for good. Any other is kept with its
/// validator and answered `304` while that still names these bytes.
pub(super) fn cached(path: &str, mime: &str, body: Vec<u8>, request: &HeaderMap) -> Response {
    if is_fingerprinted(path) {
        let mut response = crate::state::build_response(StatusCode::OK, mime, body);
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE));
        return response;
    }
    let etag = etag_of(&body);
    let unchanged = request
        .get(header::IF_NONE_MATCH)
        .is_some_and(|sent| names(sent, &etag));
    let mut response = if unchanged {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        crate::state::build_response(StatusCode::OK, mime, body)
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(REVALIDATE));
    if let Ok(value) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use tower::ServiceExt;

    async fn body_len(response: Response) -> usize {
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .len()
    }

    fn cache_control(response: &Response) -> &str {
        response.headers()[header::CACHE_CONTROL].to_str().unwrap()
    }

    #[test]
    fn only_a_build_output_named_after_its_content_is_fingerprinted() {
        assert!(is_fingerprinted("assets/index-DcgKV4k9.js"));
        assert!(is_fingerprinted(
            "assets/FiraCodeNerdFont-Bold-BOVV2wEr.woff2"
        ));
        assert!(is_fingerprinted("assets/elk-IJKZMXRS-th90eWZ-.js"));
        for path in [
            "index.html",
            "sw.js",
            "favicon.svg",
            "themes/default.css",
            "assets/logo.svg",
            "assets/index-short.js",
            "assets/-DcgKV4k9.js",
            "index-DcgKV4k9.js",
        ] {
            assert!(!is_fingerprinted(path), "{path}");
        }
    }

    #[tokio::test]
    async fn a_fingerprinted_file_is_kept_for_good() {
        let response = cached(
            "assets/index-DcgKV4k9.js",
            "text/javascript; charset=utf-8",
            b"bundle".to_vec(),
            &HeaderMap::new(),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(cache_control(&response), IMMUTABLE);
        assert_eq!(body_len(response).await, 6);
    }

    #[tokio::test]
    async fn any_other_file_is_sent_again_only_when_its_bytes_changed() {
        let first = cached(
            "index.html",
            "text/html",
            b"<p>one</p>".to_vec(),
            &HeaderMap::new(),
        );
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(cache_control(&first), REVALIDATE);
        let etag = first.headers()[header::ETAG].clone();

        let mut held = HeaderMap::new();
        held.insert(header::IF_NONE_MATCH, etag.clone());
        let same = cached("index.html", "text/html", b"<p>one</p>".to_vec(), &held);
        assert_eq!(same.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(same.headers()[header::ETAG], etag);
        assert_eq!(cache_control(&same), REVALIDATE);
        assert_eq!(body_len(same).await, 0);

        // The next release: the same name, other bytes.
        let changed = cached("index.html", "text/html", b"<p>two</p>".to_vec(), &held);
        assert_eq!(changed.status(), StatusCode::OK);
        assert_ne!(changed.headers()[header::ETAG], etag);
        assert_eq!(body_len(changed).await, 10);
    }

    fn app() -> axum::Router {
        let of = |mime: &'static str| {
            move || async move {
                crate::state::build_response(StatusCode::OK, mime, "tmuxy ".repeat(2000))
            }
        };
        compressed(
            axum::Router::new()
                .route("/state", get(of("application/json")))
                .route("/bundle.js", get(of("text/javascript; charset=utf-8")))
                .route("/events", get(of("text/event-stream")))
                .route("/font", get(of("font/woff2")))
                .route("/picture", get(of("image/png"))),
        )
    }

    async fn fetch(path: &str, accepts: Option<&str>) -> Response {
        let mut request = Request::get(path).body(Body::empty()).unwrap();
        if let Some(accepts) = accepts {
            request.headers_mut().insert(
                header::ACCEPT_ENCODING,
                HeaderValue::from_str(accepts).unwrap(),
            );
        }
        app().oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn text_answers_shrink_for_a_client_that_takes_an_encoding() {
        for path in ["/state", "/bundle.js"] {
            for (accepts, encoding) in [("gzip", "gzip"), ("gzip, deflate, br", "br")] {
                let response = fetch(path, Some(accepts)).await;
                assert_eq!(
                    response.headers()[header::CONTENT_ENCODING],
                    encoding,
                    "{path} for {accepts}"
                );
                assert!(
                    body_len(response).await < 12_000 / 10,
                    "{path} for {accepts}"
                );
            }
            let plain = fetch(path, None).await;
            assert!(plain.headers().get(header::CONTENT_ENCODING).is_none());
            assert_eq!(body_len(plain).await, 12_000);
        }
    }

    /// A compressor holds bytes back until it has a block's worth, and an
    /// event held back is an echo the user waits for.
    #[tokio::test]
    async fn the_event_stream_and_what_is_already_compressed_leave_as_they_are() {
        for path in ["/events", "/font", "/picture"] {
            let response = fetch(path, Some("gzip, br")).await;
            assert!(
                response.headers().get(header::CONTENT_ENCODING).is_none(),
                "{path}"
            );
            assert_eq!(body_len(response).await, 12_000, "{path}");
        }
    }

    #[tokio::test]
    async fn a_connection_is_told_to_send_small_writes_at_once() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (client, accepted) =
            tokio::join!(tokio::net::TcpStream::connect(address), listener.accept());
        let _client = client.unwrap();
        let (mut connection, _) = accepted.unwrap();
        assert!(!connection.nodelay().unwrap());
        send_without_delay(&mut connection);
        assert!(connection.nodelay().unwrap());
    }
}
