//! Every file tmuxy keeps, and the three directories they live in, split by
//! owner:
//!
//! | Dir | Owner | Rule |
//! | --- | --- | --- |
//! | `config` ([`config_dir`], `~/.config/tmuxy`) | the user | written once, on the first run; safe to symlink |
//! | `data` ([`data_dir`], `~/.local/share/tmuxy`) | the app | mirrored from the bundle on every launch, never edited |
//! | `state` ([`state_dir`]) | the app | this machine's state: menu choices, the chain built from them, the trace, snapshots, pid files |
//!
//! [`FILES`] is the one list of what is in them; [`Layout`] resolves an entry
//! to a path, and everything that reads or writes one of them goes through it,
//! so a test can point all three at a scratch dir without touching the
//! environment, and `tmuxy config paths`, the config README and the migration
//! are all checked against the same table.
//!
//! One resolution for every host and every verb, so a `tmuxy trace --mark`
//! stamps the file the server is writing and a test's `TMUXY_STATE_DIR` /
//! `TMUXY_DATA_DIR` moves all of it at once.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The state directory: `TMUXY_STATE_DIR`, else the XDG state dir (macOS has
/// none, so `~/Library/Application Support`), under `tmuxy`. Resolving it
/// creates nothing.
pub fn state_dir() -> PathBuf {
    state_dir_from(std::env::var_os("TMUXY_STATE_DIR"))
}

/// The data directory: `TMUXY_DATA_DIR`, else `$XDG_DATA_HOME/tmuxy`, else
/// `~/.local/share/tmuxy` — on every OS, macOS included, as [`config_dir`]
/// does: tmux's `source-file` and `run-shell` name these
/// files by path, so the path is the same on every machine (an AppImage's
/// mount point is not), and an agent or a `grep` finds them where the XDG
/// layout says. Resolving it creates nothing.
pub fn data_dir() -> PathBuf {
    data_dir_from(
        std::env::var_os("TMUXY_DATA_DIR"),
        std::env::var_os("XDG_DATA_HOME"),
        dirs::home_dir(),
    )
}

/// The user's config directory: `$XDG_CONFIG_HOME/tmuxy`, else
/// `~/.config/tmuxy`. Resolving it creates nothing.
///
/// Not `dirs::config_dir()`: on macOS that is `~/Library/Application
/// Support`, where nobody looks for a `tmuxy.conf` — the docs, the CLI and
/// every other OS say `~/.config/tmuxy`, and a first-run config written there
/// left the desktop app with tmux's default prefix.
pub fn config_dir() -> PathBuf {
    config_dir_from(std::env::var_os("XDG_CONFIG_HOME"))
}

/// An absolute home directory even when `$HOME` is unset: `dirs::home_dir()`
/// (`$HOME`, else the passwd entry's), else a private per-UID
/// `/tmp/tmuxy-<uid>` that must be a real `0700` directory this user owns.
/// The CLI resolves the same way (`_tmuxy_home` in
/// `tmuxy-cli/bin/tmuxy/_lib`). When even that is refused (a symlink or
/// another user's directory squats the name), the result is `/`, which no
/// other user can write under, rather than any shared temp path.
pub fn resolved_home_dir() -> PathBuf {
    dirs::home_dir()
        .filter(|p| p.is_absolute())
        .unwrap_or_else(fallback_home)
}

#[cfg(unix)]
fn fallback_home() -> PathBuf {
    // SAFETY: getuid() has no preconditions.
    let uid = unsafe { libc::getuid() };
    private_uid_dir(std::path::Path::new("/tmp"), uid).unwrap_or_else(|_| PathBuf::from("/"))
}

#[cfg(not(unix))]
fn fallback_home() -> PathBuf {
    std::env::temp_dir().join("tmuxy-home")
}

/// `<base>/tmuxy-<uid>`, created `0700` if missing, and refused unless it is
/// a directory (not a symlink) that `uid` owns. `base` is sticky `/tmp`, so
/// once checked it cannot be swapped by another user.
#[cfg(unix)]
fn private_uid_dir(base: &std::path::Path, uid: u32) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let dir = base.join(format!("tmuxy-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(&dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != uid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "unsafe fallback home directory",
        ));
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}

