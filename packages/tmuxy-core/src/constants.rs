//! Shared constants for tmuxy-core.
//!
//! Centralises the magic strings that previously appeared scattered across
//! `monitor.rs`, `state.rs`, `parser.rs`, and `executor.rs`. Splitting them out
//! makes the wire vocabulary obvious at a glance and ensures a typo can't
//! diverge a sender from its reader.
//!
//! The high-level types live in this module — the lower-level enums for window
//! kinds (already typed) live in `lib.rs::WindowType`. The string forms of
//! `WindowType` continue to be canonical via `WindowType::as_str` /
//! `WindowType::parse`; this module just re-exports the kebab spellings for
//! consumers (e.g. the tmux options module) that need the literal value
//! independent of the enum.

/// User-option keys tmuxy sets on tmux windows and the global session.
/// All of these are `@tmuxy-*` so they can't collide with vanilla tmux options
/// or with user-installed plugins.
///
/// Use these constants instead of string literals when constructing tmux
/// commands like `set -w @tmuxy-window-type float` or format strings like
/// `#{@tmuxy-window-type}`.
pub mod tmux_options {
    /// Type discriminator, set only on non-tab windows (`float`,
    /// `float-backdrop`, `sidebar-left`, `sidebar-right`). Tabs carry no marker
    /// — an untagged window in the attached session IS a tab. See
    /// [`crate::WindowType`].
    pub const WINDOW_TYPE: &str = "@tmuxy-window-type";

    /// Window ID this float/backdrop is anchored to.
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

    /// Session-scoped one-shot request from a shell helper to move the client's
    /// keyboard focus somewhere the helper cannot reach itself: `left` or
    /// `right` for the matching sidebar column, `panes` to leave one.
    ///
    /// `bin/tmuxy/nav` sets it when a directional `select-pane` is a no-op at
    /// the grid's edge and that edge has an open sidebar. Focusing a sidebar is
    /// a client-side concept — its pane lives in another window, so
    /// `select-pane` would switch the visible tab — which leaves no tmux
    /// command the script could run. The option rides the existing
    /// `list-windows` poll to every client (it is read as a per-window column,
    /// but set at session scope so every row carries it), and the client that
    /// acts on it unsets it.
    pub const FOCUS_REQUEST: &str = "@tmuxy-focus-request";

    /// Pane-scoped group identity (e.g. `g5`). Set on every member of a pane
    /// group — the visible member (in the attached session) and each hidden
    /// member (parked in the [`crate::constants::STASH_SESSION`]). Panes sharing
    /// a value belong to the same group; membership is intrinsic to the pane and
    /// follows it across a cross-session `swap-pane`, so there is no separate
    /// membership list to keep in sync.
    pub const GROUP_ID: &str = "@tmuxy-group-id";

    /// Active CSS theme name (file stem under `~/.config/tmuxy/themes/`).
    pub const THEME: &str = "@tmuxy-theme";
    /// Theme mode: `dark` / `light`.
    pub const THEME_MODE: &str = "@tmuxy-theme-mode";

