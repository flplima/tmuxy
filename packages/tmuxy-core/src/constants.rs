//! Shared constants for tmuxy-core: the `@tmuxy-*` option names, the tmux
//! format strings the monitor sends, and the control-mode event prefixes.
//! Keeping them in one place makes the wire vocabulary obvious at a glance and
//! ensures a typo can't diverge a sender from its reader.
//!
//! The string forms of window kinds are canonical in `WindowType::as_str` /
//! `WindowType::parse` (`lib.rs`), not here.

/// User-option keys tmuxy sets on tmux windows and the global session.
/// All of these are `@tmuxy-*` so they can't collide with vanilla tmux options
/// or with user-installed plugins.
///
/// Use these constants instead of string literals when constructing tmux
/// commands like `set -w @tmuxy-window-type float` or format strings like
/// `#{@tmuxy-window-type}`.
pub mod tmux_options {
    /// Type discriminator, set only on non-tab windows (`float`,
    /// `sidebar-left`, `sidebar-right`). Tabs carry no marker
    /// — an untagged window in the attached session IS a tab. See
    /// [`crate::WindowType`].
    pub const WINDOW_TYPE: &str = "@tmuxy-window-type";

    /// Window ID this float is anchored to.
    pub const FLOAT_PARENT: &str = "@tmuxy-float-parent";
    /// Float dimensions in terminal cells.
    pub const FLOAT_WIDTH: &str = "@tmuxy-float-width";
    pub const FLOAT_HEIGHT: &str = "@tmuxy-float-height";
    /// Drawer attachment edge (`top`/`bottom`/`left`/`right`).
    pub const FLOAT_DRAWER: &str = "@tmuxy-float-drawer";
    /// Backdrop style for the float (currently `dim`/`blur`/none).
    pub const FLOAT_BG: &str = "@tmuxy-float-bg";
    /// `1` to suppress the float's header chrome.
    pub const FLOAT_NOHEADER: &str = "@tmuxy-float-noheader";

    /// Width of a sidebar column in terminal columns, when the user has dragged
    /// it off its default. Set on the sidebar window, so the width is a property
    /// of the column itself — it survives a reload, and every client attached to
    /// the session draws the column at the width tmux actually sized the pane
    /// to. Unset means the default for that side (`sidebar_dock::LEFT_COLS` /
    /// `RIGHT_COLS`).
    pub const SIDEBAR_COLS: &str = "@tmuxy-sidebar-cols";

    /// Window-scoped flag on a sidebar column the user has closed: `1` while
    /// hidden, unset while shown. Closing a column keeps its pane alive (the
    /// dock's shell, the tree's widget), so the window's existence alone can
    /// no longer mean "open" — without this a hidden column came back on every
    /// reload and in every other client.
    pub const SIDEBAR_HIDDEN: &str = "@tmuxy-sidebar-hidden";
    /// `1` while the window keeps only the first-level row that holds the
    /// active pane expanded and collapses the others to one row per pane
    /// (see `layout.rs`). Unset for a normally tiled window.
    pub const COLLAPSIBLE: &str = "@tmuxy-collapsible";
    /// Rows the dock's pane is sized to. The dock runs in the sidebar font,
    /// whose rows are shorter than the pane grid's, so the column holds more
    /// of them than the viewport does; the client sets this from its own row
    /// height. Unset: the viewport's rows.
    pub const SIDEBAR_ROWS: &str = "@tmuxy-sidebar-rows";

    /// Session-scoped one-shot request from a shell helper to move the client's
    /// keyboard focus somewhere the helper cannot reach itself: `left` or
    /// `right` for the matching sidebar column, `panes` to leave one.
    ///
    /// `packages/tmuxy-cli/bin/tmuxy/nav` sets it when a directional `select-pane` is a no-op at
    /// the grid's edge and that edge has an open sidebar. Focusing a sidebar is
    /// a client-side concept — its pane lives in another window, so
    /// `select-pane` would switch the visible tab — which leaves no tmux
    /// command the script could run. The option rides the existing
    /// `list-windows` poll to every client (it is read as a per-window column,
    /// but set at session scope so every row carries it), and the client that
    /// acts on it unsets it.
    pub const FOCUS_REQUEST: &str = "@tmuxy-focus-request";

