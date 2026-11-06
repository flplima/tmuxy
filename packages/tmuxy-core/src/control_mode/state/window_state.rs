use super::*;
use crate::{PaneId, TmuxWindow, WindowId, WindowType};

/// Window state
pub struct WindowState {
    /// Window ID (e.g., "@0")
    pub id: WindowId,

    /// Window index
    pub index: u32,

    /// Window name
    pub name: String,

    /// Whether this window is active
    pub active: bool,

    /// Layout string
    pub layout: String,
    /// The layout's shape, parsed from `layout` when it changes.
    pub pane_tree: Option<crate::layout::PaneTree>,

    /// Window type sourced from @tmuxy-window-type. `None` = untagged, which
    /// surfaces as a tab.
    pub window_type: Option<WindowType>,
    /// `@tmuxy-sidebar-cols` — a user-dragged width for a sidebar column.
    pub sidebar_cols: Option<u32>,
    /// `@tmuxy-sidebar-hidden` — the user closed this sidebar column; its
    /// pane stays alive but no client draws it.
    pub sidebar_hidden: bool,
    /// Rows the dock's pane is sized to (@tmuxy-sidebar-rows); None = the viewport's.
    pub sidebar_rows: Option<u32>,
    /// Only the active pane's first-level row is expanded (@tmuxy-collapsible).
    pub collapsible: bool,

    /// Parent window ID for float / backdrop (@tmuxy-float-parent).
    pub float_parent: Option<WindowId>,

    /// Float width in chars (from @tmuxy-float-width).
    pub float_width: Option<u32>,

    /// Float height in chars (from @tmuxy-float-height).
    pub float_height: Option<u32>,

    /// Drawer-style float direction (@tmuxy-float-drawer).
    pub float_drawer: Option<String>,

    /// Float backdrop style (@tmuxy-float-bg).
    pub float_bg: Option<String>,

    /// True if float hides its header chrome (@tmuxy-float-noheader = 1).
    pub float_noheader: bool,

    /// Active pane ID in this window (tracked from %window-pane-changed events)
    pub active_pane_id: Option<PaneId>,

    /// Whether this window has a zoomed pane (from %layout-change flags containing 'Z')
    pub zoomed: bool,
}

impl WindowState {
    /// `index` is the window's positional index, which is independent of the
    /// number in its id: `%window-add` carries only the id, so callers pass a
    /// provisional index (see `next_window_index`) until list-windows reports
    /// the real one.
    pub fn new(id: WindowId, index: u32) -> Self {
        Self {
            index,
            id,
            name: String::new(),
            active: false,
            layout: String::new(),
            pane_tree: None,
            window_type: None,
            sidebar_cols: None,
            sidebar_hidden: false,
            sidebar_rows: None,
            collapsible: false,
            float_parent: None,
            float_width: None,
            float_height: None,
            float_drawer: None,
            float_bg: None,
            float_noheader: false,
            active_pane_id: None,
            zoomed: false,
        }
    }

    pub fn to_tmux_window(&self) -> TmuxWindow {
        TmuxWindow {
            id: self.id.clone(),
            index: self.index,
            name: self.name.clone(),
            active: self.active,
            // Untagged windows in the attached session ARE tabs — tabs carry no
            // `@tmuxy-window-type` marker. Only float/sidebar windows are
            // tagged; everything else (including foreign `tmux neww` windows)
            // surfaces as a tab.
            window_type: Some(self.window_type.unwrap_or(WindowType::Tab)),
            float_parent: self.float_parent.clone(),
            float_width: self.float_width,
            float_height: self.float_height,
            float_drawer: self.float_drawer.clone(),
            float_bg: self.float_bg.clone(),
            float_noheader: self.float_noheader,
            sidebar_cols: self.sidebar_cols,
            sidebar_hidden: self.sidebar_hidden,
            collapsible: self.collapsible,
            zoomed: self.zoomed,
            active_pane_id: self.active_pane_id.clone(),
            pane_tree: self.pane_tree.clone(),
        }
    }
}

// ============================================================
// Layout string parser
// ============================================================

/// Pane geometry extracted from a tmux layout string
pub(super) struct LayoutPane {
    pub(super) id: PaneId,
    pub(super) index: u32,
    pub(super) x: u32,
    pub(super) y: u32,
    pub(super) width: u32,
    pub(super) height: u32,
}

