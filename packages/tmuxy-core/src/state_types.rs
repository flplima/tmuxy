use serde::{Deserialize, Serialize};

use crate::{control_mode, is_false, layout, GroupId, PaneContent, PaneId, WindowId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxPane {
    pub id: u32,
    pub tmux_id: PaneId, // actual tmux pane ID (e.g., "%0")
    pub window_id: WindowId,
    /// `Arc`-shared so building a state, storing `prev_state` and diffing
    /// unchanged panes never deep-copies the grid. Serializes transparently
    /// (serde `rc`).
    pub content: std::sync::Arc<PaneContent>,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
    pub active: bool,
    pub command: String,
    pub title: String,        // pane title (set by shell/application)
    pub border_title: String, // evaluated pane-border-format from tmux config
    /// Pane-group identity from `@tmuxy-group-id` (e.g. `g5`). Hidden members
    /// carry it too (as stubs from the stash session), so the frontend
    /// reconstructs membership by grouping on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<GroupId>,
    /// `@tmuxy-group-pos`: this member's place in its group, when the group
    /// has been reordered (see `constants::tmux_options::GROUP_POS`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_pos: Option<u32>,
    pub in_mode: bool, // true if in copy mode
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,
    /// The application is in alternate screen mode (vim, less, htop): the
    /// wheel sends arrow keys instead of entering copy mode.
    #[serde(default)]
    pub alternate_on: bool,
    /// The application has mouse tracking on: mouse events are forwarded as
    /// SGR sequences.
    #[serde(default)]
    pub mouse_any_flag: bool,
    /// True if this is tmux's marked pane (`select-pane -m`). The UI shows an
    /// indicator and offers swap/join with it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub marked: bool,
    /// Number of history lines (scrollback above the visible area)
    #[serde(default)]
    pub history_size: u64,
    /// Whether a selection is active in copy mode
    #[serde(default)]
    pub selection_present: bool,
    /// Selection start X (visible-area-relative column), only meaningful when selection_present
    #[serde(default)]
    pub selection_start_x: u32,
    /// Selection start Y (visible-area-relative row, can be negative if off-screen)
    #[serde(default)]
    pub selection_start_y: i32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<control_mode::images::ImagePlacement>,
    /// Cursor shape from DECSCUSR: 0/1=block_blink, 2=block, 3=underline_blink, 4=underline, 5=bar_blink, 6=bar
    #[serde(default)]
    pub cursor_shape: u8,
    /// Whether the cursor is hidden (DECTCEM mode 25 off / ESC[?25l)
    #[serde(default)]
    pub cursor_hidden: bool,
    /// What the pane says it is doing, from `@tmuxy-pane-state`.
    ///
    /// Any process can set it (an agent's hooks, a shell's precmd/preexec, a
    /// build script). Carried verbatim: the client owns the vocabulary and
    /// collapses anything it does not recognize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_state: Option<String>,
    /// What the pane's program reported behind that state (OSC 7501), from
    /// `@tmuxy-pane-status`: a report body,
    /// `state=blocked:kind=permission:msg=<base64>`, which a host wrote from
    /// the pane's output. Carried verbatim; the client decodes the text.
    /// `None` when the state is not the one the report was made with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_status: Option<String>,
    /// The pending confirmation from `@tmuxy-ask`: the base64 payload
    /// `tmuxy pane send -t` wrote on the pane the keys are meant for. Carried verbatim —
    /// the client decodes it and draws the question over the pane's content.
    /// `None` when nothing is pending.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_ask: Option<String>,
    /// Which widget this pane is AUTHORISED to render (`@tmuxy-pane-widget`).
    /// The `__TMUXY_WIDGET__:` marker travels in pane output, which anything
    /// the pane prints can forge; this option is written out of band by
    /// `tmuxy-widget`, so the client renders a widget only when the two agree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_widget: Option<String>,
    /// How the pane says it should be brought back after a session restore
    /// (`@tmuxy-pane-restore`, `tmuxy pane restore-cmd`). Polled so that a
    /// program declaring it is a change the session snapshot follows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_restore: Option<String>,
}

/// Window type discriminator. Floats and sidebars carry it as the
/// `@tmuxy-window-type` window option; an untagged window is a tab.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowType {
    Tab,
    Float,
    /// The left sidebar's window: a single pane running the tree widget
    /// ([`crate::session_snapshot::LEFT_SIDEBAR_WIDGET`]). See [`SidebarRight`] for the
    /// properties both sidebars share.
    ///
    /// [`SidebarRight`]: WindowType::SidebarRight
    SidebarLeft,
    /// The right sidebar's window — a single pane holding a shell (or whatever
    /// the user runs there) that the UI docks to the right edge on every tab.
    ///
    /// Both sidebar kinds are chrome windows exactly like floats: excluded from
    /// the tab bar, and sized to their own narrow column rather than the client
    /// viewport (see [`crate::constants::sidebar_dock`]).
    SidebarRight,
}