    /// How a pane says it should be brought back after a session restore
    /// (`tmuxy pane restore-cmd`), read by `session_snapshot`'s own query
    /// rather than the hot-path pane poll: it changes rarely and is only
    /// wanted when a snapshot is taken.
    pub const PANE_RESTORE: &str = "@tmuxy-pane-restore";

    /// Pane-scoped group identity (e.g. `g5`). Set on every member of a pane
    /// group — the visible member (in the attached session) and each hidden
    /// member (parked in the [`crate::constants::STASH_SESSION`]). Panes sharing
    /// a value belong to the same group; membership is intrinsic to the pane and
    /// follows it across a cross-session `swap-pane`, so there is no separate
    /// membership list to keep in sync.
    pub const GROUP_ID: &str = "@tmuxy-group-id";

    /// Pane-scoped position of a member within its group (`0`, `1`, …), set
    /// when the user reorders a group (`tmuxy pane group move`). Members
    /// without one follow those with one, in pane-id order — which is the
    /// whole order of a group nobody has rearranged.
    pub const GROUP_POS: &str = "@tmuxy-group-pos";

    /// Global revision the group scripts bump after a change tmux does not
    /// announce; every pane inherits it, so the monitor's pane-metadata
    /// subscription (`tmux_formats::SUBSCRIBE_PANE_TITLES_CMD`) fires.
    pub const GROUP_REV: &str = "@tmuxy-group-rev";

    /// Pane-scoped state the pane declares about itself (`tmuxy pane state`).
    /// Free-form; the client owns the vocabulary.
    pub const PANE_STATE: &str = "@tmuxy-pane-state";

    /// A name a script gave a pane (`tmuxy pane run --label`), which the CLI
    /// accepts as a target in place of the pane id (`_resolve_target` in the
    /// shell scripts' `_contract`).
    pub const PANE_LABEL: &str = "@tmuxy-label";

    /// Pane-scoped pending confirmation, set by `tmuxy pane send -t` on the pane the
    /// keys are meant for. The value is base64 of a JSON object
    /// (`{token, question, description}`), so the payload survives the
    /// comma-separated `list-panes` format that free text would break.
    /// Unset means no question is pending.
    pub const ASK: &str = "@tmuxy-ask";

    /// Pane-scoped answer to the pending [`ASK`], written by the client the
    /// user answered in and read back by the waiting `tmuxy pane send`. The value is
    /// `<token>:yes` or `<token>:no` — the token pins the answer to the
    /// question that was on screen, so a stale answer to a question already
    /// withdrawn is ignored rather than acted on. Rust never touches it; it is
    /// here for the CLI/core lockstep test in `tmuxy-server/tests/version_skew.rs`.
    pub const ASK_ANSWER: &str = "@tmuxy-ask-answer";

    /// Pane-scoped authorisation for a widget, written by `tmuxy-widget` on the
    /// pane it runs in. The `__TMUXY_WIDGET__:` marker the widget prints is
    /// pane OUTPUT — a crafted file, a commit message in `git log`, an ssh MOTD
    /// — so the marker alone never turns a pane into a widget: the client
    /// honours it only when this option names the same widget.
    pub const PANE_WIDGET: &str = "@tmuxy-pane-widget";

    /// The one file a `preview` pane may read, written by
    /// `tmuxy-widget-preview` out of band and cleared when it exits; honoured
    /// only while [`PANE_WIDGET`] is `preview` (`crate::preview`).
    pub const PANE_PREVIEW: &str = "@tmuxy-pane-preview";

    /// `1` when the preview was opened with `--net`: its page may load from
    /// the network.
    pub const PANE_PREVIEW_NET: &str = "@tmuxy-pane-preview-net";

    /// Active CSS theme name: a file stem under `~/.config/tmuxy/themes/` (the
    /// user's) or a built-in one.
    pub const THEME: &str = "@tmuxy-theme";
    /// Theme mode: `dark` / `light` / `auto` (follow the OS).
    pub const THEME_MODE: &str = "@tmuxy-theme-mode";
    /// `@tmuxy-css-<variable> <value>`: one CSS variable set on the page over
    /// the theme file — see [`crate::theme::CSS_VAR_PREFIX`].
    pub const CSS_VAR_PREFIX: &str = "@tmuxy-css-";

