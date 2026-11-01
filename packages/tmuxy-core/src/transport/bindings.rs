use std::collections::HashMap;
use std::time::Duration;

use crate::control_mode::{MonitorCommandSender, StoredImage, MAX_CLIPBOARD_BYTES};
use crate::executor::tmux_quote;
use crate::{CommandError, PaneId};

use super::{query, run};

// ============================================
// Images and the clipboard
// ============================================

/// The most a single pane's images may hold in memory.
///
/// A pane used to accumulate images forever: the store is only swept when the
/// PANE goes away, and nothing retires an image whose placement was replaced.
/// That is survivable while an image means a picture someone `icat`ed, and is
/// not for a program that redraws a picture several times a second — the same
/// anchor, a new image id each time, so the placements stay at one while the
/// bytes behind them grow without limit.
///
/// Generous on purpose: this is a backstop against a stream, not a budget for
/// ordinary use. A pane full of distinct pictures in its scrollback stays
/// whole, and a stream at 30KB a frame has room for several hundred frames
/// before the oldest is dropped.
pub const MAX_PANE_IMAGE_BYTES: usize = 24 * 1024 * 1024;

/// Decoded picture bytes keyed by `(pane id, image id)`, served back to the
/// client by `/api/images` (web) or the `tmuxyimg:` scheme (desktop).
#[derive(Debug, Default)]
pub struct ImageStore {
    pub(super) images: HashMap<(PaneId, u32), StoredImage>,
}

impl ImageStore {
    /// Keep a pane's new pictures, then drop its oldest until it is back
    /// under [`MAX_PANE_IMAGE_BYTES`].
    pub fn insert(&mut self, pane_id: &PaneId, images: Vec<(u32, StoredImage)>) {
        for (id, img) in images {
            self.images.insert((pane_id.clone(), id), img);
        }
        self.trim_pane(pane_id);
    }

    /// Forget every picture of a pane that is no longer in `state`. Called
    /// on a full state, the one update that names every live pane.
    pub fn retain_live_panes(&mut self, state: &crate::TmuxState) {
        let live: std::collections::HashSet<&PaneId> =
            state.panes.iter().map(|p| &p.tmux_id).collect();
        self.images.retain(|(pane_id, _), _| live.contains(pane_id));
    }

    pub fn get(&self, pane_id: &PaneId, id: u32) -> Option<&StoredImage> {
        self.images.get(&(pane_id.clone(), id))
    }

    /// Drop a pane's oldest images until it is back under the cap.
    ///
    /// Oldest by image id, which the core assigns increasing per pane, so the
    /// one dropped first is the one least likely to still be placed on screen.
    /// An image whose placement is live is only dropped if a pane is holding
    /// 24MB of newer images, in which case the alternative was unbounded
    /// growth.
    fn trim_pane(&mut self, pane_id: &PaneId) {
        let mut ids: Vec<(u32, usize)> = self
            .images
            .iter()
            .filter(|((pane, _), _)| pane == pane_id)
            .map(|((_, id), img)| (*id, img.data.len()))
            .collect();
        let mut total: usize = ids.iter().map(|(_, len)| *len).sum();
        if total <= MAX_PANE_IMAGE_BYTES {
            return;
        }
        ids.sort_unstable_by_key(|(id, _)| *id);
        for (id, len) in ids {
            if total <= MAX_PANE_IMAGE_BYTES {
                break;
            }
            if self.images.remove(&(pane_id.clone(), id)).is_some() {
                total = total.saturating_sub(len);
            }
        }
    }
}

/// Whether a clipboard write may be handed to the client.
///
/// The aggregator already caps both producers — an OSC 52 write and a
/// paste-buffer mirror — at `MAX_CLIPBOARD_BYTES`; the server and the desktop
/// check again here, where the text leaves the process, so a new producer of
/// `WriteClipboard` cannot slip past the cap.
pub fn clipboard_write_allowed(text: &str) -> bool {
    text.len() <= MAX_CLIPBOARD_BYTES
}

// ============================================
// Key bindings
// ============================================

