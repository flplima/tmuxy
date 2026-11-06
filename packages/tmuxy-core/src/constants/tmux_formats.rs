use super::tmux_options;
use std::sync::LazyLock;

/// The application-set pane title, with tmux's own default filtered out.
///
/// tmux seeds every pane's title with the host name, so `#{pane_title}` is
/// non-empty even when no application emitted an OSC 0/2 title. Comparing
/// against `#{host}` inside tmux (both come from the same `gethostname()`)
/// makes the field EMPTY for "no app title", so the UI can fall back to the
/// process name. Expands to ONE field: tmux consumes the comparison's comma.
/// The sidebar's sessions poll (`serversActor.ts`) uses the same expression.
pub const APP_PANE_TITLE: &str = "#{?#{==:#{pane_title},#{host}},,#{pane_title}}";

/// Which of tmux's pane modes the pane is in: `1` for copy mode, `2` for
/// view mode, `0` for none of them or any other.
///
/// `#{pane_in_mode}` is 1 for every pane mode tmux has (copy, view, tree,
/// buffer, client), and the client turns copy mode into its own scrollback
/// view, so a pane tmux merely put in view-mode vanished behind a scrollback
/// nothing would close. tmux 3.4 showed it (a fresh pane comes up in
/// `view-mode` there and rendered as a 0x0 box), and `prefix s` and friends
/// do the same on every version.
///
/// View mode is named on its own because it takes every key and a
/// `run-shell -b` that prints opens one on the current pane, on every
/// version; the aggregator closes it (`parse_list_panes_line`).
///
/// Expands to exactly one int-like field: tmux consumes the comparisons'
/// commas.
pub const PANE_MODE_FLAG: &str =
    "#{?#{==:#{pane_mode},copy-mode},1,#{?#{==:#{pane_mode},view-mode},2,0}}";

/// What a comma inside a field is sent as, so a row always has exactly one
/// field per column. tmux's `s/,/%2C/` modifier applies it on the way out and
/// [`unescape_commas`] undoes it on the way in. Only list output (`-F`) is
/// parsed this way; `display-message -p` strips the `%`.
pub const COMMA_ESCAPE: &str = "%2C";

pub fn unescape_commas(field: &str) -> String {
    field.replace(COMMA_ESCAPE, ",")
}

