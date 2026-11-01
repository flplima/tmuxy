use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Shipped defaults: tmuxy's taste (prefix, status line, bindings, the
/// `@tmuxy-*` appearance options). Mirrored to the data dir on every launch,
/// so a new default reaches everyone with no merge work.
const DEFAULT_DEFAULTS_CONF: &str = include_str!("../../assets/tmuxy.defaults.conf");

/// The settings tmuxy cannot work without — command-aliases plus the handful of
/// tmux options the renderer, the scrollback and the session lifetime depend on.
/// Mirrored like the defaults, and sourced first and last in the chain
/// ([`entry_conf`]): first so the aliases exist before anything binds to them,
/// last so no config can take the app apart.
const DEFAULT_ESSENTIALS_CONF: &str = include_str!("../../assets/tmuxy.essentials.conf");

/// The starter `tmuxy.conf`: comments and examples only, since tmuxy sources
/// its own layers around the user's file. Written to the config dir on the
/// first run, mirrored to the data dir as `tmuxy.conf.example` for
/// `tmuxy config init`, and put back on top of a migrated file whose old
/// header was dropped.
pub(super) const DEFAULT_USER_CONF: &str = include_str!("../../assets/tmuxy.conf");

/// The guide to personalizing tmuxy: every file, who owns it, where it lives,
/// every option. Mirrored to the data dir as `README.md`.
const CONFIG_README: &str = include_str!("../../assets/config-README.md");

/// The file tmux is started with (`-f`) and that every reload re-sources: the
/// chain of layers, built by [`entry_conf`]. In the state dir, not the data
/// dir: it is built from this machine's `use-tmux-conf` choice and this
/// process's config dir, so two processes sharing a data dir (a test server
/// beside the app) would otherwise rewrite it for each other.
const ENTRY_CONF: &str = "tmuxy.entry.conf";

/// A copy of the user's `tmuxy.conf` with an old `source-file …/tmuxy.defaults.conf`
/// line commented out, sourced in its place while the user's file still has
/// one (see [`legacy_defaults_source`]). In the state dir, like the entry
/// file: it is built from the user's file.
const COMPAT_CONF: &str = "tmuxy.compat.conf";

/// The tmux global environment variable naming the data dir, which the entry
/// file sets before it sources anything. The bundled scripts are named by it
/// everywhere tmux runs one — the essentials' command-aliases, the client's
/// script commands, a restored sidebar — as `$TMUXY_DATA_DIR/bin/tmuxy/…`,
/// expanded by tmux's parser (or a pane's shell) from that environment, so a
/// data dir moved by `TMUXY_DATA_DIR` or `XDG_DATA_HOME` moves them all. The
/// same name `paths::data_dir` reads, so a process started in a pane finds
/// the data dir of the server it runs under.
pub const DATA_DIR_ENV: &str = "TMUXY_DATA_DIR";

/// The tmux global environment variable naming the entry file, set beside
/// [`DATA_DIR_ENV`]: what a client's Reload Config sources
/// (`transport::SOURCE_ENTRY_CONF`) where no tmuxy process stands between it
/// and tmux (the in-browser guests). A tmuxy process sources its own path.
pub const ENTRY_CONF_ENV: &str = "TMUXY_ENTRY_CONF";

/// The starter, mirrored for `tmuxy config init`.
const EXAMPLE_CONF: &str = "tmuxy.conf.example";

/// The file `tmuxy config reload` touches in the state dir. Its stamp is part
/// of the conf stamp ([`config_stamps`]), so a reload needs no write into the
/// config dir and works without a `tmuxy.conf` at all.
const RELOAD_MARKER: &str = "config-reload";