/// One binding of a key table, as `list-keys` prints it
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KeyBinding {
    pub key: String,
    pub command: String,
    pub description: String,
    /// Whether this binding has the `-r` (repeat) flag.
    /// Repeat bindings auto-re-enter prefix mode after execution.
    #[serde(default)]
    pub repeat: bool,
}

/// Parse `tmux list-keys -T <table>` output into `KeyBinding`s.
///
/// One parser for every table — the prefix and root paths used to carry
/// separate copies, and the root copy computed the `-r` indices but then
/// hardcoded `repeat: false`, silently losing repeat bindings.
pub(crate) fn parse_bindings(table: &str, output: &str) -> Vec<KeyBinding> {
    let mut bindings = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();

        // tmux list-keys output format:
        //   bind-key    -T <table> KEY command...
        //   bind-key -r -T <table> KEY command...
        // The -r flag shifts all subsequent indices by 1.
        let (key_idx, cmd_idx, is_repeat) = if parts.len() >= 6
            && parts[0] == "bind-key"
            && parts[1] == "-r"
            && parts[3] == table
        {
            (4, 5, true)
        } else if parts.len() >= 5 && parts[0] == "bind-key" && parts[2] == table {
            (3, 4, false)
        } else {
            continue;
        };

        if cmd_idx >= parts.len() {
            continue;
        }

        let bound_key = parts[key_idx];

        // Unescape the key
        let key = if bound_key.starts_with('\\') && bound_key.len() == 2 {
            bound_key[1..].to_string()
        } else {
            bound_key.to_string()
        };

        // Get the command (everything after the key)
        let command = parts[cmd_idx..].join(" ");
        let description = describe_binding(parts[cmd_idx], &command);

        bindings.push(KeyBinding {
            key,
            command,
            description,
            repeat: is_repeat,
        });
    }

    bindings
}

/// Human description for the common commands the menus surface.
fn describe_binding(command_name: &str, command: &str) -> String {
    match command_name {
        "split-window" => {
            if command.contains("-h") {
                "Split pane vertically".to_string()
            } else {
                "Split pane horizontally".to_string()
            }
        }
        "resize-pane" => {
            if command.contains("-Z") {
                "Toggle pane fullscreen".to_string()
            } else {
                "Resize pane".to_string()
            }
        }
        "select-pane" => "Select pane".to_string(),
        "last-pane" => "Switch to last active pane".to_string(),
        "next-layout" => "Cycle through pane layouts".to_string(),
        "break-pane" => "Convert pane to window".to_string(),
        "copy-mode" => "Enter copy mode".to_string(),
        "command-prompt" => "Enter command mode".to_string(),
        "new-window" => "Create new window".to_string(),
        "kill-window" => "Close window".to_string(),
        "next-window" => "Next window".to_string(),
        "previous-window" => "Previous window".to_string(),
        "select-window" => "Select window".to_string(),
        _ => command.to_string(),
    }
}

/// The prefix key and the key tables, as the client's keyboard handling reads
/// them. The wire shape of the SSE `keybindings` frame and the desktop's
/// `tmux-keybindings` event.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KeyBindings {
    pub prefix_key: String,
    pub prefix_bindings: Vec<KeyBinding>,
    pub root_bindings: Vec<KeyBinding>,
    /// Every other table a binding can enter with `switch-client -T` — the
    /// sticky PANE and TAB modes among them — by name. tmux's own copy-mode
    /// tables are left out: copy mode is the client's.
    #[serde(default)]
    pub tables: std::collections::BTreeMap<String, Vec<KeyBinding>>,
}

/// Tables `KeyBindings::tables` leaves out: the two it has fields for, and
/// copy mode's, which the client handles itself.
const UNLISTED_TABLES: [&str; 4] = ["prefix", "root", "copy-mode", "copy-mode-vi"];

/// The table a `list-keys` line binds in, whether or not it carries `-r`.
fn binding_table(line: &str) -> Option<&str> {
    let mut parts = line.split_whitespace();
    if parts.next() != Some("bind-key") {
        return None;
    }
    let mut next = parts.next()?;
    if next == "-r" {
        next = parts.next()?;
    }
    if next != "-T" {
        return None;
    }
    parts.next()
}

/// tmux's own prefix, for a server that answers nothing.
const DEFAULT_PREFIX: &str = "C-b";

