//! What a host does once, before it serves anything: the web server before
//! it binds, the desktop app before its first window.

use std::path::{Path, PathBuf};

use crate::tmux_check::TmuxCheckError;

/// Where [`prepare`] laid the config out, and the tmux it found.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub config: PathBuf,
    pub themes: PathBuf,
    pub bin: PathBuf,
    pub tmux_version: String,
    /// What the user's `tmuxy.conf` would fail on, one line each, and how
    /// to fix it (`session::config_warnings`): a `source-file` of a file
    /// that is not there stops tmux reading the chain. Logged here; the
    /// host that has a terminal prints them too.
    pub config_warnings: Vec<String>,
}

/// Get the process ready to serve tmux.
///
/// PATH is fixed first, while nothing else runs: every tmux and script this
/// process starts inherits it, and a `setenv` beside a `getenv` on another
/// thread is undefined behaviour. A missing or too old tmux stops the host
/// with the reason, rather than serve clients that would reconnect for ever
/// to a monitor that cannot attach.
pub fn prepare() -> Result<Prepared, TmuxCheckError> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let current = std::env::var("PATH").unwrap_or_default();
        if let Some(path) = gui_path(&current, home.as_deref()) {
            std::env::set_var("PATH", &path);
            tracing::info!(%path, "put the tool directories on PATH");
        }
    }
    let tmux_version = crate::tmux_check::check_tmux()?;
    tracing::info!(tmux = %crate::session::tmux_path(), version = %tmux_version, "tmux found");
    let config = crate::session::ensure_config();
    let themes = crate::session::ensure_themes();
    let bin = crate::session::ensure_bin_scripts();
    let config_warnings = crate::session::config_warnings(&crate::paths::Layout::current());
    for warning in &config_warnings {
        tracing::warn!("config: {warning}");
    }
    crate::plugins::gc::on_start();
    tracing::info!(
        config = %config.display(),
        themes = %themes.display(),
        bin = %bin.display(),
        "config layout"
    );
    Ok(Prepared {
        config,
        themes,
        bin,
        tmux_version,
        config_warnings,
    })
}

/// `current` with the directories a macOS app started by launchd (Finder,
/// the Dock, Spotlight) lacks prepended: its PATH is only
/// `/usr/bin:/bin:/usr/sbin:/sbin`, without Homebrew's (tmux, and the tools a
/// pane's shell expects) or `~/.local/bin` (the `tmuxy` launcher). `None`
/// when nothing is missing.
pub fn gui_path(current: &str, home: Option<&Path>) -> Option<String> {
    let local_bin = home.map(|h| h.join(".local/bin").to_string_lossy().into_owned());
    let missing: Vec<&str> = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
        .into_iter()
        .chain(local_bin.as_deref())
        .filter(|dir| !current.split(':').any(|seg| seg == *dir))
        .collect();
    if missing.is_empty() {
        return None;
    }
    Some(if current.is_empty() {
        missing.join(":")
    } else {
        format!("{}:{current}", missing.join(":"))
    })
}

#[cfg(test)]
mod tests {
    use super::gui_path;
    use std::path::Path;

    #[test]
    fn a_launchd_path_gets_the_tool_directories_in_front() {
        assert_eq!(
            gui_path("/usr/bin:/bin", Some(Path::new("/Users/u"))).as_deref(),
            Some("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/u/.local/bin:/usr/bin:/bin")
        );
    }

    #[test]
    fn a_path_that_has_them_is_left_alone() {
        let full = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/h/.local/bin:/usr/bin";
        assert_eq!(gui_path(full, Some(Path::new("/h"))), None);
        assert_eq!(
            gui_path("", None).as_deref(),
            Some("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin")
        );
    }
}