/// The leaves of a tmux layout string, in order, as pane geometries. The
/// tree itself is `layout::parse`'s; positions are absolute (relative to the
/// window origin). A layout that does not parse yields no panes.
pub(super) fn parse_layout_panes(layout: &str) -> Vec<LayoutPane> {
    fn leaves(node: &crate::layout::Node, out: &mut Vec<LayoutPane>) {
        match node {
            crate::layout::Node::Leaf { w, h, x, y, pane } => out.push(LayoutPane {
                id: PaneId::from_number(*pane),
                index: *pane,
                x: *x,
                y: *y,
                width: *w,
                height: *h,
            }),
            crate::layout::Node::Split { children, .. } => {
                for child in children {
                    leaves(child, out);
                }
            }
        }
    }
    let mut panes = Vec::new();
    if let Some(root) = crate::layout::parse(layout) {
        leaves(&root, &mut panes);
    }
    panes
}

impl StateAggregator {
    /// Register in-flight capture-pane commands and return only pane IDs that
    /// were actually queued (not already pending). The caller must send the
    /// marker-bracketed `markers().capture_command(..)` form for each returned ID —
    /// response routing relies on the markers, not on ordering.
    pub fn queue_captures(&mut self, pane_ids: &[PaneId]) -> Vec<PaneId> {
        let mut queued = Vec::new();
        for pane_id in pane_ids {
            if self.pending_captures.contains(pane_id) {
                // The capture in flight shows the pane as it was when it was
                // issued, not as the change behind this request leaves it:
                // one more follows once it lands (see `on_capture`).
                self.recapture.insert(pane_id.clone());
                continue;
            }
            debug!(pane = %pane_id, "capture requested");
            self.pending_captures.push_back(pane_id.clone());
            queued.push(pane_id.clone());
        }
        queued
    }

    /// The batch that refreshes `pane_ids`: `list-panes` and the stash, then
    /// a capture of each pane not already being captured (M3). A pane in copy
    /// mode scrolled back is captured over the rows it shows.
    pub fn pane_refresh_commands(&mut self, pane_ids: &[PaneId]) -> Vec<String> {
        let queued = self.queue_captures(pane_ids);
        let mut commands = self.markers.pane_refresh_commands(&[]);
        for pane_id in &queued {
            let scrolled = self
                .panes
                .get(pane_id)
                .filter(|p| p.in_mode && p.scroll_position > 0);
            commands.push(match scrolled {
                Some(p) => {
                    let end = -i64::from(p.scroll_position);
                    let start = end - i64::from(p.height) + 1;
                    self.markers.capture_command_range(pane_id, start, end)
                }
                None => self.markers.capture_command(pane_id),
            });
        }
        commands
    }

    /// The copy-mode poll: every pane in copy mode refreshed, so its cursor
    /// and the rows it is scrolled to follow the keys at once.
    pub fn copy_mode_poll_commands(&mut self) -> Vec<String> {
        let panes: Vec<PaneId> = self
            .panes
            .values()
            .filter(|p| p.in_mode && p.window_id.is_some())
            .map(|p| p.id.clone())
            .collect();
        self.pane_refresh_commands(&panes)
    }

    /// Forget the in-flight and follow-up captures of panes that are gone:
    /// their marker-routed responses are discarded on arrival, and a dead
    /// entry would hold back `initial_state_ready` forever.
    pub(super) fn prune_capture_bookkeeping(&mut self) {
        self.pending_captures
            .retain(|id| self.panes.contains_key(id));
        self.recapture.retain(|id| self.panes.contains_key(id));
    }

    /// Get the list of window IDs
    pub fn window_ids(&self) -> Vec<WindowId> {
        self.windows.keys().cloned().collect()
    }

    /// Window IDs split by how the client-size pass must size them. Tabs and
    /// floats take the whole viewport; each sidebar takes its own narrow column
    /// (the two differ in width), so those come back paired with that width.
    /// Returns `(viewport_sized, sidebar_sized_with_cols)`.
    pub fn window_ids_by_sizing(&self) -> (Vec<WindowId>, Vec<SidebarSizing>) {
        let mut viewport = Vec::new();
        let mut sidebars = Vec::new();
        for w in self.windows.values() {
            let cols = w
                .window_type
                .and_then(|t| crate::constants::sidebar_dock::cols(t, w.sidebar_cols));
            match cols {
                Some(cols) => sidebars.push((w.id.clone(), cols, w.sidebar_rows)),
                None => viewport.push(w.id.clone()),
            }
        }
        (viewport, sidebars)
    }