/// The file the action trace is written to (docs/TRACING.md), unless
/// `--trace <path>` names another.
pub fn trace_file() -> PathBuf {
    state_dir().join(TRACE.name)
}

/// The desktop app's log file ([`LOG`]).
pub fn log_file() -> PathBuf {
    state_dir().join(LOG.name)
}

/// [`config_dir`] as a function of `XDG_CONFIG_HOME`. A relative one is
/// ignored, as the XDG spec says it must be.
fn config_dir_from(xdg_config_home: Option<OsString>) -> PathBuf {
    xdg_config_home
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| resolved_home_dir().join(".config"))
        .join("tmuxy")
}

/// The state directory with no `TMUXY_STATE_DIR` override: where a tmuxy
/// started from the user's own session keeps its state.
pub fn default_state_dir() -> PathBuf {
    state_dir_from(None)
}

/// [`state_dir`] as a function of the override, so the rule is testable
/// without touching the process environment.
fn state_dir_from(override_dir: Option<OsString>) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(|| resolved_home_dir().join(".local").join("state"))
        .join("tmuxy")
}

/// [`data_dir`] as a function of its inputs. A relative `XDG_DATA_HOME` is
/// ignored, as the XDG spec says it must be.
fn data_dir_from(
    override_dir: Option<OsString>,
    xdg_data_home: Option<OsString>,
    home: Option<PathBuf>,
) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    if let Some(xdg) = xdg_data_home.map(PathBuf::from).filter(|p| p.is_absolute()) {
        return xdg.join("tmuxy");
    }
    home.filter(|p| p.is_absolute())
        .unwrap_or_else(resolved_home_dir)
        .join(".local")
        .join("share")
        .join("tmuxy")
}

/// A plugin manifest's file name, at a plugin's root and in the config dir
/// for the user's own ([`USER_PLUGIN_MANIFEST`]).
pub const PLUGIN_MANIFEST_FILE: &str = "tmuxy-plugin.toml";

/// The CLI dispatcher's name in the data dir's `bin/`.
pub const CLI_DISPATCHER: &str = "tmuxy-cli";

/// Which of the three directories a file lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir {
    Config,
    Data,
    State,
}

impl Dir {
    pub fn as_str(self) -> &'static str {
        match self {
            Dir::Config => "config",
            Dir::Data => "data",
            Dir::State => "state",
        }
    }

    /// Only the config dir is the user's: theirs to edit and to symlink.
    pub fn owner(self) -> &'static str {
        match self {
            Dir::Config => "user",
            Dir::Data | Dir::State => "tmuxy",
        }
    }
}

/// One file (or, with a trailing `/`, directory) tmuxy keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct File {
    pub dir: Dir,
    /// The path under [`File::dir`].
    pub name: &'static str,
    /// Whether a person may edit it by hand. Every config file is; of tmuxy's
    /// own, only the two the app reads back as plain JSON.
    pub safe_to_edit: bool,
    pub about: &'static str,
}

impl File {
    const fn config(name: &'static str, about: &'static str) -> Self {
        Self {
            dir: Dir::Config,
            name,
            safe_to_edit: true,
            about,
        }
    }
    const fn data(name: &'static str, about: &'static str) -> Self {
        Self {
            dir: Dir::Data,
            name,
            safe_to_edit: false,
            about,
        }
    }
    const fn state(name: &'static str, safe_to_edit: bool, about: &'static str) -> Self {
        Self {
            dir: Dir::State,
            name,
            safe_to_edit,
            about,
        }
    }

    pub fn safe_to_symlink(&self) -> bool {
        self.dir == Dir::Config
    }
}

pub const USER_CONF: File = File::config(
    "tmuxy.conf",
    "Your overrides; tmuxy sources its defaults before it and its essentials after it.",
);
pub const CUSTOM_CSS: File = File::config("custom.css", "Your CSS, loaded last.");
pub const USER_THEMES: File = File::config(
    "themes/",
    "Your themes; a built-in's name replaces that built-in.",
);
pub const USER_ICONS: File =
    File::config("icons/", "SVG icons an @tmuxy-icon-<process> option names.");
