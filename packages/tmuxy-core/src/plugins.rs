//! Plugins: third-party (and the user's own) actions and CLI verbs declared
//! in a `tmuxy-plugin.toml` (docs/PLUGINS.md).
//!
//! The trust boundary is the install gate (`tmuxy plugin install`, in
//! `tmuxy-verbs`): a plugin's commands run unsandboxed as the user, with the
//! tmux socket, so nothing here claims to confine them. What this module
//! guarantees instead is that nothing a plugin ships runs before the user said
//! yes (the hardened fetch in [`fetch`]), that every command it declares
//! resolves inside its own directory ([`registry::resolve_command`]), and that
//! data reaching a plugin (a selection, a pane's cwd) travels in a file or in
//! JSON, never on a shell or tmux command line ([`invoke`]).
//!
//! | Piece | Where |
//! | --- | --- |
//! | what is installed, at which commit | `<config_dir>/plugins.json` ([`lockfile`]) |
//! | the checkouts, one per pinned commit | `<state_dir>/plugins/<name>@<sha>/` |
//! | what the UI shows | `@tmuxy-plugins`, `@tmuxy-plugins-rev` ([`inventory`]) |

pub mod fetch;
pub mod gc;
pub mod index;
pub mod inventory;
pub mod invoke;
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

pub use crate::paths::PLUGIN_MANIFEST_FILE as MANIFEST_FILE;

/// The plugin a user's own `<config_dir>/tmuxy-plugin.toml` is: installed by
/// nobody, gated by nothing, its commands relative to the config dir.
pub const USER_PLUGIN: &str = "user";

/// The plugin API this build implements (`[plugin] api`, docs/PLUGIN-API.md).
pub const API_VERSION: u32 = 1;

/// What a manifest's `min_tmuxy` is compared with.
pub const TMUXY_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `tmuxy plugin`'s own subcommands: a plugin's `[[cli]]` verb, which runs
/// as `tmuxy plugin <verb>`, may not be one of them. `tmuxy-verbs`' tests
/// hold this list to its clap subcommands.
pub const RESERVED_VERBS: &[&str] = &[
    "install", "list", "update", "remove", "action", "log", "check", "new", "config", "path",
    "search", "exec", "help",
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

/// A full 40-hex commit id, lowercase.
pub fn is_sha(sha: &str) -> bool {
    sha.len() == 40
        && sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

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

/// `false` when either version does not parse.
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
    /// No tmux server answered on the socket.
    #[error("no tmux server: {0}")]
    NoServer(String),
}

impl From<crate::TmuxError> for PluginError {
    fn from(e: crate::TmuxError) -> Self {
        let message = e.to_string();
        if crate::session::is_no_server(&message) {
            PluginError::NoServer(message)
        } else {
            PluginError::Invalid(message)
        }
    }
}

impl From<crate::run_shell::RunShellError> for PluginError {
    fn from(e: crate::run_shell::RunShellError) -> Self {
        match e {
            crate::run_shell::RunShellError::NoServer(message) => PluginError::NoServer(message),
            other => PluginError::Invalid(other.to_string()),
        }
    }
}

impl PluginError {
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        PluginError::Io {
            context: context.into(),
            source,
        }
    }

    /// The CLI contract's exit code (`bin/tmuxy/_contract`): 3 for a name
    /// that names nothing, 4 for no tmux server, 1 for everything else.
    pub fn exit_code(&self) -> i32 {
        match self {
            PluginError::NotFound(_) => 3,
            PluginError::NoServer(_) => 4,
            _ => 1,
        }
    }
}

pub type Result<T> = std::result::Result<T, PluginError>;

pub(crate) fn private_dir(dir: &Path) -> Result<()> {
    crate::private_files::create_dir_all(dir)
        .map_err(|e| PluginError::io(format!("creating {}", dir.display()), e))
}

/// 32 random hex digits.
pub(crate) fn random_hex() -> Result<String> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| PluginError::io("reading /dev/urandom", e))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// After plugins changed (install, update, remove). The running apps are
/// asked to reload their config because bindings reach a client only at
/// connect and on a reload (docs/DATA-FLOW.md). With no tmux server there is
/// nothing to do: the next server to attach does all of it. The change itself
/// is made by then, so a step that fails is reported and the others still run.
pub fn refresh(dirs: &Layout) {
    if let Err(e) = inventory::publish(dirs) {
        tracing::warn!(error = %e, "could not publish the plugin inventory");
    }
    match keys::apply(dirs) {
        Ok(_) | Err(PluginError::NoServer(_)) => {}
        Err(e) => tracing::warn!(error = %e, "could not bind the plugin keys"),
    }
    if let Err(e) = crate::session::request_reload(dirs) {
        tracing::warn!(error = %e, "could not ask the running apps to reload");
    }
}
