//! `[[themes]]`: stylesheets a plugin adds to the theme menu, a third
//! source after the built-ins and the user's own `themes/`.
//!
//! A plugin theme is named `<plugin>__<id>`, which no built-in or plugin
//! name can be (they hold no `_`), so a user's or a built-in theme of the
//! same name always wins. Its file must canonicalize inside the plugin and
//! stay under a size cap. A theme is a capability: its CSS runs in the
//! app's own document and can hide anything, `@tmuxy-ask` included, so the
//! install gate lists it.

use std::path::PathBuf;

use super::registry::Registry;
use crate::paths::Layout;

pub const MAX_THEME_BYTES: u64 = 512 * 1024;

pub fn theme_name(plugin: &str, id: &str) -> String {
    format!("{plugin}__{id}")
}

/// Every plugin theme on this platform whose file is usable: name and file.
pub fn list(dirs: &Layout) -> Vec<(String, PathBuf)> {
    let Ok(registry) = Registry::load(dirs) else {
        return Vec::new();
    };
    registry
        .plugins
        .iter()
        .filter(|p| p.manifest.runs_here())
        .flat_map(|p| {
            p.manifest.themes.iter().filter_map(|t| {
                let root = p.root.canonicalize().ok()?;
                let file = root.join(&t.file).canonicalize().ok()?;
                let meta = std::fs::metadata(&file).ok()?;
                let usable =
                    file.starts_with(&root) && meta.is_file() && meta.len() <= MAX_THEME_BYTES;
                usable.then(|| (theme_name(&p.name, &t.id), file))
            })
        })
        .collect()
}

pub fn css(dirs: &Layout, name: &str) -> Option<Vec<u8>> {
    if !name.contains("__") {
        return None;
    }
    let (_, file) = list(dirs).into_iter().find(|(n, _)| n == name)?;
    std::fs::read(file).ok()
}

/// A stylesheet the client asked for by its path (`themes/<name>.css`,
/// `custom.css`), as both transports serve it: the user's and the built-in
/// ones (`session::resolve_user_css`), then a plugin's theme.
pub fn resolve_css(path: &str) -> Option<Vec<u8>> {
    crate::session::resolve_user_css(path).or_else(|| {
        let name = path
            .trim_start_matches('/')
            .strip_prefix("themes/")?
            .strip_suffix(".css")?;
        crate::session::is_safe_css_name(name)
            .then(|| css(&Layout::current(), name))
            .flatten()
    })
}