pub const USER_PLUGIN_MANIFEST: File = File::config(
    PLUGIN_MANIFEST_FILE,
    "Your own actions and verbs: the `user` plugin, re-read by `tmuxy config reload`.",
);
pub const LOCKFILE: File = File::config(
    "plugins.json",
    "The plugins installed and their commits; `tmuxy plugin install` writes it and installs what it lists.",
);
pub const PLUGIN_CONFIG: File = File::config(
    "plugins/",
    "Each plugin's own config (TMUXY_PLUGIN_CONFIG_DIR); kept on update and on remove unless --purge.",
);
pub const DEFAULTS_CONF: File = File::data(
    "tmuxy.defaults.conf",
    "tmuxy's taste: prefix, status line, bindings, the @tmuxy-* defaults.",
);
pub const ESSENTIALS_CONF: File = File::data(
    "tmuxy.essentials.conf",
    "The settings tmuxy cannot work without, sourced first and last.",
);
pub const EXAMPLE_CONF: File = File::data(
    "tmuxy.conf.example",
    "The starter tmuxy.conf; `tmuxy config init` copies it.",
);
pub const BUILTIN_THEMES: File = File::data("themes/", "The built-in themes, to read or copy.");
pub const BIN: File = File::data("bin/", "The tmuxy CLI and its helper scripts.");
pub const README: File = File::data("README.md", "The guide to these files.");
pub const ENTRY_CONF: File = File::state(
    "tmuxy.entry.conf",
    false,
    "The chain tmux starts with, built from your files and this machine's choices.",
);
pub const COMPAT_CONF: File = File::state(
    "tmuxy.compat.conf",
    false,
    "Only while your tmuxy.conf still sources the old defaults: a copy without that line.",
);
pub const STATE_FILE: File = File::state(
    "tmuxy.state.json",
    false,
    "Choices made in the app's menus.",
);
pub const SERVERS: File = File::state(
    "servers.json",
    true,
    "The servers `tmuxy session connect` saved.",
);
pub const TRACE_PREFS: File = File::state("trace.json", true, "The Debug menu's trace switch.");
pub const TRACE: File = File::state(
    "trace.ndjson",
    false,
    "The action trace, when tracing is on (docs/TRACING.md).",
);
pub const LOG: File = File::state(
    "tmuxy.log",
    false,
    "The desktop app's log, for a bug report (Help > Reveal Log File).",
);
pub const LAUNCHER: File = File::state(
    "launcher",
    false,
    "The desktop app the ~/.local/bin/tmuxy shorthand runs.",
);
pub const PID: File = File::state(
    "tmuxy.pid",
    false,
    "The running web server's pid (tmuxy-<port>.pid on another port).",
);
pub const RELOAD_MARKER: File =
    File::state("config-reload", false, "Touched by `tmuxy config reload`.");
pub const PLUGINS_STATE: File = File::state(
    "plugins/",
    false,
    "Plugin checkouts (<name>@<commit>), their logs and state, launch tokens.",
);
pub const SESSIONS: File = File::state(
    "sessions/",
    false,
    "Session snapshots, per tmux socket, that a restart restores.",
);
pub const PUSH: File = File::state(
    "push/",
    false,
    "The web server's push key and the devices subscribed to notifications.",
);

/// Every file tmuxy reads or writes: what `tmuxy config paths` prints and the
/// config README's table lists.
pub const FILES: &[File] = &[
    USER_CONF,
    CUSTOM_CSS,
    USER_THEMES,
    USER_ICONS,
    USER_PLUGIN_MANIFEST,
    LOCKFILE,
    PLUGIN_CONFIG,
    DEFAULTS_CONF,
    ESSENTIALS_CONF,
    EXAMPLE_CONF,
    BUILTIN_THEMES,
    BIN,
    README,
    ENTRY_CONF,
    COMPAT_CONF,
    STATE_FILE,
    SERVERS,
    TRACE_PREFS,
    TRACE,
    LOG,
    LAUNCHER,
    PID,
    RELOAD_MARKER,
    PLUGINS_STATE,
    SESSIONS,
    PUSH,
];

