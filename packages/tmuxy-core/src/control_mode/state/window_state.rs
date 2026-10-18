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
    /// marker-bracketed `capture_command(..)` form for each returned ID —
    /// response routing relies on the markers, not on ordering.
    pub fn queue_captures(&mut self, pane_ids: &[PaneId]) -> Vec<PaneId> {
        let mut queued = Vec::new();
        for pane_id in pane_ids {
            if !self.pending_captures.contains(pane_id) {
                debug!(pane = %pane_id, "capture requested");
                self.pending_captures.push_back(pane_id.clone());
                queued.push(pane_id.clone());
            }
        }
        queued
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

    /// Set up every untagged window in the attached session. Tabs no longer
    /// carry a marker — an untagged window IS a tab (derived at emit), so a
    /// native `tmux neww` window shows up as a tab with no adoption step. This
    /// returns the per-window `pane-border-status top` enforcement each new tab
    /// needs, plus a defensive re-tag for a float/sidebar window whose
    /// `@tmuxy-window-type` option somehow went missing (they're tagged
    /// atomically on creation, so this normally never fires).
    ///
    /// Name-based inference (defensive):
    /// - `float` or `__float_*` → Float
    /// - `__sidebar-left` / `__sidebar-right` → SidebarLeft / SidebarRight
    /// - anything else → Tab (untagged, no marker written)
    ///
    /// Every Tab window must carry `pane-border-status top` so its topmost pane
    /// sits at y=1, reserving the border row that PaneLayout draws the pane
    /// header into. `enforce_settings`' session-level `set` is NOT inherited by
    /// windows (verified: a fresh window reports `pane-border-status off`), and
    /// `set -g` risks a tmux 3.5a control-mode crash — so it must be applied
    /// per-window. `border_enforced` makes that idempotent now that tabs have no
    /// marker to gate on.
    pub fn collect_window_tag_commands(&mut self) -> Vec<String> {
        // Snapshot the untagged windows first so we don't hold a `self.windows`
        // borrow while touching `self.border_enforced`.
        let untagged: Vec<(WindowId, String)> = self
            .windows
            .values()
            .filter(|w| w.window_type.is_none())
            .map(|w| (w.id.clone(), w.name.clone()))
            .collect();

        let window_type_opt = crate::constants::tmux_options::WINDOW_TYPE;
        let mut cmds = Vec::new();
        for (id, name) in untagged {
            if name == "float" || name.starts_with("__float_") {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.window_type = Some(WindowType::Float);
                }
                cmds.push(format!("set-option -w -t {id} {window_type_opt} float"));
            } else if let Some(side) = name.strip_prefix("__sidebar-") {
                let kind = match side {
                    "left" => WindowType::SidebarLeft,
                    _ => WindowType::SidebarRight,
                };
                if let Some(w) = self.windows.get_mut(&id) {
                    w.window_type = Some(kind);
                }
                cmds.push(format!(
                    "set-option -w -t {id} {window_type_opt} {}",
                    kind.as_str()
                ));
            } else if self.border_enforced.insert(id.clone()) {
                cmds.push(format!("set-option -w -t {id} pane-border-status top"));
                cmds.push(format!("set-option -w -t {id} pane-border-format ' '"));
            }
        }

        // Take the border row OFF every sidebar window, once. A sidebar is
        // drawn headerless and sized without that row, so leaving it on costs
        // the pane a line of content — and it is on by default: the global
        // `pane-border-status top` applies to every new window, whether the
        // window was first adopted as a tab above (the marker lands a beat after
        // `%window-add`) or arrived already typed because `list-windows` was
        // re-run right behind the create command.
        let bordered: Vec<WindowId> = self
            .windows
            .values()
            .filter(|w| {
                w.window_type.is_some_and(WindowType::is_sidebar)
                    && !self.sidebar_border_cleared.contains(&w.id)
            })
            .map(|w| w.id.clone())
            .collect();
        for id in bordered {
            self.border_enforced.remove(&id);
            self.sidebar_border_cleared.insert(id.clone());
            cmds.push(format!("set-option -w -t {id} pane-border-status off"));
        }

        cmds
    }

    /// Check if any pane is currently in copy mode
    pub fn has_pane_in_copy_mode(&self) -> bool {
        self.panes.values().any(|p| p.in_mode)
    }

    /// Get copy mode pane info: (pane_id, scroll_position, height) for building capture-pane commands
    pub fn get_copy_mode_pane_info(&self) -> Vec<(PaneId, u32, u32)> {
        self.panes
            .values()
            .filter(|p| p.in_mode && p.window_id.is_some())
            .map(|p| (p.id.clone(), p.scroll_position, p.height))
            .collect()
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
    pub fn tick_now(&mut self) -> Vec<SideEffect> {
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