impl KeyBindings {
    /// Read the live bindings in one round trip. A server that cannot answer
    /// yields tmux's defaults (prefix `C-b`, no tables) rather than an error:
    /// the client keeps working, and the next refresh corrects it.
    pub async fn read(tx: &MonitorCommandSender) -> Self {
        // Every table in one list: asking for a table by name is an error when
        // it does not exist, and an error ends the command list.
        match query(tx, "show-options -gv prefix ; list-keys").await {
            Ok(output) => Self::parse(&output),
            Err(e) => {
                tracing::warn!(error = %e, "could not read key bindings");
                Self::parse("")
            }
        }
    }

    /// The first line is the prefix (`show-options -gv`); the tables follow,
    /// each line naming its own table.
    pub(super) fn parse(output: &str) -> Self {
        let prefix_key = output
            .lines()
            .next()
            .map(str::trim)
            .filter(|p| !p.is_empty() && !p.starts_with("bind-key"))
            .unwrap_or(DEFAULT_PREFIX)
            .to_string();
        let names: std::collections::BTreeSet<&str> = output
            .lines()
            .filter_map(binding_table)
            .filter(|table| !UNLISTED_TABLES.contains(table))
            .collect();
        Self {
            prefix_key,
            prefix_bindings: parse_bindings("prefix", output),
            root_bindings: parse_bindings("root", output),
            tables: names
                .into_iter()
                .map(|name| (name.to_string(), parse_bindings(name, output)))
                .collect(),
        }
    }
}

/// Whether a client command sources a config, which may change the prefix,
/// the bindings, the theme and the appearance options — so both transports
/// push fresh copies of each after it.
pub fn is_source_file(command: &str) -> bool {
    let command = command.trim_start();
    command.starts_with("source-file") || command.starts_with("source ")
}

/// How long to wait after a `source-file` before re-reading what it changed.
///
/// The reads ride the same connection as the `source-file`, so tmux answers
/// them after it and everything it ran inline. The wait covers what a config
/// starts in the background (`run-shell -b`, hooks).
pub const SOURCE_FILE_SETTLE: Duration = Duration::from_millis(200);

/// Source the config chain — the defaults, the user's `tmuxy.conf`, the
/// essentials — over the control-mode connection, put the menu choices the
/// file does not pin back on top (the defaults just reset them), and wait for
/// it to settle, as a client's own `source-file` would. The caller then
/// pushes what a config can change — the bindings, the theme and appearance
/// settings — exactly as it does after that client command.
pub async fn source_config(tx: &MonitorCommandSender) -> Result<(), CommandError> {
    let Some(path) = crate::session::get_config_path() else {
        return Err(CommandError::unavailable(
            "the tmuxy config chain could not be written",
        ));
    };
    run(
        tx,
        &format!("source-file {}", tmux_quote(&path.to_string_lossy())),
    )
    .await?;
    for cmd in crate::session::current_managed_state_commands() {
        run(tx, &cmd).await?;
    }
    tokio::time::sleep(SOURCE_FILE_SETTLE).await;
    Ok(())
}

// ============================================
// The config directory
// ============================================

/// What changed under the config dir, from [`watch_config`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigChange {
    /// A theme file or `custom.css`: clients re-fetch their stylesheets.
    Css,
    /// `tmuxy.conf`: the host sources it and pushes the settings it changed.
    Conf,
}

/// How often the config dir is looked at. A save shows within this.
pub const CONFIG_POLL: Duration = Duration::from_secs(1);

/// Watch the config dir for the user's edits, forever: `on_change` is called
/// once per poll for each kind of file that changed since the last one. A
/// poll of a few file stamps (`session::config_stamps`) rather than a
/// native watcher, so both hosts behave the same on every platform.
pub async fn watch_config(mut on_change: impl FnMut(ConfigChange)) {
    let mut last = crate::session::config_stamps();
    let mut tick = tokio::time::interval(CONFIG_POLL);
    loop {
        tick.tick().await;
        let now = crate::session::config_stamps();
        if now.css != last.css {
            on_change(ConfigChange::Css);
        }
        if now.conf != last.conf {
            on_change(ConfigChange::Conf);
        }
        last = now;
    }
}