/// How tmux expands one column of a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    /// `#{name}`: a variable, or an option, whose value never holds a comma
    /// (an id, a number, a flag, one of tmuxy's own option values).
    Var(&'static str),
    /// `#{name}` comma-escaped: a variable whose value is free text.
    Text(&'static str),
    /// A format of its own that expands to one comma-free field.
    Format(&'static str),
    /// A format of its own whose expansion is free text, comma-escaped.
    TextFormat(&'static str),
}

impl Field {
    pub fn is_text(self) -> bool {
        matches!(self, Field::Text(_) | Field::TextFormat(_))
    }

    /// What tmux printed for this field, its commas back when it is free
    /// text.
    pub fn read(self, printed: &str) -> String {
        if self.is_text() {
            unescape_commas(printed)
        } else {
            printed.to_string()
        }
    }

    pub fn format(self) -> String {
        match self {
            Field::Var(name) => format!("#{{{name}}}"),
            Field::Text(name) => format!("#{{s/,/{COMMA_ESCAPE}/:{name}}}"),
            Field::Format(format) => format.to_string(),
            Field::TextFormat(format) => format!("#{{s/,/{COMMA_ESCAPE}/:{format}}}"),
        }
    }
}

/// The columns of one kind of row tmux lists, in the order tmux prints them.
pub trait Column: Copy + std::fmt::Debug + 'static {
    /// Every column, in row order.
    const ALL: &'static [Self];
    fn field(self) -> Field;
    fn index(self) -> usize;
}

pub fn row_format<C: Column>() -> String {
    fields_format(C::ALL.iter().map(|column| column.field()))
}

/// The `-F` format of a row of `fields`, in order: one field per column, so
/// a row splits back on its commas.
pub fn fields_format(fields: impl IntoIterator<Item = Field>) -> String {
    fields
        .into_iter()
        .map(Field::format)
        .collect::<Vec<_>>()
        .join(",")
}

macro_rules! row_table {
    ($(#[$meta:meta])* $name:ident { $($column:ident => $field:expr,)+ }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name { $($column,)+ }

        impl Column for $name {
            const ALL: &'static [Self] = &[$(Self::$column,)+];
            fn field(self) -> Field {
                match self { $(Self::$column => $field,)+ }
            }
            fn index(self) -> usize {
                self as usize
            }
        }
    };
}

row_table! {
    /// A column of a `list-panes` row ([`TmuxList::Panes`]).
    PaneColumn {
        PaneId => Field::Var("pane_id"),
        PaneIndex => Field::Var("pane_index"),
        Left => Field::Var("pane_left"),
        Top => Field::Var("pane_top"),
        Width => Field::Var("pane_width"),
        Height => Field::Var("pane_height"),
        CursorX => Field::Var("cursor_x"),
        CursorY => Field::Var("cursor_y"),
        Active => Field::Var("pane_active"),
        Command => Field::Text("pane_current_command"),
        Title => Field::TextFormat(APP_PANE_TITLE),
        Mode => Field::Format(PANE_MODE_FLAG),
        CopyCursorX => Field::Var("copy_cursor_x"),
        CopyCursorY => Field::Var("copy_cursor_y"),
        ScrollPosition => Field::Var("scroll_position"),
        WindowId => Field::Var("window_id"),
        BorderTitle => Field::TextFormat("#{T:pane-border-format}"),
        AlternateOn => Field::Var("alternate_on"),
        MouseAnyFlag => Field::Var("mouse_any_flag"),
        Marked => Field::Var("pane_marked"),
        SelectionPresent => Field::Var("selection_present"),
        SelectionStartX => Field::Var("selection_start_x"),
        SelectionStartY => Field::Var("selection_start_y"),
        HistorySize => Field::Var("history_size"),
        // A group id is `g<digits>`, a question base64 precisely so its
        // commas cannot shift the fields around it.
        GroupId => Field::Var(tmux_options::GROUP_ID),
        GroupPos => Field::Var(tmux_options::GROUP_POS),
        PaneState => Field::Var(tmux_options::PANE_STATE),
        Ask => Field::Var(tmux_options::ASK),
        Widget => Field::Var(tmux_options::PANE_WIDGET),
        Restore => Field::Text(tmux_options::PANE_RESTORE),
        // Global, so every row carries the same value: the session-wide plugin
        // inventory's revision (`plugins::inventory`), a hex hash.
        PluginsRev => Field::Var(tmux_options::PLUGINS_REV),
    }
}

row_table! {
    /// A column of a `list-windows` row ([`TmuxList::Windows`]).
    WindowColumn {
        WindowId => Field::Var("window_id"),
        Index => Field::Var("window_index"),
        Active => Field::Var("window_active"),
        WindowType => Field::Var(tmux_options::WINDOW_TYPE),
        FloatParent => Field::Var(tmux_options::FLOAT_PARENT),
        FloatWidth => Field::Var(tmux_options::FLOAT_WIDTH),
        FloatHeight => Field::Var(tmux_options::FLOAT_HEIGHT),
        FloatDrawer => Field::Var(tmux_options::FLOAT_DRAWER),
        FloatBg => Field::Var(tmux_options::FLOAT_BG),
        FloatNoheader => Field::Var(tmux_options::FLOAT_NOHEADER),
        // Session-scoped, so every row carries the same value.
        FocusRequest => Field::Var(tmux_options::FOCUS_REQUEST),
        SidebarCols => Field::Var(tmux_options::SIDEBAR_COLS),
        SidebarHidden => Field::Var(tmux_options::SIDEBAR_HIDDEN),
        Collapsible => Field::Var(tmux_options::COLLAPSIBLE),
        Zoomed => Field::Var("window_zoomed_flag"),
        SidebarRows => Field::Var(tmux_options::SIDEBAR_ROWS),
        Name => Field::Text("window_name"),
    }
}

row_table! {
    /// A column of a stash-member row ([`TmuxList::Stash`]): only what a
    /// group's tab strip needs of a hidden member.
    StashColumn {
        PaneId => Field::Var("pane_id"),
        WindowId => Field::Var("window_id"),
        GroupId => Field::Var(tmux_options::GROUP_ID),
        GroupPos => Field::Var(tmux_options::GROUP_POS),
        Command => Field::Text("pane_current_command"),
        Title => Field::TextFormat(APP_PANE_TITLE),
    }
}

/// A row tmux printed for a list of `C`, split into one field per column.
pub struct Row<'a, C> {
    fields: Vec<&'a str>,
    columns: std::marker::PhantomData<C>,
}

impl<'a, C: Column> Row<'a, C> {
    /// The row `line` is, or `None` when it has the wrong number of fields:
    /// it is not a row of this list.
    pub fn parse(line: &'a str) -> Option<Self> {
        let fields: Vec<&str> = line.split(',').collect();
        (fields.len() == C::ALL.len()).then_some(Self {
            fields,
            columns: std::marker::PhantomData,
        })
    }

    /// The field as tmux printed it, trimmed.
    pub fn field(&self, column: C) -> &'a str {
        self.fields[column.index()].trim()
    }

    /// A free-text field with its commas back, spacing kept: a border format
    /// that expands to a space is a space, as it was drawn.
    pub fn text(&self, column: C) -> String {
        unescape_commas(self.fields[column.index()])
    }

    /// The field read as a value, `None` when it is empty or not one.
    pub fn parse_field<T: std::str::FromStr>(&self, column: C) -> Option<T> {
        self.field(column).parse().ok()
    }

    /// A tmux flag: `1` is set, anything else is not.
    pub fn flag(&self, column: C) -> bool {
        self.field(column) == "1"
    }

    /// The field, or `None` when tmux printed nothing (an unset option).
    pub fn option(&self, column: C) -> Option<String> {
        let value = self.field(column);
        (!value.is_empty()).then(|| value.to_string())
    }
}

/// A row of `C` written the way tmux prints one: for test fixtures, and for
/// anything else that stands in for tmux. Every field starts empty.
pub struct RowBuilder<C> {
    values: Vec<String>,
    columns: std::marker::PhantomData<C>,
}

impl<C: Column> Default for RowBuilder<C> {
    fn default() -> Self {
        Self {
            values: vec![String::new(); C::ALL.len()],
            columns: std::marker::PhantomData,
        }
    }
}

impl<C: Column> RowBuilder<C> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a column, comma-escaped when it is free text.
    pub fn set(mut self, column: C, value: impl ToString) -> Self {
        let value = value.to_string();
        self.values[column.index()] = if column.field().is_text() {
            value.replace(',', COMMA_ESCAPE)
        } else {
            value
        };
        self
    }

    /// The row, without a line ending.
    pub fn build(&self) -> String {
        self.values.join(",")
    }
}

