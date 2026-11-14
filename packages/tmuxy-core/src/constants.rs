/// The name prefix of a sidebar window (`__sidebar-left`, `__sidebar-right`):
/// how a sidebar left without its `@tmuxy-window-type` tag is recognised. The
/// client names the windows it creates with it (`SIDEBAR_WINDOW_NAME` in
/// tmuxy-ui's `domain/commands.ts`, from the generated constants).
pub const SIDEBAR_WINDOW_PREFIX: &str = "__sidebar-";

/// The buffer the client stages a paste in (generated into the UI's
/// `tmuxyConstants.gen.ts`). A staging buffer is never a yank,
/// so the aggregator never mirrors it to the clipboard.
pub const PASTE_BUFFER: &str = "tmuxy-paste";

/// `tmuxy pane paste`'s staging buffers: this prefix and the CLI's PID.
pub const CLI_PASTE_BUFFER_PREFIX: &str = "tmuxy-cli-paste-";

/// The schemes a link a pane printed may be opened with
/// (`host::command::is_openable_url`, and the client's `isOpenableUrl`).
pub const OPENABLE_URL_SCHEMES: [&str; 3] = ["http://", "https://", "mailto:"];

/// The characters, past controls and whitespace, an openable link may not
/// hold: the ones a URL must percent-encode, so an opener that reads it as
/// text finds nothing to parse in it.
pub const URL_FORBIDDEN_CHARS: [char; 10] = ['"', '\'', '<', '>', '^', '`', '{', '}', '|', '\\'];

pub mod tmux_options;

/// What `tmuxy-widget` prints at the top of its pane, followed by the widget's
/// name, for the client to draw that widget there (when
/// [`tmux_options::PANE_WIDGET`] agrees). Generated into the UI and the CLI.
pub const WIDGET_MARKER: &str = "__TMUXY_WIDGET__:";

/// The lines `tmuxy-widget-preview` prints for the client's preview (the
/// UI's `domain/preview.ts`): the page keeps its own colours, the file's
/// name, and a value that changes with the file. Generated into the UI and
/// the CLI.
pub mod preview_lines {
    pub const NO_THEME: &str = "__NO_THEME__";
    pub const FILE: &str = "__FILE__:";
    pub const REV: &str = "__REV__:";
}

/// The port `tmuxy server` listens on when given none, and the one the dev
/// loop's Vite serves on behind it (`tmuxy-server --dev`, the desktop app's
/// `devUrl`). Generated into the CLI; the configs that name them are held to
/// them by `tests/dev_ports.rs`.
pub const DEFAULT_SERVER_PORT: u16 = 9000;
pub const DEV_VITE_PORT: u16 = 9001;

pub mod float_grid;

pub mod sidebar_dock;

/// The tmux session tmuxy parks HIDDEN pane-group members in, created lazily
/// by the pane-group shell helpers and never attached or listed. Keeping them
/// out of the attached session means a native `tmux attach` sees only the
/// user's real tabs.
pub const STASH_SESSION: &str = "__tmuxy_stash";

pub mod tmux_formats;

pub mod control_events;

/// Rows of emulator-side scrollback kept per pane.
///
/// NOT user-facing history (copy mode fetches that from tmux). A pane that
/// SHRINKS pushes its top rows here and pulls them back when it GROWS, as tmux
/// does on reflow; with none, the pane renders offset until a capture-pane
/// refill or `clear`. A pane never grows by more than one screen height. Rows
/// are stored without their blank tails (packages/vt100/PATCHES.md).
pub const REFLOW_SCROLLBACK_ROWS: usize = 256;

/// How far into history a pane keeps its image placements, in rows, so the
/// scroll and copy views can still draw a picture that scrolled off the
/// screen. Bounded because a placement is held per pane for its whole life.
pub const IMAGE_HISTORY_ROWS: usize = 2000;

/// Shells, by the basename of argv[0] (or tmux's `pane_current_command`).
const SHELLS: [&str; 12] = [
    "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh",
];

/// Whether a command names a shell. A login shell announces itself with a
/// leading `-` (`-zsh`), which is stripped before the comparison.
pub fn is_shell_name(command: &str) -> bool {
    let base = command.trim_start_matches('-');
    let base = base.rsplit('/').next().unwrap_or(base);
    SHELLS.contains(&base)
}

#[cfg(test)]
mod tests;