    /// Appearance: background alpha (0.0–1.0) of each surface, on every
    /// platform — see [`crate::theme::Appearance`].
    pub const OPACITY: &str = "@tmuxy-opacity";
    pub const ACTIVE_PANE_OPACITY: &str = "@tmuxy-active-pane-opacity";
    pub const INACTIVE_PANE_OPACITY: &str = "@tmuxy-inactive-pane-opacity";
    pub const ACTIVE_TEXT_OPACITY: &str = "@tmuxy-active-text-opacity";
    pub const INACTIVE_TEXT_OPACITY: &str = "@tmuxy-inactive-text-opacity";
    /// `on`/`off`: native blur behind the window (macOS only; ignored elsewhere).
    pub const BLUR: &str = "@tmuxy-blur";
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

/// The dedicated tmux session tmuxy parks HIDDEN panes in (non-active pane-group
/// members). It is never attached, never shown in any session enumeration, and
/// created lazily by the pane-group shell helpers. Keeping hidden panes here —
/// rather than as extra windows in the attached session — means a native
/// `tmux attach` (or any non-tmuxy client) sees only the user's real tabs, and
/// the attached session's window list maps 1:1 to the tmuxy tab strip.
pub const STASH_SESSION: &str = "__tmuxy_stash";

/// Compile-time format strings the monitor passes to `list-windows -F` and
/// `list-panes -F`. Both forms appear verbatim in multiple places; sharing the
/// constants ensures the parser (`StateAggregator::process_event`) only ever
/// has to handle one column layout.
pub mod tmux_formats {
    /// `list-windows -F '<...>'` format, comma-separated. `#{window_name}` is
    /// free text (a name like `build, test` contains commas), so it is placed
    /// LAST — the parser splits the fixed fields off the front and takes the
    /// remainder as the name, so its commas can't shift any field. (A tab
    /// delimiter would be cleaner but the v86 serial console mangles tabs; all
    /// other fields — ids, numbers, enums, space-joined pane ids — are
    /// comma-free.)
    pub const LIST_WINDOWS_CMD: &str = concat!(
        "list-windows -F '",
        "#{window_id},#{window_index},#{window_active},#{@tmuxy-window-type},",
        "#{@tmuxy-float-parent},#{@tmuxy-float-width},#{@tmuxy-float-height},",
        "#{@tmuxy-float-drawer},#{@tmuxy-float-bg},#{@tmuxy-float-noheader},",
        "#{@tmuxy-focus-request},#{@tmuxy-sidebar-cols},#{@tmuxy-sidebar-hidden},",
        "#{window_zoomed_flag},#{window_name}'",
    );

    /// The application-set pane title, with tmux's own default filtered out.
    ///
    /// tmux seeds every pane's title with the host name, so `#{pane_title}` is
    /// non-empty even when no application ever emitted an OSC 0/2 title.
    /// Comparing against `#{host}` inside tmux (rather than shipping the host
    /// name to every client to compare there) makes the field EMPTY for "no app
    /// title" — which is what lets the UI fall back to the process name. Both
    /// values come from the same `gethostname()`, so the seed always matches.
    /// Expands to ONE field: the comparison's own comma is consumed by tmux,
    /// never emitted.
    ///
    /// Deliberately free of shell metacharacters — `||`, `$`, parens and the
    /// rest. The sidebar's sessions poll sends a format built from this through
    /// the server's `run_tmux_command`, whose `is_readonly_query` guard
    /// (`tmuxy-server/src/sse.rs`) rejects any command carrying one, and a
    /// rejected poll silently returns no rows.
    ///
    /// A macro rather than a `const` because `concat!` only accepts literals.
    macro_rules! app_pane_title {
        () => {
            "#{?#{==:#{pane_title},#{host}},,#{pane_title}}"
        };
    }

    /// See [`app_pane_title!`].
    pub const APP_PANE_TITLE: &str = app_pane_title!();

    /// `list-panes -s -F '<...>'` format. The session-scope flag (`-s`) is
    /// included so the monitor never accidentally drops to window scope.
    /// `#{@tmuxy-group-id}` rides in the fixed tail (non-free-text: `g<digits>`
    /// or empty) so it can't collide with the two free-text fields.
    pub const LIST_PANES_CMD: &str = concat!(
        "list-panes -s -F '",
        "#{pane_id},#{pane_index},",
        "#{pane_left},#{pane_top},",
        "#{pane_width},#{pane_height},",
        "#{cursor_x},#{cursor_y},",
        "#{pane_active},#{pane_current_command},",
        app_pane_title!(),
        ",",
        "#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},",
        "#{scroll_position},",
        "#{window_id},#{T:pane-border-format},",
        "#{alternate_on},#{mouse_any_flag},",
        "#{selection_present},",
        "#{selection_start_x},#{selection_start_y},#{history_size},#{@tmuxy-group-id}'",
    );

