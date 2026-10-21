//! Compile-time format strings the monitor passes to `list-windows -F` and
//! `list-panes -F`. Both forms appear verbatim in multiple places; sharing the
//! constants ensures the parser (`StateAggregator::process_event`) only ever
//! has to handle one column layout.

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
    "#{@tmuxy-collapsible},#{window_zoomed_flag},#{@tmuxy-sidebar-rows},#{window_name}'",
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
/// The sidebar's sessions poll builds its own format from the same
/// expression (`serversActor.ts`) and reads the rows back through
/// `query_tmux`.
///
/// A macro rather than a `const` because `concat!` only accepts literals.
macro_rules! app_pane_title {
    () => {
        "#{?#{==:#{pane_title},#{host}},,#{pane_title}}"
    };
}

/// See [`app_pane_title!`].
pub const APP_PANE_TITLE: &str = app_pane_title!();

/// Is the pane in tmux's COPY mode — as opposed to any of its other modes?
///
/// `#{pane_in_mode}` is 1 for every pane mode tmux has: copy-mode, but also
/// view-mode, tree-mode, buffer-mode and client-mode. The client turns that
/// flag into its own copy mode, which renders the scrollback and hides the
/// live terminal — so a pane tmux merely put in view-mode disappeared
/// behind a scrollback view that nothing would close. tmux 3.4 is where
/// this showed up (a freshly created pane comes up in `view-mode` there,
/// and the pane rendered as a 0x0 box forever), but the conflation was
/// wrong on every version: `prefix s` and friends could do the same.
///
/// Still expands to exactly one int-like field, so the pane-row parser's
/// field positions and its `@window` anchor heuristic are unchanged.
macro_rules! copy_mode_flag {
    () => {
        "#{?#{==:#{pane_mode},copy-mode},1,0}"
    };
}

/// See [`copy_mode_flag!`].
pub const COPY_MODE_FLAG: &str = copy_mode_flag!();

/// What a comma inside a field is sent as, so a row always has exactly one
/// field per column. tmux's `s/,/%2C/` modifier applies it on the way out and
/// [`unescape_commas`] undoes it on the way in. Only `list-panes -F` output
/// is parsed this way; `display-message -p` strips the `%`.
pub const COMMA_ESCAPE: &str = "%2C";

/// A field back from [`COMMA_ESCAPE`].
pub fn unescape_commas(field: &str) -> String {
    field.replace(COMMA_ESCAPE, ",")
}

/// A tmux variable whose value is free text, comma-escaped.
macro_rules! escaped_var {
    ($name:literal) => {
        concat!("#{s/,/%2C/:", $name, "}")
    };
}

/// A nested tmux format whose expansion is free text, comma-escaped.
macro_rules! escaped_format {
    ($fmt:expr) => {
        concat!("#{s/,/%2C/:", $fmt, "}")
    };
}

/// The columns of a pane row, once: each name is the index the parser reads a
/// field at, each format is what tmux expands into that field, and
/// [`LIST_PANES_CMD`] is built from the same list — so the command and the
/// parser cannot disagree about which column is which. A column whose value
/// is free text (a title, a border, a process name, a shell line) is
/// comma-escaped, so a row always has [`PaneColumn::COUNT`] fields and a
/// comma in a title cannot shift the fields after it.
macro_rules! pane_columns {
    ($($name:ident => $fmt:expr,)+) => {
        /// A column of a `list-panes` row, in the order tmux prints them.
        /// `column as usize` is its index in the split row.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum PaneColumn { $($name,)+ }

        impl PaneColumn {
            /// How many fields a row has.
            pub const COUNT: usize = [$(stringify!($name),)+].len();

            /// Where this column's field sits in the comma-split row.
            pub const fn index(self) -> usize {
                self as usize
            }
        }

        /// Each column's tmux format, in [`PaneColumn`] order.
        pub const PANE_COLUMNS: [&str; PaneColumn::COUNT] = [$($fmt,)+];
    };
}