    /// The grid tmux REPORTS for a window: one past the furthest pane edge,
    /// the same extent the frontend computes in `gridExtent`.
    ///
    /// This is what a resize has to be judged against. `resizew` is fire and
    /// forget over the control connection, and a window still settling (or a
    /// batch racing a `%window-add`) can drop one — so the size a command
    /// ASKED for is not evidence the window has it. `None` when no pane of
    /// that window has been seen yet, which is not the same as "zero".
    pub fn window_extent(&self, window_id: &WindowId) -> Option<(u32, u32)> {
        let mut extent: Option<(u32, u32)> = None;
        for p in self.panes.values() {
            if !p.in_window(window_id) {
                continue;
            }
            let (cols, rows) = extent.unwrap_or((0, 0));
            extent = Some((cols.max(p.x + p.width), rows.max(p.y + p.height)));
        }
        extent
    }

    /// The session-scoped focus request read off the last `list-windows` poll,
    /// if a shell helper has set one. See `tmux_options::FOCUS_REQUEST`.
    pub fn focus_request(&self) -> Option<&str> {
        self.focus_request.as_deref()
    }

    /// Provisional positional index for a brand-new window: one past the
    /// current highest. tmux window IDs (`@N`, monotonic allocation) and
    /// window indices (positional) are independent, so an index parsed out of
    /// the id is wrong the moment they diverge (any window close/create
    /// churn). `%window-add`/`%window-renamed`
    /// carry only the id; a correct index otherwise waits for the follow-up
    /// list-windows. A new window is almost always appended at the end, so
    /// max+1 is right immediately; list-windows corrects the rare
    /// insert-in-the-middle case.
    pub(super) fn next_window_index(&self) -> u32 {
        self.windows
            .values()
            .map(|w| w.index)
            .max()
            .map_or(0, |m| m + 1)
    }

    /// Set up every window of the attached session, once per window and
    /// again only when what it is changes (a window first seen untagged that
    /// turns out to be a sidebar). This is the ONE list of what tmux needs
    /// set on a window (`window_setup`), plus a defensive re-tag for a
    /// float/sidebar window whose `@tmuxy-window-type` option somehow went
    /// missing (they're tagged atomically on creation, so this normally never
    /// fires). Tabs carry no marker — an untagged window IS a tab (derived at
    /// emit), so a native `tmux neww` window shows up as a tab with no
    /// adoption step.
    ///
    /// Name-based inference (defensive):
    /// - `float` or `__float_*` → Float
    /// - `__sidebar-left` / `__sidebar-right` → SidebarLeft / SidebarRight
    /// - anything else → Tab (untagged, no marker written)
    pub fn window_setup_commands(&mut self) -> Vec<String> {
        let window_type_opt = crate::constants::tmux_options::WINDOW_TYPE;
        let mut cmds = Vec::new();
        let ids: Vec<WindowId> = self.windows.keys().cloned().collect();
        for id in ids {
            let Some(window) = self.windows.get_mut(&id) else {
                continue;
            };
            if window.window_type.is_none() {
                let inferred = if window.name == "float" || window.name.starts_with("__float_") {
                    Some(WindowType::Float)
                } else {
                    match window
                        .name
                        .strip_prefix(crate::constants::SIDEBAR_WINDOW_PREFIX)
                    {
                        Some("left") => Some(WindowType::SidebarLeft),
                        Some(_) => Some(WindowType::SidebarRight),
                        None => None,
                    }
                };
                if let Some(kind) = inferred {
                    window.window_type = Some(kind);
                    cmds.push(format!(
                        "set-option -w -t {id} {window_type_opt} {}",
                        kind.as_str()
                    ));
                }
            }
            let now = WindowSetup::of(window.window_type);
            let before = self.window_setup.insert(id.clone(), now);
            cmds.extend(window_setup(&id, before, now));
        }
        cmds
    }

    /// Check if any pane is currently in copy mode
    pub fn has_pane_in_copy_mode(&self) -> bool {
        self.panes.values().any(|p| p.in_mode)
    }

