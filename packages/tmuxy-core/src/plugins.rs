//! Plugins: third-party (and the user's own) actions and CLI verbs declared
//! in a `tmuxy-plugin.toml` (docs/PLUGINS.md).
//!
//! The trust boundary is the install gate (`tmuxy plugin install`, in the
//! server crate): a plugin's commands run unsandboxed as the user, with the
//! tmux socket, so nothing here claims to confine them. What this module
//! guarantees instead is that nothing a plugin ships runs before the user said
//! yes (the hardened fetch in [`fetch`]), that every command it declares
//! resolves inside its own directory ([`registry::resolve_command`]), and that
//! data reaching a plugin (a selection, a pane's cwd) travels in a file or in
//! JSON, never on a shell or tmux command line ([`invoke`]).
//!
//! | Piece | Where |
//! | --- | --- |
//! | the manifest | [`manifest`] |
//! | what is installed, at which commit | [`lockfile`] (`<config_dir>/plugins.json`) |
//! | the checkouts, one per pinned commit | `<state_dir>/plugins/<name>@<sha>/` ([`crate::paths::Layout::checkout`]) |
//! | what the UI shows | [`inventory`] (`@tmuxy-plugins`, `@tmuxy-plugins-rev`) |
//! | running an action | [`invoke`] |

pub mod fetch;
pub mod gc;
pub mod index;
pub mod inventory;
pub mod invoke;
pub mod job;
pub mod keys;
pub mod links;
pub mod lockfile;
pub mod log;
pub mod manifest;
pub mod registry;
pub mod scaffold;
pub mod settings;
pub mod source;
pub mod themes;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_invoke;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_links;

use std::path::Path;

use crate::paths::Layout;

/// The manifest's file name, at a plugin's root.
pub use crate::paths::PLUGIN_MANIFEST_FILE as MANIFEST_FILE;

/// The plugin a user's own `<config_dir>/tmuxy-plugin.toml` is: installed by
/// nobody, gated by nothing, its commands relative to the config dir.
pub const USER_PLUGIN: &str = "user";

/// The plugin API this build implements (`[plugin] api`).
pub const API_VERSION: u32 = 1;

/// This build's version, which a manifest's `min_tmuxy` is compared with.
pub const TMUXY_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `tmuxy plugin`'s own subcommands: a plugin's `[[cli]]` verb, which runs
/// as `tmuxy plugin <verb>`, may not be one of them. The server crate's
/// tests hold this list to its clap subcommands.
pub const RESERVED_VERBS: &[&str] = &[
    "install", "list", "update", "remove", "action", "log", "check", "new", "config", "path",
    "search", "exec", "publish", "help",
];

/// A plugin, action or verb name: lowercase ASCII letters, digits and `-`,
/// starting with a letter or digit, at most 40 long. Names reach tmux and
/// shell command lines (`tmuxy plugin exec <name> <id> <token>`), where this
/// alphabet needs no quoting.
pub fn is_valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && bytes[0] != b'-'
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// A full 40-hex commit id.
pub fn is_sha(sha: &str) -> bool {
    sha.len() == 40
        && sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// The platform this build runs on, as a manifest names it.
pub fn current_platform() -> manifest::Platform {
    if cfg!(target_os = "macos") {
        manifest::Platform::Macos
    } else {
        manifest::Platform::Linux
    }
}

/// `x.y.z` as numbers; a pre-release or build suffix is ignored.
pub fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let core = version
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Whether this build is at least `min` (`min_tmuxy`).
pub fn satisfies_min_tmuxy(min: &str) -> bool {
    match (parse_version(TMUXY_VERSION), parse_version(min)) {
        (Some(have), Some(want)) => have >= want,
        _ => false,
    }
}

/// An error from the plugin machinery, phrased for the person at the CLI.
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("git {step} failed: {message}")]
    Git { step: String, message: String },
}

impl PluginError {
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        PluginError::Io {
            context: context.into(),
            source,
        }
    }

    /// The CLI contract's exit code (`bin/tmuxy/_contract`): 3 for a name
    /// that names nothing, 1 for everything else.
    pub fn exit_code(&self) -> i32 {
        match self {
            PluginError::NotFound(_) => 3,
            _ => 1,
        }
    }
}

pub type Result<T> = std::result::Result<T, PluginError>;

/// Create `dir` owner-only, with what it says on failure.
pub(crate) fn private_dir(dir: &Path) -> Result<()> {
    crate::private_files::create_dir_all(dir)
        .map_err(|e| PluginError::io(format!("creating {}", dir.display()), e))
}

/// 32 random hex digits, from the OS.
pub(crate) fn random_hex() -> Result<String> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| PluginError::io("reading /dev/urandom", e))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// After plugins changed (install, update, remove): publish the inventory,
/// bind and unbind plugin keys, and ask every running app to reload its
/// config, which is how its clients get the new key bindings
/// (`docs/DATA-FLOW.md`: bindings reach a client at connect and on a
/// reload). With no tmux server there is nothing to do: the next server to
/// attach does all of it.
pub fn refresh(dirs: &Layout) {
    inventory::publish(dirs);
    let _ = keys::apply(dirs);
    request_reload(dirs);
}

/// What `tmuxy config reload` does: touch the marker every app watches.
pub fn request_reload(dirs: &Layout) {
    let marker = dirs.path(&crate::paths::RELOAD_MARKER);
    if private_dir(&dirs.state).is_err() {
        return;
    }
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&marker)
    {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
}