    /// Enumerates the HIDDEN pane-group members parked in
    /// [`super::STASH_SESSION`]. Each row is prefixed with the literal
    /// `stashmember,` sentinel so the response parser routes it to the
    /// stash-member handler instead of the active-session pane/window parsers —
    /// the fields carry only what a group tab strip needs (id, its stash window,
    /// group id, command, title). `pane_title` is last so its own commas stay in
    /// the trailing field. A server-wide `-a` scan filtered to the stash session
    /// by `-f` returns EMPTY (not an error) when the stash session doesn't exist
    /// yet — which is the common case on every refresh before any group is made,
    /// so it must not spam `%error` responses.
    pub const LIST_STASH_PANES_CMD: &str = concat!(
        "list-panes -a -f '#{==:#{session_name},__tmuxy_stash}' -F '",
        "stashmember,#{pane_id},#{window_id},#{@tmuxy-group-id},",
        "#{pane_current_command},",
        app_pane_title!(),
        "'",
    );
}

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
    pub const PAUSE: &str = "%pause ";
    pub const CONTINUE: &str = "%continue ";
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
pub const REFLOW_SCROLLBACK_ROWS: usize = 256;

#[cfg(test)]
mod tests {
    use super::*;

    /// The module's stated purpose is "a typo can't diverge a sender from its
    /// reader" — but `concat!` can't interpolate consts, so the format
    /// strings repeat the option names as literals. This test is the
    /// lockstep guard: every `@tmuxy-*` option must appear verbatim in the
    /// list-windows format the parser consumes.
    #[test]
    fn list_windows_cmd_embeds_every_float_option() {
        for option in [
            tmux_options::WINDOW_TYPE,
            tmux_options::FLOAT_PARENT,
            tmux_options::FLOAT_WIDTH,
            tmux_options::FLOAT_HEIGHT,
            tmux_options::FLOAT_DRAWER,
            tmux_options::FLOAT_BG,
            tmux_options::FLOAT_NOHEADER,
        ] {
            assert!(
                tmux_formats::LIST_WINDOWS_CMD.contains(&format!("#{{{option}}}")),
                "LIST_WINDOWS_CMD is missing #{{{option}}} — the format string \
                 and the tmux_options constant have diverged"
            );
        }
    }

    /// Both pane enumerations must ask for the HOST-FILTERED title, never a
    /// bare `#{pane_title}`: the raw field is seeded with the host name, so a
    /// client reading it can't tell "the app set this" from "tmux did", and the
    /// pane header would show a host name instead of falling back to the
    /// process name.
    #[test]
    fn list_panes_cmds_ask_for_the_app_set_title() {
        for (name, cmd) in [
            ("LIST_PANES_CMD", tmux_formats::LIST_PANES_CMD),
            ("LIST_STASH_PANES_CMD", tmux_formats::LIST_STASH_PANES_CMD),
        ] {
            assert!(
                cmd.contains(tmux_formats::APP_PANE_TITLE),
                "{name} must request APP_PANE_TITLE, not a bare #{{pane_title}}"
            );
            assert_eq!(
                cmd.matches("#{pane_title}").count(),
                tmux_formats::APP_PANE_TITLE
                    .matches("#{pane_title}")
                    .count(),
                "{name} has a #{{pane_title}} outside APP_PANE_TITLE"
            );
        }
    }

    /// The group id rides in the pane format now (pane-scoped), and the stash
    /// enumeration must carry it too — same lockstep guard against a divergent
    /// literal.
    #[test]
    fn list_panes_cmds_embed_group_id() {
        let opt = tmux_options::GROUP_ID;
        assert!(
            tmux_formats::LIST_PANES_CMD.contains(&format!("#{{{opt}}}")),
            "LIST_PANES_CMD is missing #{{{opt}}}"
        );
        assert!(
            tmux_formats::LIST_STASH_PANES_CMD.contains(&format!("#{{{opt}}}")),
            "LIST_STASH_PANES_CMD is missing #{{{opt}}}"
        );
        assert!(
            tmux_formats::LIST_STASH_PANES_CMD.contains(STASH_SESSION),
            "LIST_STASH_PANES_CMD must target the stash session by name"
        );
    }
}