/// Resolve the user's tmuxy config directory: $XDG_CONFIG_HOME/tmuxy
/// or $HOME/.config/tmuxy. Does not create the directory.
///
/// We deliberately do NOT use `dirs::config_dir()` because on macOS that
/// returns `~/Library/Application Support`, which surprises users who
/// expect to find their tmuxy config at `~/.config/tmuxy/tmuxy.conf`
/// (the same path as on Linux, the devcontainer, and what every doc/CI
/// path references). The mismatch silently broke first-run config
/// loading on Mac: ensure_config wrote into `~/Library/Application
/// Support/tmuxy/`, the user looked at `~/.config/tmuxy/`, found
/// nothing, and the desktop app got the default tmux prefix because
/// `tmux -f` was never given a config path either way.
pub fn config_dir() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = std::path::PathBuf::from(xdg);
        if xdg.is_absolute() {
            return xdg.join("tmuxy");
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("tmuxy")
}

/// The three directories tmuxy's files live in, split by owner:
///
/// | Dir | Owner | Rule |
/// | --- | --- | --- |
/// | `config` (`~/.config/tmuxy`) | the user | written once, on the first run; safe to symlink |
/// | `data` (`~/.local/share/tmuxy`) | the app | mirrored from the bundle on every launch, never edited |
/// | `state` ([`crate::paths::state_dir`]) | the app | this machine's state: menu choices, the chain built from them, launcher, pid files |
///
/// Everything that reads or writes one of them takes a `Layout`, so a test
/// can point all three at a scratch dir without touching the environment.
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
            data: crate::paths::data_dir(),
            state: crate::paths::state_dir(),
            home: dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
        }
    }

    /// The user's `tmuxy.conf`.
    pub fn user_conf(&self) -> PathBuf {
        self.config.join("tmuxy.conf")
    }

    /// The generated chain tmux is started with.
    pub fn entry_conf(&self) -> PathBuf {
        self.state.join(ENTRY_CONF)
    }

    /// The menu choices ([`ManagedState`]).
    pub fn state_file(&self) -> PathBuf {
        self.state.join("tmuxy.state.json")
    }

    /// The mirrored CLI dispatcher and helper scripts.
    pub fn bin(&self) -> PathBuf {
        self.data.join("bin")
    }

    /// The mirrored built-in themes.
    pub fn builtin_themes(&self) -> PathBuf {
        self.data.join("themes")
    }

    /// The user's own themes, which shadow a built-in of the same name.
    pub fn user_themes(&self) -> PathBuf {
        self.config.join("themes")
    }
}

pub(super) fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Write a file the app mirrors into the data dir, unless it is a symlink.
///
/// The symlink check is the devcontainer workflow: the data dir's confs are
/// symlinked to the repo's checked-in copies so an edit there is live, and
/// writing through the link would rewrite the repo. The file is replaced, not
/// written in place — a new file renamed over the old — so a link is never
/// followed and a reader never sees half a file, and it is left read-only
/// (executable for a script), which is the generated mark a header cannot be.
pub(super) fn write_generated(path: &Path, contents: &str, executable: bool) {
    if is_symlink(path) {
        return;
    }
    if std::fs::read_to_string(path).is_ok_and(|existing| existing == contents) {
        return;
    }
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return;
    };
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", std::process::id()));
    let written = std::fs::write(&tmp, contents).and_then(|()| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if executable { 0o555 } else { 0o444 };
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        std::fs::rename(&tmp, path)
    });
    match written {
        Ok(()) => info!(?path, "refreshed a generated file"),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            warn!(?path, error = %e, "could not write a generated file");
        }
    }
}

/// The header of every generated `.conf` in the data dir. The same for every
/// process that shares the data dir, whatever its config dir, so two of them
/// do not take turns rewriting the mirror.
const CONF_HEADER: &str =
    "# Generated by tmuxy and rewritten on every launch: an edit here is lost.\n\
     # Your overrides go in tmuxy.conf in your config dir (~/.config/tmuxy);\n\
     # `tmuxy config paths` lists every file.\n\n";

/// Mirror the shipped config into the data dir, migrate an older install's
/// config dir, write the starter `tmuxy.conf` on the very first run, and
/// build the chain. Returns the entry file tmux is started with.
///
/// The config dir is the user's: past the first run nothing here writes to
/// it, except the migration's one rewrite of an older `tmuxy.conf` (with a
/// backup beside it). So it can be a symlink into a dotfiles repo.
pub fn ensure_config() -> PathBuf {
    ensure_config_in(&Layout::current())
}

