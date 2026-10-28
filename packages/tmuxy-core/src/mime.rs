//! Content types for the frontend assets the server embeds.
//!
//! The bytes have to arrive labelled: an HTML page handed out as `text/plain`
//! renders as source code, and a stylesheet or script with the wrong type is
//! dropped by the strict MIME checks browsers apply to `<link rel=stylesheet>`
//! and module scripts.

/// Content type for a path, from its extension. Unknown extensions fall back to
/// UTF-8 plain text.
pub fn content_type_for_path(path: &str) -> &'static str {
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "text/plain; charset=utf-8",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_pages_and_their_subresources() {
        assert_eq!(
            content_type_for_path("/tmp/a/index.html"),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type_for_path("/tmp/a/style.CSS"),
            "text/css; charset=utf-8"
        );
        assert_eq!(
            content_type_for_path("/tmp/a/app.mjs"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type_for_path("/tmp/a/logo.svg"), "image/svg+xml");
        assert_eq!(
            content_type_for_path("manifest.webmanifest"),
            "application/manifest+json"
        );
        assert_eq!(content_type_for_path("/tmp/a/font.woff2"), "font/woff2");
    }

    #[test]
    fn unknown_and_extensionless_paths_are_plain_text() {
        assert_eq!(
            content_type_for_path("/tmp/a/README"),
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            content_type_for_path("/tmp/a/data.zzz"),
            "text/plain; charset=utf-8"
        );
        // A dot in a directory name is not the file's extension.
        assert_eq!(
            content_type_for_path("/tmp/v1.2/README"),
            "text/plain; charset=utf-8"
        );
    }
}