    /// Appearance: background alpha (0.0–1.0) of each surface, on every
    /// platform — see [`crate::theme::Appearance`].
    pub const OPACITY: &str = "@tmuxy-opacity";
    pub const ACTIVE_PANE_OPACITY: &str = "@tmuxy-active-pane-opacity";
    pub const INACTIVE_PANE_OPACITY: &str = "@tmuxy-inactive-pane-opacity";
    pub const ACTIVE_TEXT_OPACITY: &str = "@tmuxy-active-text-opacity";
    pub const INACTIVE_TEXT_OPACITY: &str = "@tmuxy-inactive-text-opacity";
    /// `on`/`off`: native blur behind the window (macOS only; ignored elsewhere).
    pub const BLUR: &str = "@tmuxy-blur";
    /// `on`/`off`: whether the window is see-through at all. Off paints the
    /// chrome and the pane surfaces opaque and clears the blur, leaving the
    /// opacity and blur options as they are for when it goes back on.
    pub const TRANSPARENCY: &str = "@tmuxy-transparency";
    /// `on`/`off`: the UI's layout animations (pane morphs, swaps, resizes,
    /// float keyframes). Off draws every change in place.
    pub const ANIMATIONS: &str = "@tmuxy-animations";
    /// `on`/`off`: whether the cursor blinks. An application that asks for a
    /// specific cursor (DECSCUSR) is still obeyed; this is what happens when
    /// it has not.
    pub const CURSOR_BLINK: &str = "@tmuxy-cursor-blink";
    /// `on`/`off`: whether `tmuxy pane send` into a pane the caller does
    /// not own asks the user there first (`packages/tmuxy-cli/bin/tmuxy/send`).
    pub const SEND_ASK: &str = "@tmuxy-send-ask";
    /// Comma list of caller process names and target pane ids whose sends
    /// skip that question. Read by the CLI alone.
    pub const SEND_ALLOW: &str = "@tmuxy-send-allow";
    /// Integer: how many cards each row of the "all tabs" view holds.
    pub const TAB_OVERVIEW_COLS: &str = "@tmuxy-tab-overview-cols";
    /// `on`/`off`: a two-finger trackpad slide left/right switches tabs.
    pub const GESTURE_SWIPE_TABS: &str = "@tmuxy-gesture-swipe-tabs";
    /// `on`/`off`: pinching out zooms the pane under the fingers, pinching in
    /// unzooms it.
    pub const GESTURE_PINCH_ZOOM: &str = "@tmuxy-gesture-pinch-zoom";
    /// `on`/`off`: pinching in on an unzoomed tab opens the "all tabs" view.
    pub const GESTURE_PINCH_OVERVIEW: &str = "@tmuxy-gesture-pinch-overview";
    /// `on`/`off`: the desktop app draws its menus natively (the macOS menu
    /// bar, native popups everywhere). Off keeps the themed in-app menus.
    pub const NATIVE_MENUS: &str = "@tmuxy-native-menus";
    /// How the session is sized across clients of different viewports:
    /// `smallest` (default), `largest`, `latest`, or a fixed `COLSxROWS` —
    /// see [`crate::client_size::SizePolicy`].
    pub const SIZE: &str = "@tmuxy-size";
}

/// Geometry of the two docked sidebars (`WindowType::SidebarLeft` /
/// `SidebarRight`).
///
/// A sidebar window is NOT sized to the client viewport like tabs and floats
/// are — it is a narrow column docked beside the pane grid, so it gets its own
/// fixed width. Its rows match the viewport exactly: both columns are flex
/// siblings of the pane container and run the full height of the app body, and
/// neither carries a header of its own (the title lives in the app header).
///
/// The widths are mirrored in the frontend (`tmuxy-ui/src/machines/constants.ts`,
/// `LEFT_SIDEBAR_COLS` / `RIGHT_SIDEBAR_COLS`) — each column is drawn at exactly
/// this many cells, so the two sides must agree or the rendered terminal and the
/// tmux pane disagree about where lines wrap.
pub mod sidebar_dock {
    use crate::WindowType;

    /// Width of the left column (the tree widget), in terminal columns.
    pub const LEFT_COLS: u32 = 30;

    /// Width of the right column (the pinned terminal), in terminal columns.
    pub const RIGHT_COLS: u32 = 35;

    /// Narrowest and widest a column may be dragged to. The floor keeps a tree
    /// row or shell prompt legible; the ceiling stops a drag from squeezing the
    /// pane grid down to nothing.
    pub const MIN_COLS: u32 = 16;
    pub const MAX_COLS: u32 = 120;

