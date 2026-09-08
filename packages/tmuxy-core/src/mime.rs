//! Content types for files served to the webview, and URL path decoding.
//!
//! The browser widget (`tmuxy widget browser`) points an `<iframe>` at a local
//! file, so the bytes have to arrive labelled: an HTML page handed out as
//! `text/plain` renders as source code, and a stylesheet with the wrong type is
//! dropped by the strict MIME checks browsers apply to `<link rel=stylesheet>`.
//!
//! Both deployments read from this one table. The web server answers
//! `/api/browse/<path>`; the desktop app serves no HTTP and answers the same
//! requests over its `tmuxyfile:` scheme (see `tmuxy-tauri-app/src/gui.rs`).
//! Path-shaped URLs are what make relative links inside a page resolve — a
//! `?path=` query string would send `./style.css` to the wrong place.

/// Content type for a path, from its extension. Unknown extensions fall back to
/// UTF-8 plain text, which is what an unlabelled file in a pane usually is.
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
        "json" => "application/json",
        "xml" => "application/xml",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "text/plain; charset=utf-8",
    }
}

/// Decode `%XX` escapes in a URL path component.
///
/// The desktop app reads the raw URI of a `tmuxyfile:` request, so it gets the
/// path exactly as the webview encoded it — a file whose name has a space or a
/// `#` arrives escaped and would otherwise be looked up under that literal
/// name. Invalid escapes are left as written rather than dropped, so a stray
/// `%` in a filename still round-trips.
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
            content_type_for_path("/tmp/a/notes.md"),
            "text/markdown; charset=utf-8"
        );
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

    #[test]
    fn decodes_escapes_and_leaves_broken_ones_alone() {
        assert_eq!(percent_decode("/tmp/my%20file.html"), "/tmp/my file.html");
        assert_eq!(percent_decode("/tmp/a%23b.md"), "/tmp/a#b.md");
        assert_eq!(percent_decode("/tmp/100%.md"), "/tmp/100%.md");
        assert_eq!(percent_decode("/tmp/a%zz.md"), "/tmp/a%zz.md");
        assert_eq!(percent_decode("/tmp/caf%C3%A9.md"), "/tmp/café.md");
    }
}
