//! The file types tmuxy serves, by extension: the content type each is
//! labelled with, and what a `preview` widget (`crate::preview`) does with it.
//!
//! The bytes have to arrive labelled: an HTML page handed out as `text/plain`
//! renders as source code, and a stylesheet or script with the wrong type is
//! dropped by the strict MIME checks browsers apply to `<link rel=stylesheet>`
//! and module scripts. One table for both uses, so a type a preview may load
//! always has its real label.

/// What a preview does with a file of a type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewUse {
    /// A document a preview shows as a page.
    Html,
    /// A document a preview renders as markdown.
    Markdown,
    /// What a page loads to draw itself: a document may link it.
    Resource,
    /// Merely a file (`.json`, a key): never read for a preview.
    None,
}

/// One file type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileType {
    pub extension: &'static str,
    pub mime: &'static str,
    pub preview: PreviewUse,
}

const fn t(extension: &'static str, mime: &'static str, preview: PreviewUse) -> FileType {
    FileType {
        extension,
        mime,
        preview,
    }
}

/// Every type with a label of its own; anything else is [`PLAIN_TEXT`].
pub const FILE_TYPES: &[FileType] = &[
    t("html", "text/html; charset=utf-8", PreviewUse::Html),
    t("htm", "text/html; charset=utf-8", PreviewUse::Html),
    t("md", "text/markdown; charset=utf-8", PreviewUse::Markdown),
    t(
        "markdown",
        "text/markdown; charset=utf-8",
        PreviewUse::Markdown,
    ),
    t("css", "text/css; charset=utf-8", PreviewUse::Resource),
    t("js", "text/javascript; charset=utf-8", PreviewUse::Resource),
    t(
        "mjs",
        "text/javascript; charset=utf-8",
        PreviewUse::Resource,
    ),
    t("json", "application/json", PreviewUse::None),
    t("map", "application/json", PreviewUse::None),
    t("webmanifest", "application/manifest+json", PreviewUse::None),
    t("png", "image/png", PreviewUse::Resource),
    t("jpg", "image/jpeg", PreviewUse::Resource),
    t("jpeg", "image/jpeg", PreviewUse::Resource),
    t("gif", "image/gif", PreviewUse::Resource),
    t("webp", "image/webp", PreviewUse::Resource),
    t("avif", "image/avif", PreviewUse::Resource),
    t("bmp", "image/bmp", PreviewUse::Resource),
    t("svg", "image/svg+xml", PreviewUse::Resource),
    t("ico", "image/x-icon", PreviewUse::Resource),
    t("woff", "font/woff", PreviewUse::Resource),
    t("woff2", "font/woff2", PreviewUse::Resource),
    t("ttf", "font/ttf", PreviewUse::Resource),
    t("otf", "font/otf", PreviewUse::Resource),
    t("wasm", "application/wasm", PreviewUse::None),
];

/// The label of a type the table does not know.
pub const PLAIN_TEXT: &str = "text/plain; charset=utf-8";

/// The type of a path, from the extension of its last component, any case.
pub fn file_type(path: &str) -> Option<&'static FileType> {
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())?;
    FILE_TYPES.iter().find(|t| t.extension == ext)
}

/// Content type for a path, from its extension. Unknown extensions fall back to
/// UTF-8 plain text.
pub fn content_type_for_path(path: &str) -> &'static str {
    file_type(path).map_or(PLAIN_TEXT, |t| t.mime)
}

/// What a preview does with the file at `path`.
pub fn preview_use(path: &str) -> PreviewUse {
    file_type(path).map_or(PreviewUse::None, |t| t.preview)
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

    /// Every type a preview may load is served with its own label: `.avif`
    /// and `.bmp` were allowed as resources but had no row, so they went out
    /// as `text/plain` and the page drew no image.
    #[test]
    fn every_type_a_preview_loads_has_a_real_label() {
        for t in FILE_TYPES {
            assert_ne!(t.mime, PLAIN_TEXT, "{t:?}");
        }
        assert_eq!(content_type_for_path("a/photo.AVIF"), "image/avif");
        assert_eq!(content_type_for_path("a/old.bmp"), "image/bmp");
        assert_eq!(preview_use("a/old.bmp"), PreviewUse::Resource);
        assert_eq!(preview_use("notes.Markdown"), PreviewUse::Markdown);
        assert_eq!(preview_use("data.json"), PreviewUse::None);
        assert_eq!(preview_use("README"), PreviewUse::None);
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
