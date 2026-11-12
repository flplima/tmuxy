//! How the embedded frontend's files go out: gzipped when the browser takes
//! it, and cached as long as their names allow.
//!
//! A remote browser (a phone, a laptop over the internet) used to download
//! ~0.9 MB of script and the rest uncompressed on every page load, nothing
//! cached. A text file is gzipped once, the first time it is asked for, and
//! kept; `dist/` itself is left as it is, so the desktop app, which reads it
//! from disk, carries no compressed copies.

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::{Arc, Mutex};

/// The files worth compressing: text. Fonts and images are compressed already.
const TEXT: [&str; 6] = [".js", ".mjs", ".css", ".html", ".svg", ".json"];

/// A file smaller than this goes as it is.
const MIN_BYTES: usize = 1024;

/// How long a browser may keep `path`: a file under `assets/` has its
/// content's hash in its name (the build gives it one), so it never changes
/// and is kept for a year; anything else (the page, the user's stylesheet)
/// is asked about again every time.
pub(crate) fn cache_control(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

/// Whether `accept`, an `Accept-Encoding` value, takes gzip (`q=0` refuses).
pub(crate) fn accepts_gzip(accept: &str) -> bool {
    accept.split(',').any(|offer| {
        let mut parts = offer.split(';').map(str::trim);
        let name = parts.next().unwrap_or("");
        let refused = parts.any(|param| {
            param
                .strip_prefix("q=")
                .and_then(|q| q.parse::<f32>().ok())
                .is_some_and(|q| q <= 0.0)
        });
        (name.eq_ignore_ascii_case("gzip") || name == "*") && !refused
    })
}

/// Each embedded file gzipped, by path: `None` for one not worth it.
type Packed = HashMap<String, Option<Arc<Vec<u8>>>>;

/// `data`, the embedded file `path`, gzipped: made the first time and kept.
/// `None` for a file not worth it (not text, small, or no smaller packed).
pub(crate) fn gzipped(path: &str, data: &[u8]) -> Option<Arc<Vec<u8>>> {
    static PACKED: Mutex<Option<Packed>> = Mutex::new(None);
    if data.len() < MIN_BYTES || !TEXT.iter().any(|ext| path.ends_with(ext)) {
        return None;
    }
    let mut packed = PACKED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    packed
        .get_or_insert_with(HashMap::new)
        .entry(path.to_string())
        .or_insert_with(|| {
            pack(data)
                .filter(|bytes| bytes.len() < data.len())
                .map(Arc::new)
        })
        .clone()
}

fn pack(data: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(data).ok()?;
    encoder.finish().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    #[test]
    fn a_hashed_asset_is_kept_a_year_and_the_page_asked_about_every_time() {
        assert_eq!(
            cache_control("assets/index-8XOsjAfb.js"),
            "public, max-age=31536000, immutable"
        );
        for path in ["index.html", "custom.css", "themes/default.css", "sw.js"] {
            assert_eq!(cache_control(path), "no-cache", "{path}");
        }
    }

    #[test]
    fn gzip_is_sent_only_where_the_browser_takes_it() {
        for accept in ["gzip, deflate, br", "br;q=1.0, gzip;q=0.8", "*"] {
            assert!(accepts_gzip(accept), "{accept}");
        }
        for accept in ["", "identity", "br", "gzip;q=0", "gzip; q=0.0"] {
            assert!(!accepts_gzip(accept), "{accept}");
        }
    }

    #[test]
    fn a_text_file_is_gzipped_once_and_reads_back_the_same() {
        let script = "export const x = 1;\n".repeat(200);
        let first = gzipped("assets/test-a.js", script.as_bytes()).expect("worth it");
        let again = gzipped("assets/test-a.js", script.as_bytes()).expect("kept");
        assert!(Arc::ptr_eq(&first, &again), "made once");
        let mut back = String::new();
        flate2::read::GzDecoder::new(first.as_slice())
            .read_to_string(&mut back)
            .unwrap();
        assert_eq!(back, script);
        assert!(
            gzipped("assets/font.woff2", &[0; 4096]).is_none(),
            "not text"
        );
        assert!(gzipped("assets/tiny.js", b"x").is_none(), "too small");
    }
}
