use serde::{Deserialize, Serialize};

use crate::{control_mode, is_false, layout, GroupId, PaneContent, PaneId, WindowId};

// ============================================
// Tmux State Types
// ============================================

/// A single tmux pane
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxPane {
    pub id: u32,
    pub tmux_id: PaneId,     // actual tmux pane ID (e.g., "%0")
    pub window_id: WindowId, // window this pane belongs to (e.g., "@0")
    /// Rendered cell grid. `Arc`-shared so building a state snapshot, storing
    /// `prev_state`, and diffing unchanged panes never deep-copies the grid —
    /// the cost that made a one-field delta as expensive as a full sync.
    /// Serializes transparently (serde `rc`), so the wire shape is unchanged.
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
    /// Pane-group identity from `@tmuxy-group-id` (e.g. `g5`). `None` unless the
    /// pane belongs to a group. Set on the visible member and every hidden
    /// member (the latter emitted as lightweight stubs from the stash session),
    /// so the frontend reconstructs group membership by grouping on this value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<GroupId>,
    /// `@tmuxy-group-pos`: this member's place in its group, when the group
    /// has been reordered (see `constants::tmux_options::GROUP_POS`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_pos: Option<u32>,
    pub in_mode: bool, // true if in copy mode
    pub copy_cursor_x: u32,
    pub copy_cursor_y: u32,
    /// True if the application is in alternate screen mode (vim, less, htop)
    /// Used to determine scroll behavior (wheel -> arrow keys vs copy mode)
    #[serde(default)]
    pub alternate_on: bool,
    /// True if the application has mouse tracking enabled
    /// When true, mouse events should be forwarded as SGR sequences
    #[serde(default)]
    pub mouse_any_flag: bool,
    /// True if this is tmux's marked pane (`select-pane -m`). The UI shows an
    /// indicator and offers swap/join with it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub marked: bool,
    /// True if this pane's output is paused due to flow control
    /// When true, UI should show a pause indicator
    #[serde(default)]
    pub paused: bool,
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
    /// Image placements on this pane's terminal grid
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
    /// Any process can set it — an agent's hooks, a shell's precmd/preexec, a
    /// build script — so the sidebar shows a pane's state without tmuxy having
    /// to infer one. Carried verbatim: the client owns the vocabulary and
    /// collapses anything it does not recognize, which keeps writers free to
    /// use their own status names. `None` when the option is unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_state: Option<String>,
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
    /// The address a live browser pane is showing (`@tmuxy-pane-url`), for
    /// the app's address bar over it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_url: Option<String>,
}

/// Window type discriminator. Floats and sidebars carry it as the
/// `@tmuxy-window-type` window option; an untagged window is a tab.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowType {
    Tab,
    Float,
    /// The left sidebar's window — a single pane running `tmuxy widget tree`,
    /// which the UI renders as the tab/pane tree. See [`SidebarRight`] for the
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

    /// Whether this is one of the two docked sidebar columns. They share every
    /// behaviour that separates chrome from tabs — hidden from the tab strip,
    /// no pane border, sized to a fixed column — and differ only in width and
    /// which edge they dock to.
    pub fn is_sidebar(self) -> bool {
        matches!(self, WindowType::SidebarLeft | WindowType::SidebarRight)
    }
}

/// A single tmux window: a tab, a float or a sidebar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxWindow {
    /// Window ID (e.g., "@0")
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

/// Full tmux state with all panes and windows
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxState {
    /// Session name (e.g., "tmuxy")
    pub session_name: String,
    /// Active window ID (e.g., "@0")
    pub active_window_id: Option<WindowId>,
    /// Active pane ID (e.g., "%0")
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
    /// The emission counter this state was taken at: the delta that follows
    /// it carries `seq + 1`, so a client can tell a delta lost right after a
    /// full state or an initial-state answer from the next one. 0 for a
    /// state no stream has numbered yet.
    #[serde(default)]
    pub seq: u64,
}