/// The three directories, resolved, and the home the user's `~/.tmux.conf`
/// and `~/.local/bin` are under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub config: PathBuf,
    pub data: PathBuf,
    pub state: PathBuf,
    pub home: PathBuf,
}

impl Layout {
    /// The directories this process resolves from its environment.
    pub fn current() -> Self {
        Self {
            config: config_dir(),
            data: data_dir(),
            state: state_dir(),
            home: resolved_home_dir(),
        }
    }

    pub fn dir(&self, dir: Dir) -> &Path {
        match dir {
            Dir::Config => &self.config,
            Dir::Data => &self.data,
            Dir::State => &self.state,
        }
    }

    /// Where `file` is under this layout.
    pub fn path(&self, file: &File) -> PathBuf {
        self.dir(file.dir).join(file.name.trim_end_matches('/'))
    }

    pub fn user_conf(&self) -> PathBuf {
        self.path(&USER_CONF)
    }

    pub fn user_plugin_manifest(&self) -> PathBuf {
        self.path(&USER_PLUGIN_MANIFEST)
    }

    pub fn user_themes(&self) -> PathBuf {
        self.path(&USER_THEMES)
    }

    pub fn entry_conf(&self) -> PathBuf {
        self.path(&ENTRY_CONF)
    }

    pub fn state_file(&self) -> PathBuf {
        self.path(&STATE_FILE)
    }

    pub fn bin(&self) -> PathBuf {
        self.path(&BIN)
    }

    pub fn builtin_themes(&self) -> PathBuf {
        self.path(&BUILTIN_THEMES)
    }

    /// The mirrored CLI dispatcher (`<data>/bin/tmuxy-cli`).
    pub fn cli(&self) -> PathBuf {
        self.bin().join(CLI_DISPATCHER)
    }

    /// The lockfile (`plugins.json`).
    pub fn lockfile(&self) -> PathBuf {
        self.path(&LOCKFILE)
    }

    /// `<state>/plugins`: every checkout, plus `.staging` and `.run`.
    pub fn plugins_root(&self) -> PathBuf {
        self.path(&PLUGINS_STATE)
    }

    /// The checkout of plugin `name` at `sha`.
    pub fn checkout(&self, name: &str, sha: &str) -> PathBuf {
        self.plugins_root().join(format!("{name}@{sha}"))
    }

    /// Where a plugin fetch lands before its manifest is read and the user
    /// says yes.
    pub fn staging(&self) -> PathBuf {
        self.plugins_root().join(".staging")
    }

    /// Plugin invocation tokens, emptied when a server starts.
    pub fn run_dir(&self) -> PathBuf {
        self.plugins_root().join(".run")
    }

    /// `TMUXY_PLUGIN_CONFIG_DIR`: the plugin's user config and credentials.
    /// Survives updates, and `remove` unless `--purge`.
    pub fn plugin_config(&self, name: &str) -> PathBuf {
        self.path(&PLUGIN_CONFIG).join(name)
    }

    /// `TMUXY_PLUGIN_STATE_DIR`: caches and the log.
    pub fn plugin_state(&self, name: &str) -> PathBuf {
        self.plugins_root().join(format!("{name}.state"))
    }

    /// What `tmuxy config paths --json` prints: the three directories and
    /// every file of [`FILES`] with its owner, location and whether it exists.
    pub fn report(&self) -> serde_json::Value {
        let files: Vec<serde_json::Value> = FILES
            .iter()
            .map(|f| {
                let path = self.path(f);
                serde_json::json!({
                    "name": f.name,
                    "dir": f.dir,
                    "path": path,
                    "owner": f.dir.owner(),
                    "safeToEdit": f.safe_to_edit,
                    "safeToSymlink": f.safe_to_symlink(),
                    "exists": std::fs::symlink_metadata(&path).is_ok(),
                    "about": f.about,
                })
            })
            .collect();
        serde_json::json!({
            "dirs": { "config": self.config, "data": self.data, "state": self.state },
            "files": files,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