    /// Sans-IO entry point. Drives the aggregator with one control-mode event
    /// and returns a `StepResult` describing every I/O action the runtime must
    /// perform plus the `change_type` of this step.
    ///
    /// The aggregator does no I/O itself — every command send, state emit,
    /// image store, and clipboard write is described, not performed. This
    /// makes the state machine fully testable without tokio: drive it with
    /// synthetic events and assert on the returned effects.
    ///
    /// `change_type` is always populated (even when `state_changed` is false)
    /// so the monitor's settling state machine can extend its deadline on
    /// window/layout changes that are currently being suppressed.
    pub fn step(&mut self, event: ControlModeEvent) -> StepResult {
        self.step_at(event, Instant::now())
    }

    /// Like `tick`, but sources `now` from the process clock. Used by non-native
    /// hosts (wasm) that drive the settling flush on a timer.
    pub fn tick_now(&mut self) -> Option<ChangeType> {
        self.tick(Instant::now())
    }

    /// Decoded image bytes for a pane placement (PNG/etc.), for hosts that serve
    /// image bytes themselves (the native server uses `/api/images`; the wasm
    /// host resolves via `window.__tmuxyImageSrc`). Returns `(data, mime_type)`.
    pub fn image_data(&self, pane_id: &PaneId, image_id: u32) -> Option<(Vec<u8>, String)> {
        self.panes
            .get(pane_id)
            .and_then(|p| p.image_store.get(&image_id))
            .map(|img| (img.data.clone(), img.mime_type.clone()))
    }
}

/// What a window is set up as (`window_setup`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WindowSetup {
    /// A tab: its pane headers are drawn on tmux's border row.
    Tab,
    /// A docked sidebar column: headerless.
    Sidebar,
    /// A float, which keeps whatever border it was made with.
    Other,
}

impl WindowSetup {
    fn of(window_type: Option<WindowType>) -> Self {
        match window_type {
            None | Some(WindowType::Tab) => WindowSetup::Tab,
            Some(kind) if kind.is_sidebar() => WindowSetup::Sidebar,
            Some(_) => WindowSetup::Other,
        }
    }
}

/// The window options tmux needs set on `id`, now that it is `now` and was
/// `before` (`None`: never set up on this connection).
///
/// Every one is a WINDOW option, so it is set on the window itself: a `set`
/// without a target reaches only the current window, and a global one
/// (`-g`) would reach every session on the server and is what
/// docs/TMUX-CONFIG.md records crashing tmux 3.5a under control mode.
fn window_setup(id: &WindowId, before: Option<WindowSetup>, now: WindowSetup) -> Vec<String> {
    let mut cmds = Vec::new();
    if before.is_none() {
        // tmuxy sizes every window itself (`MonitorCore::set_client_size`). Under
        // tmux's default `window-size latest`, tmux sizes the window to the
        // latest attached client and undoes the `resizew`: the control-mode
        // PTY is 200x50, which is exactly the grid a phone-width client was
        // left stuck with.
        cmds.push(format!("set-option -w -t {id} window-size manual"));
        cmds.push(format!("set-option -w -t {id} aggressive-resize off"));
        // A program may name its pane (OSC 0/2), which is how a pane header
        // shows what runs in it.
        cmds.push(format!("set-option -w -t {id} allow-rename on"));
        // OSC passthrough, for hyperlinks, images and the rest. tmux 3.3
        // added the option (`-q`: 3.2 has none, and passes them through
        // unconditionally).
        cmds.push(format!("set-option -wq -t {id} allow-passthrough on"));
    }
    if before == Some(now) {
        return cmds;
    }
    match now {
        // A tab's topmost pane sits at y=1, leaving the border row that
        // PaneLayout draws the pane header into; blank, so nothing of tmux's
        // own shows through.
        WindowSetup::Tab => {
            cmds.push(format!("set-option -w -t {id} pane-border-status top"));
            cmds.push(format!("set-option -w -t {id} pane-border-format ' '"));
        }
        // A sidebar is drawn headerless and sized without that row: leaving
        // it on costs the pane a line of content. A window is first seen
        // untagged (the marker lands a beat after `%window-add`), so it was
        // set up as a tab before it turned out to be a sidebar.
        WindowSetup::Sidebar => {
            cmds.push(format!("set-option -w -t {id} pane-border-status off"));
        }
        WindowSetup::Other => {}
    }
    cmds
}