    /// Column width for a sidebar window of the given type. Returns `None` for
    /// any non-sidebar type, which is sized to the viewport instead.
    ///
    /// `user_cols` is the window's `@tmuxy-sidebar-cols` override, if the user
    /// has dragged the column off its default width.
    pub fn cols(window_type: WindowType, user_cols: Option<u32>) -> Option<u32> {
        let default = match window_type {
            WindowType::SidebarLeft => LEFT_COLS,
            WindowType::SidebarRight => RIGHT_COLS,
            _ => return None,
        };
        Some(user_cols.map_or(default, |c| c.clamp(MIN_COLS, MAX_COLS)))
    }

    /// The tmux size for a sidebar window, given the client's viewport rows.
    pub fn size(
        window_type: WindowType,
        user_cols: Option<u32>,
        client_rows: u32,
    ) -> Option<(u32, u32)> {
        cols(window_type, user_cols).map(|c| (c, client_rows.max(1)))
    }
}

// A macro as well as `STASH_SESSION` so format strings can splice the name in
// with `concat!`, which only accepts literals.
macro_rules! stash_session {
    () => {
        "__tmuxy_stash"
    };
}
pub(crate) use stash_session;

/// The dedicated tmux session tmuxy parks HIDDEN panes in (non-active pane-group
/// members). It is never attached, never shown in any session enumeration, and
/// created lazily by the pane-group shell helpers. Keeping hidden panes here —
/// rather than as extra windows in the attached session — means a native
/// `tmux attach` (or any non-tmuxy client) sees only the user's real tabs, and
/// the attached session's window list maps 1:1 to the tmuxy tab strip.
pub const STASH_SESSION: &str = stash_session!();

pub mod tmux_formats;

/// Control-mode event prefixes emitted by `tmux -CC` on its stdout.
///
/// Each constant matches the literal token tmux writes (including the leading
/// `%`). Use these in `starts_with` / `strip_prefix` checks in
/// `control_mode::parser` instead of repeated string literals — a typo will
/// then be a compile error rather than a silently dropped event.
pub mod control_events {
    pub const BEGIN: &str = "%begin ";
    pub const END: &str = "%end ";
    pub const ERROR: &str = "%error ";
    pub const OUTPUT: &str = "%output ";
    pub const EXTENDED_OUTPUT: &str = "%extended-output ";
    pub const LAYOUT_CHANGE: &str = "%layout-change ";
    pub const WINDOW_ADD: &str = "%window-add ";
    pub const WINDOW_CLOSE: &str = "%window-close ";
    pub const UNLINKED_WINDOW_ADD: &str = "%unlinked-window-add ";
    pub const UNLINKED_WINDOW_CLOSE: &str = "%unlinked-window-close ";
    pub const WINDOW_RENAMED: &str = "%window-renamed ";
    pub const WINDOW_PANE_CHANGED: &str = "%window-pane-changed ";
    pub const PANE_MODE_CHANGED: &str = "%pane-mode-changed ";
    pub const SESSION_CHANGED: &str = "%session-changed ";
    pub const SESSION_RENAMED: &str = "%session-renamed ";
    pub const SESSIONS_CHANGED: &str = "%sessions-changed";
    pub const SESSION_WINDOW_CHANGED: &str = "%session-window-changed ";
    pub const PASTE_BUFFER_CHANGED: &str = "%paste-buffer-changed ";
    pub const SUBSCRIPTION_CHANGED: &str = "%subscription-changed ";
    pub const PAUSE: &str = "%pause ";
    pub const CONTINUE: &str = "%continue ";
    pub const MESSAGE: &str = "%message ";
    pub const EXIT: &str = "%exit";
}

/// Rows of emulator-side scrollback kept per pane.
///
/// This is NOT user-facing history (copy mode fetches that from tmux on
/// demand). It exists so a pane that SHRINKS can push its top rows somewhere
/// and pull them back when it GROWS again — which is what tmux does on
/// reflow. With zero scrollback those rows are destroyed, and the pane renders
/// permanently offset until a capture-pane refill or `clear`. A pane can never
/// grow by more than one screen height, so a couple of hundred rows is ample.
/// The rows are stored without their blank tails (see packages/vt100/PATCHES.md).
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