pane_columns! {
    PaneId => "#{pane_id}",
    PaneIndex => "#{pane_index}",
    Left => "#{pane_left}",
    Top => "#{pane_top}",
    Width => "#{pane_width}",
    Height => "#{pane_height}",
    CursorX => "#{cursor_x}",
    CursorY => "#{cursor_y}",
    Active => "#{pane_active}",
    Command => escaped_var!("pane_current_command"),
    Title => escaped_format!(app_pane_title!()),
    CopyMode => copy_mode_flag!(),
    CopyCursorX => "#{copy_cursor_x}",
    CopyCursorY => "#{copy_cursor_y}",
    ScrollPosition => "#{scroll_position}",
    WindowId => "#{window_id}",
    BorderTitle => escaped_format!("#{T:pane-border-format}"),
    AlternateOn => "#{alternate_on}",
    MouseAnyFlag => "#{mouse_any_flag}",
    Marked => "#{pane_marked}",
    SelectionPresent => "#{selection_present}",
    SelectionStartX => "#{selection_start_x}",
    SelectionStartY => "#{selection_start_y}",
    HistorySize => "#{history_size}",
    // The `@tmuxy-*` options are tmuxy's own and never free text: a group id
    // is `g<digits>`, a question is base64 precisely so its commas cannot
    // shift the fields around it.
    GroupId => "#{@tmuxy-group-id}",
    GroupPos => "#{@tmuxy-group-pos}",
    PaneState => "#{@tmuxy-pane-state}",
    Ask => "#{@tmuxy-ask}",
    Widget => "#{@tmuxy-pane-widget}",
    Restore => escaped_var!("@tmuxy-pane-restore"),
}

const LIST_PANES_PREFIX: &str = "list-panes -s -F '";
const LIST_PANES_SUFFIX: &str = "'";

/// The length of [`LIST_PANES_CMD`]: the prefix and suffix, every column, and
/// a comma between each pair of columns.
const fn list_panes_cmd_len() -> usize {
    let mut len = LIST_PANES_PREFIX.len() + LIST_PANES_SUFFIX.len() + PANE_COLUMNS.len() - 1;
    let mut column = 0;
    while column < PANE_COLUMNS.len() {
        len += PANE_COLUMNS[column].len();
        column += 1;
    }
    len
}

/// [`LIST_PANES_CMD`] as bytes, assembled at compile time: `concat!` takes
/// literals only, and the columns are a table.
const fn list_panes_cmd_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    let mut at = 0;
    let mut part = LIST_PANES_PREFIX.as_bytes();
    let mut i = 0;
    while i < part.len() {
        out[at] = part[i];
        at += 1;
        i += 1;
    }
    let mut column = 0;
    while column < PANE_COLUMNS.len() {
        if column > 0 {
            out[at] = b',';
            at += 1;
        }
        part = PANE_COLUMNS[column].as_bytes();
        i = 0;
        while i < part.len() {
            out[at] = part[i];
            at += 1;
            i += 1;
        }
        column += 1;
    }
    part = LIST_PANES_SUFFIX.as_bytes();
    i = 0;
    while i < part.len() {
        out[at] = part[i];
        at += 1;
        i += 1;
    }
    out
}

const LIST_PANES_CMD_BYTES: [u8; list_panes_cmd_len()] = list_panes_cmd_bytes();

/// `list-panes -s -F '<every PaneColumn, comma-separated>'`. The session-scope
/// flag (`-s`) is included so the monitor never accidentally drops to window
/// scope.
pub const LIST_PANES_CMD: &str = match std::str::from_utf8(&LIST_PANES_CMD_BYTES) {
    Ok(cmd) => cmd,
    Err(_) => panic!("the pane column formats are ASCII"),
};

// A macro as well as the const below so the subscription command can
// splice the name in with `concat!`, which only accepts literals.
macro_rules! pane_title_subscription_name {
    () => {
        "tmuxy-pane-meta"
    };
}

/// The control-mode subscription that reports pane metadata tmux does not
/// announce on its own.
///
/// tmux sends no notification when a title changes — `select-pane -T` from
/// a script or `tmuxy run`, or a program's OSC 0/2 — nor when a group's
/// membership or order changes by option alone, so these used to wait for
/// the idle heartbeat (15 s). A subscription is checked by tmux about once
/// a second and answered with `%subscription-changed`, whatever made the
/// change (tmux 3.2+; `%*` is every pane of every window). The group
/// scripts bump the global `@tmuxy-group-rev`, which every pane inherits,
/// so a reorder among hidden members is seen too.
pub const PANE_TITLE_SUBSCRIPTION_NAME: &str = pane_title_subscription_name!();
/// See [`PANE_TITLE_SUBSCRIPTION_NAME`].
pub const SUBSCRIBE_PANE_TITLES_CMD: &str = concat!(
    "refresh-client -B '",
    pane_title_subscription_name!(),
    ":%*:#{pane_title}|#{@tmuxy-group-id}|#{@tmuxy-group-pos}|#{@tmuxy-group-rev}'"
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
    "list-panes -a -f '#{==:#{session_name},",
    super::stash_session!(),
    "}' -F '",
    "stashmember,#{pane_id},#{window_id},#{@tmuxy-group-id},#{@tmuxy-group-pos},",
    "#{pane_current_command},",
    app_pane_title!(),
    "'",
);