pub(super) fn ensure_config_in(layout: &Layout) -> PathBuf {
    let first_run = std::fs::symlink_metadata(&layout.config).is_err();
    super::migrate::migrate(layout).log();

    if let Err(e) = std::fs::create_dir_all(&layout.data) {
        warn!(dir = ?layout.data, error = %e, "could not create the data dir");
    }
    let header = CONF_HEADER;
    write_generated(
        &layout.data.join("tmuxy.defaults.conf"),
        &format!("{header}{DEFAULT_DEFAULTS_CONF}"),
        false,
    );
    write_generated(
        &layout.data.join("tmuxy.essentials.conf"),
        &format!("{header}{DEFAULT_ESSENTIALS_CONF}"),
        false,
    );
    write_generated(
        &layout.data.join(EXAMPLE_CONF),
        &format!("{header}{DEFAULT_USER_CONF}"),
        false,
    );
    write_generated(
        &layout.data.join("README.md"),
        &format!(
            "<!-- Generated by tmuxy and rewritten on every launch: an edit here is lost. -->\n\n{CONFIG_README}"
        ),
        false,
    );

    if first_run {
        write_starter(layout);
    }
    write_entry(layout)
}

/// The starter `tmuxy.conf`, on the first run only: the config dir did not
/// exist at all — not even as a symlink, dangling or not, which is a
/// dotfiles checkout that is the user's to fill. A user who deletes the file
/// later gets tmuxy's defaults, not the file back.
fn write_starter(layout: &Layout) {
    let path = layout.user_conf();
    if let Err(e) = std::fs::create_dir_all(&layout.config) {
        warn!(dir = ?layout.config, error = %e, "could not create the config dir");
        return;
    }
    if std::fs::symlink_metadata(&path).is_ok() {
        return;
    }
    match std::fs::write(&path, DEFAULT_USER_CONF) {
        Ok(()) => info!(?path, "created tmuxy.conf"),
        Err(e) => warn!(?path, error = %e, "could not write the starter tmuxy.conf"),
    }
}

/// Whether a `tmuxy.conf` line sources the defaults itself, as every
/// `tmuxy.conf` an older build wrote did. The chain sources them now, from the
/// data dir, so the line names a file the migration removed.
pub(super) fn legacy_defaults_source(line: &str) -> bool {
    let line = line.trim();
    let sources = line.starts_with("source-file ") || line.starts_with("source ");
    sources
        && line
            .trim_end_matches(['\'', '"'])
            .ends_with("tmuxy.defaults.conf")
}

/// The user's layer of the chain: their `tmuxy.conf`, or, while it still has
/// a line sourcing the old defaults (a file the migration could not rewrite,
/// such as one symlinked from a dotfiles repo), a generated copy with that
/// line commented out.
fn user_layer(layout: &Layout) -> PathBuf {
    let user = layout.user_conf();
    let compat = layout.state.join(COMPAT_CONF);
    let text = std::fs::read_to_string(&user).unwrap_or_default();
    if !text.lines().any(legacy_defaults_source) {
        if std::fs::symlink_metadata(&compat).is_ok_and(|m| m.is_file()) {
            let _ = std::fs::remove_file(&compat);
        }
        return user;
    }
    let body: String = text
        .lines()
        .map(|line| {
            if legacy_defaults_source(line) {
                format!("# tmuxy sources its defaults itself now: {line}\n")
            } else {
                format!("{line}\n")
            }
        })
        .collect();
    write_generated(
        &compat,
        &format!(
            "# Generated by tmuxy from {}, which still sources the old defaults file;\n\
             # tmuxy sources this copy in its place. Remove that line from your file and\n\
             # this copy goes away.\n\n{body}",
            user.display()
        ),
        false,
    );
    compat
}

