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
    /// `float-backdrop`, `sidebar`). Tabs carry no marker — an untagged window
    /// in the attached session IS a tab. See [`crate::WindowType`].
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
        "#{window_zoomed_flag},#{window_name}'",
    );

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
        "#{pane_active},#{pane_current_command},#{pane_title},",
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
        "#{pane_current_command},#{pane_title}'",
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