impl WindowType {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "tab" => Some(WindowType::Tab),
            "float" => Some(WindowType::Float),
            "sidebar-left" => Some(WindowType::SidebarLeft),
            "sidebar-right" => Some(WindowType::SidebarRight),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WindowType::Tab => "tab",
            WindowType::Float => "float",
            WindowType::SidebarLeft => "sidebar-left",
            WindowType::SidebarRight => "sidebar-right",
        }
    }

    pub fn is_sidebar(self) -> bool {
        matches!(self, WindowType::SidebarLeft | WindowType::SidebarRight)
    }
}

/// What a pane says it is doing: the `@tmuxy-pane-state` values tmuxy knows,
/// in attention order (the first wants the user most). This is the whole
/// vocabulary: `tmuxy pane state` refuses any other word (the shell's
/// `PANE_STATE_WORDS` is generated from it), and a word written past the CLI
/// is no state at all here and `idle` in the UI's `domain/paneState.ts`, which
/// takes these words from the generated `tmuxyConstants.gen.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneStateName {
    NeedsInput,
    Error,
    Unread,
    Working,
    Idle,
}

impl PaneStateName {
    pub const ALL: [PaneStateName; 5] = [
        PaneStateName::NeedsInput,
        PaneStateName::Error,
        PaneStateName::Unread,
        PaneStateName::Working,
        PaneStateName::Idle,
    ];

    /// The state [`PaneStateName::as_str`] names.
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.as_str() == word)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            PaneStateName::NeedsInput => "needs-input",
            PaneStateName::Error => "error",
            PaneStateName::Unread => "unread",
            PaneStateName::Working => "working",
            PaneStateName::Idle => "idle",
        }
    }
}

/// A single tmux window: a tab, a float or a sidebar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxWindow {
    pub id: WindowId,
    pub index: u32,
    pub name: String,
    pub active: bool,
    /// Window type as set via @tmuxy-window-type; an untagged window is a tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_type: Option<WindowType>,
    /// Parent window ID for a float (the launcher window).
    /// Sourced from @tmuxy-float-parent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_parent: Option<WindowId>,
    /// Float width in cells (from @tmuxy-float-width).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_width: Option<u32>,
    /// Float height in cells (from @tmuxy-float-height).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_height: Option<u32>,
    /// Drawer-style float direction (from @tmuxy-float-drawer).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_drawer: Option<String>,
    /// Float backdrop style (from @tmuxy-float-bg).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub float_bg: Option<String>,
    /// True if the float hides its header chrome (from @tmuxy-float-noheader).
    #[serde(default, skip_serializing_if = "is_false")]
    pub float_noheader: bool,
    /// True while the user has minimized this float to the queue at the
    /// bottom of its tab (from @tmuxy-float-minimized). Its pane keeps running.
    #[serde(default, skip_serializing_if = "is_false")]
    pub float_minimized: bool,
    /// A sidebar column's width in terminal columns when the user has dragged it
    /// off its default (from @tmuxy-sidebar-cols). The client draws the column
    /// at this many cells, so it must match what the backend sized the pane to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_cols: Option<u32>,
    /// True while the user has closed this sidebar column (from
    /// @tmuxy-sidebar-hidden). The pane behind it stays alive, so the window
    /// existing no longer means the column is shown.
    #[serde(default, skip_serializing_if = "is_false")]
    pub sidebar_hidden: bool,
    /// True while the window keeps only the active pane's first-level row
    /// expanded (from @tmuxy-collapsible; see `layout.rs`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub collapsible: bool,
    /// True while a pane in this window is zoomed. tmux hides every other pane
    /// when zoomed; the frontend must not keep painting them underneath.
    #[serde(default)]
    pub zoomed: bool,
    /// The window's own active pane. tmux keeps one per window, but `pane.active`
    /// is collapsed to the session's single active pane for the client, so a
    /// background tab's active pane would otherwise be unknown until it is
    /// switched to — and the switch would land on its first pane for a beat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<PaneId>,
    /// The window's split structure (see `layout::PaneTree`): what a divider
    /// drag moves. Absent until tmux has reported a layout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_tree: Option<layout::PaneTree>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxState {
    pub session_name: String,
    pub active_window_id: Option<WindowId>,
    pub active_pane_id: Option<PaneId>,
    pub panes: Vec<TmuxPane>,
    pub windows: Vec<TmuxWindow>,
    pub total_width: u32,
    pub total_height: u32,
    /// Pending one-shot focus request from a shell helper (`left` / `right` /
    /// `panes`), or `None` when nothing is queued. See
    /// [`crate::constants::tmux_options::FOCUS_REQUEST`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_request: Option<String>,
    /// The global `@tmuxy-plugins-rev`: changes exactly when the plugin
    /// inventory does, which the client then reads with one query.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugins_rev: Option<String>,
    /// `<@tmuxy-theme>:<@tmuxy-theme-mode>`: changes exactly when the theme
    /// or its mode does, on any client, which then reads the theme settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_rev: Option<String>,
    /// The emission counter this state was taken at: the delta that follows
    /// it carries `seq + 1`, so a client can tell a delta lost right after a
    /// full state or an initial-state answer from the next one. 0 for a
    /// state no stream has numbered yet.
    #[serde(default)]
    pub seq: u64,
}