/// The lists the aggregator reads off tmux, each a row of its own table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TmuxList {
    /// The attached session's panes: one [`PaneColumn`] row each.
    Panes,
    /// The attached session's windows: one [`WindowColumn`] row each.
    Windows,
    /// The HIDDEN pane-group members parked in [`super::STASH_SESSION`]: one
    /// [`StashColumn`] row each. A server-wide `-a` scan filtered by `-f`
    /// returns EMPTY, not `%error`, while the stash session does not exist
    /// yet (every refresh before the first group).
    Stash,
}

impl TmuxList {
    pub const ALL: [TmuxList; 3] = [TmuxList::Panes, TmuxList::Windows, TmuxList::Stash];

    /// The command that lists it. `list-panes -s` keeps the pane list at
    /// session scope, never the current window's.
    pub fn command(self) -> &'static str {
        static PANES: LazyLock<String> =
            LazyLock::new(|| format!("list-panes -s -F '{}'", row_format::<PaneColumn>()));
        static WINDOWS: LazyLock<String> =
            LazyLock::new(|| format!("list-windows -F '{}'", row_format::<WindowColumn>()));
        static STASH: LazyLock<String> = LazyLock::new(|| {
            format!(
                "list-panes -a -f '#{{==:#{{session_name}},{}}}' -F '{}'",
                super::STASH_SESSION,
                row_format::<StashColumn>()
            )
        });
        match self {
            TmuxList::Panes => &PANES,
            TmuxList::Windows => &WINDOWS,
            TmuxList::Stash => &STASH,
        }
    }

    /// The word a marker line names it by.
    pub fn name(self) -> &'static str {
        match self {
            TmuxList::Panes => "panes",
            TmuxList::Windows => "windows",
            TmuxList::Stash => "stash",
        }
    }

    /// The list a marker line names by `name`.
    pub fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|list| list.name() == name)
    }
}

/// The control-mode subscription that reports pane metadata tmux does not
/// announce on its own.
///
/// tmux sends no notification when a title changes (`select-pane -T`, a
/// program's OSC 0/2) or a pane option does, so these would wait for the idle
/// heartbeat (15 s). tmux checks a subscription about once a second and
/// answers `%subscription-changed` whatever made the change (tmux 3.2+; `%*`
/// is every pane of every window). The global `@tmuxy-group-rev` and
/// `@tmuxy-plugins-rev` are inherited by every pane, so a reorder among
/// hidden members and a plugin install are seen too. `@tmuxy-pane-state` is
/// often written with nothing printed after it.
pub const PANE_TITLE_SUBSCRIPTION_NAME: &str = "tmuxy-pane-meta";

pub fn subscribe_pane_titles_command() -> String {
    let watched = [
        "pane_title",
        tmux_options::GROUP_ID,
        tmux_options::GROUP_POS,
        tmux_options::GROUP_REV,
        tmux_options::PLUGINS_REV,
        tmux_options::PANE_STATE,
    ]
    .map(|name| Field::Var(name).format())
    .join("|");
    format!("refresh-client -B '{PANE_TITLE_SUBSCRIPTION_NAME}:%*:{watched}'")
}

/// The control-mode subscription that reports the theme and its mode,
/// `<@tmuxy-theme>:<@tmuxy-theme-mode>`, for the attached session (`::`).
///
/// tmux announces no change to a global user option, so a theme picked on one
/// client (over any monitor) reached no other until it reconnected. tmux
/// checks a subscription about once a second and answers
/// `%subscription-changed`; the value is the whole news. A theme name is a
/// file stem and a mode is `dark`/`light`/`auto`, so neither holds a `:`.
pub const THEME_SUBSCRIPTION_NAME: &str = "tmuxy-theme";

pub fn subscribe_theme_command() -> String {
    format!(
        "refresh-client -B '{THEME_SUBSCRIPTION_NAME}::{}:{}'",
        Field::Var(tmux_options::THEME).format(),
        Field::Var(tmux_options::THEME_MODE).format()
    )
}