/// The chain, in order, after the two paths it publishes ([`DATA_DIR_ENV`],
/// [`ENTRY_CONF_ENV`]) — first, because tmux expands `$TMUXY_DATA_DIR` in an
/// alias when a binding names it, and a file is parsed when it is sourced:
///
/// 1. `tmuxy.essentials.conf` — the command-aliases every binding resolves
///    through, so they exist before anything binds to them.
/// 2. `tmuxy.defaults.conf` — tmuxy's taste.
/// 3. `~/.tmux.conf`, when the user opted in (`use-tmux-conf`).
/// 4. The user's `tmuxy.conf` — their overrides, after `~/.tmux.conf` so the
///    tmuxy-specific file has the last word on taste.
/// 5. `tmuxy.essentials.conf` again — so no config can take the app apart.
fn entry_conf(layout: &Layout, use_tmux_conf: bool, user: &Path) -> String {
    let quote = |path: &Path| crate::executor::tmux_quote(&path.to_string_lossy());
    let essentials = quote(&layout.data.join("tmuxy.essentials.conf"));
    let tmux_conf = if use_tmux_conf {
        format!(
            "source-file -q {}\n",
            quote(&layout.home.join(".tmux.conf"))
        )
    } else {
        "# ~/.tmux.conf is not read: `tmuxy config use-tmux-conf on` sources it here.\n".to_string()
    };
    format!(
        "{header}\
         # Where the scripts and this file are, for the commands that name them.\n\
         set-environment -g {DATA_DIR_ENV} {data}\n\
         set-environment -g {ENTRY_CONF_ENV} {entry}\n\
         # The chain tmux is started with and every reload sources, in order.\n\
         source-file {essentials}\n\
         source-file {defaults}\n\
         {tmux_conf}\
         source-file -q {user}\n\
         source-file {essentials}\n",
        header = CONF_HEADER,
        data = quote(&layout.data),
        entry = quote(&layout.entry_conf()),
        defaults = quote(&layout.data.join("tmuxy.defaults.conf")),
        user = quote(user),
    )
}

/// Regenerate the entry file from the current `use-tmux-conf` choice and the
/// state of the user's file; returns its path.
fn write_entry(layout: &Layout) -> PathBuf {
    if let Err(e) = std::fs::create_dir_all(&layout.state) {
        warn!(dir = ?layout.state, error = %e, "could not create the state dir");
    }
    let use_tmux_conf = super::state::read_managed_state_in(layout)
        .use_tmux_conf
        .unwrap_or(false);
    let user = user_layer(layout);
    let path = layout.entry_conf();
    write_generated(&path, &entry_conf(layout, use_tmux_conf, &user), false);
    path
}

/// The entry file tmux is started with (`-f`) and the monitor sources on
/// every connect and reload, rebuilt first so it follows the user's file and
/// the `use-tmux-conf` choice. `None` when it could not be written.
pub fn get_config_path() -> Option<PathBuf> {
    let path = write_entry(&Layout::current());
    path.exists().then_some(path)
}

/// What the user can edit under the config dir to restyle or reconfigure a
/// running app, reduced to two numbers that change whenever one of those
/// files does: every `*.css` (the themes and `custom.css`) in one, the tmux
/// config in the other (with the marker `tmuxy config reload` touches in the
/// state dir). A poll of these is how both hosts notice an edit, with no
/// file-watching dependency and no interest in which file it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConfigStamps {
    pub css: u128,
    pub conf: u128,
}

fn file_stamp(path: &Path) -> u128 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    modified ^ (u128::from(meta.len()) << 64)
}

pub fn config_stamps() -> ConfigStamps {
    let layout = Layout::current();
    let mut css = file_stamp(&layout.config.join("custom.css"));
    if let Ok(entries) = std::fs::read_dir(layout.user_themes()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("css") {
                css = css.wrapping_add(file_stamp(&path));
            }
        }
    }
    ConfigStamps {
        css,
        conf: file_stamp(&layout.user_conf())
            .wrapping_add(file_stamp(&layout.state.join(RELOAD_MARKER))),
    }
}
