use super::*;
use crate::{GroupId, PaneContent, PaneId, TmuxPane, TmuxState, TmuxWindow, WindowId};

/// Prepare capture-pane bytes for vt100: strip the trailing newline (which
/// would push the cursor past the last row and scroll) and expand `\n` to
/// `\r\n` (vt100 treats bare `\n` as move-down without a carriage return).
pub fn normalize_capture_bytes(content: &[u8]) -> Vec<u8> {
    let content = content.strip_suffix(b"\n").unwrap_or(content);
    let mut out = Vec::with_capacity(content.len() + content.len() / 16);
    for &b in content {
        if b == b'\n' {
            out.push(b'\r');
        }
        out.push(b);
    }
    out
}

/// Does this line look like a `list-panes` record (`%<digits>,...`)?
///
/// tmux pane ids are always `%` followed by digits, and `LIST_PANES_CMD` puts
/// `#{pane_id}` first, so a genuine record always starts that way.
pub(super) fn is_list_panes_line(line: &str) -> bool {
    line.trim_start()
        .split_once(',')
        .is_some_and(|(id, _)| PaneId::parse(id).is_ok())
}

/// The process name to show for a pane, given tmux's `#{pane_current_command}`.
///
/// tmux reads that field from the kernel's `p_comm`, which is the resolved
/// executable's file name — not the name of the symlink that was invoked. A
/// launcher that pins its version by directory, as Claude Code does
/// (`~/.local/share/claude/versions/2.1.280`), therefore reports a bare version
/// string, and every surface that names the process by its command (the sidebar
/// tree, the pane tabs, `tmuxy-tree`, the CLI) shows `2.1.280` where the user
/// expects `claude`.
///
/// Normalising here rather than per surface means the backend state is the one
/// place that has to know about it. The only pattern claimed is a command that
/// is *entirely* a dotted version number, which no real executable is called.
pub(super) fn normalize_pane_command(command: &str) -> String {
    if is_version_string(command) {
        return "claude".to_string();
    }
    command.to_string()
}

/// The command a pane is named by, once its widget tag is known.
///
/// A live browser pane runs the server binary (`tmuxy-server`, or `tmuxy` in
/// the desktop app), which names nothing the user did: it is a browser. The tag
/// (`browser-live`, set by `tmuxy browser` through the CLI) is what says so —
/// never the output — so a plain `tmuxy-server` run in a shell keeps its name.
pub(super) fn pane_command(command: String, widget: Option<&str>) -> String {
    if widget == Some("browser-live") {
        return "browser".to_string();
    }
    command
}

/// Is this string nothing but a dotted run of digits (`2.1.280`, `0.9`)?
fn is_version_string(value: &str) -> bool {
    let mut parts = value.split('.');
    let mut count = 0;
    for part in &mut parts {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        count += 1;
    }
    count >= 2
}

/// Literal sentinel prefixed on every `LIST_STASH_PANES_CMD` row so a stash
/// response routes to the stash-member handler and never reaches the
/// active-session pane/window parsers (a stash row carries a `@<id>` window id
/// that would otherwise trip the list-windows loop).
const STASH_MEMBER_PREFIX: &str = "stashmember,";

pub(super) fn is_stash_member_line(line: &str) -> bool {
    line.trim_start().starts_with(STASH_MEMBER_PREFIX)
}

/// A HIDDEN pane-group member living in the stash session — just enough to
/// render its tab in a group strip. Emitted as a lightweight `TmuxPane` stub.
#[derive(Debug, Clone)]
pub(super) struct StashMember {
    /// The pane's window in the stash session (never the attached session's
    /// active window, so the frontend treats the emitted stub as hidden).
    pub(super) window_id: WindowId,
    /// `@tmuxy-group-id` value tying it to its group.
    pub(super) group_id: GroupId,
    /// `@tmuxy-group-pos`, when the group has been reordered.
    pub(super) group_pos: Option<u32>,
    pub(super) command: String,
    pub(super) title: String,
}

/// Build the wire stub for a hidden group member. It has no rendered content or
/// geometry — the frontend only reads its id, group id, command, and title to
/// draw the member's tab; its content streams in via a real pane once the user
/// swaps it into view.
fn stash_member_stub(pane_id: &PaneId, member: &StashMember) -> TmuxPane {
    TmuxPane {
        id: 0,
        tmux_id: pane_id.clone(),
        window_id: member.window_id.clone(),
        content: std::sync::Arc::new(PaneContent::default()),
        cursor_x: 0,
        cursor_y: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        active: false,
        command: member.command.clone(),
        title: member.title.clone(),
        border_title: String::new(),
        group_id: Some(member.group_id.clone()),
        group_pos: member.group_pos,
        in_mode: false,
        copy_cursor_x: 0,
        copy_cursor_y: 0,
        alternate_on: false,
        mouse_any_flag: false,
        marked: false,
        paused: false,
        history_size: 0,
        selection_present: false,
        selection_start_x: 0,
        selection_start_y: 0,
        images: Vec::new(),
        cursor_shape: 0,
        cursor_hidden: false,
        // A stash member is a hidden stub, not a running pane: it reports no
        // state of its own until it is swapped into view as a real pane.
        pane_state: None,
        pane_ask: None,
        pane_widget: None,
        pane_restore: None,
        pane_url: None,
    }
}

/// Per-event debounce window during settling.
pub(crate) const SETTLING_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(100);
/// Safety ceiling — settling cannot extend past this from the arm point.
pub(crate) const SETTLING_MAX: std::time::Duration = std::time::Duration::from_millis(500);

/// The largest OSC 52 clipboard write a pane may make, decoded.
///
/// A pane's output is not trusted: `cat` of a crafted file is enough to reach
/// this path, so the write is bounded rather than being whatever the file was.
/// 64 KiB is comfortably above a real yank and below xterm's own ~100 KB.
pub const MAX_CLIPBOARD_BYTES: usize = 64 * 1024;

/// The least time between two OSC 52 writes from one pane.
///
/// A yank is something the user does, and nobody does it several times a
/// second; a program that writes the clipboard in a loop is fighting the user
/// for it. The first write in each interval goes through, the rest are dropped.
pub const MIN_CLIPBOARD_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// The most decoded images one pane keeps.
///
/// A pane can only SHOW as many pictures as its grid has room for; this is
/// well above that so scrolling back over recent output still finds them, and
/// bounded so a program printing images in a loop cannot grow the process for
/// the life of the pane.
pub const MAX_STORED_IMAGES_PER_PANE: usize = 256;

/// Whether an OSC 52 write from `pane_id` is honoured, and with what text.
///
/// Two bounds, both because the sequence comes from pane output rather than
/// from the user:
/// - **Only the active pane.** A background pane — a tailed log, a stray ssh
///   session — cannot silently replace what the user is about to paste.
/// - **A size cap.** See `MAX_CLIPBOARD_BYTES`.
pub fn accepted_clipboard_write(
    pane_id: &PaneId,
    active_pane_id: Option<&PaneId>,
    text: String,
) -> Option<String> {
    if active_pane_id != Some(pane_id) {
        return None;
    }
    if text.len() > MAX_CLIPBOARD_BYTES {
        return None;
    }
    Some(text)
}

impl StateAggregator {
    /// Arm settling for a multi-step compound command (e.g. `splitw ; breakp`).
    /// Suppresses window/layout emissions until `tick(now)` fires the
    /// consolidated emit, or until `clear_settling()` is called explicitly.
    pub fn arm_settling(&mut self, now: Instant) {
        self.settling_started = Some(now);
        self.settling_awaiting_first_event = true;
        self.settling_until = Some(now + SETTLING_MAX);
        self.suppress_window_emissions = true;
    }

    /// Current settling deadline, if armed. Callers (the monitor) use this to
    /// compute a wakeup; expiry is processed by `tick(now)`.
    pub fn settling_deadline(&self) -> Option<Instant> {
        self.settling_until
    }

    /// Whether settling is currently armed. Lets the monitor decide if it
    /// should enable the settling-wakeup branch in its select loop.
    pub fn is_settling(&self) -> bool {
        self.settling_until.is_some()
    }

    /// Clear settling without firing an emit. Used by the monitor when a
    /// `RunCommand` send fails so we don't leave the aggregator suppressed.
    pub fn clear_settling(&mut self) {
        self.settling_until = None;
        self.settling_started = None;
        self.settling_awaiting_first_event = false;
        self.suppress_window_emissions = false;
    }

    /// On window/layout events during settling, extend the debounce deadline
    /// but never past the safety ceiling. Called internally from `step`.
    pub(super) fn maybe_extend_settling(&mut self, change: &ChangeType, now: Instant) {
        if self.settling_until.is_none() {
            return;
        }
        let is_window_event = matches!(
            change,
            ChangeType::Window | ChangeType::PaneLayout | ChangeType::PaneFocus
        );
        if !is_window_event {
            return;
        }
        if self.settling_awaiting_first_event {
            self.settling_awaiting_first_event = false;
            self.settling_started = Some(now);
        }
        let max_deadline = self.settling_started.unwrap_or(now) + SETTLING_MAX;
        let debounced = now + SETTLING_DEBOUNCE;
        self.settling_until = Some(debounced.min(max_deadline));
    }

    /// Rebuild the hidden pane-group member map from a `LIST_STASH_PANES_CMD`
    /// response. Row shape: `stashmember,<pane>,<window>,<group-id>,<cmd>,<title>`
    /// (title is free text and last). Members without a group id are ignored.
    pub(super) fn rebuild_stash_members(&mut self, output: &str) {
        let mut members = HashMap::new();
        for line in output.lines() {
            if !is_stash_member_line(line) {
                continue;
            }
            let parts: Vec<&str> = line.trim_start().splitn(7, ',').collect();
            if parts.len() < 7 {
                continue;
            }
            let (Ok(pane_id), Ok(window_id), Ok(group_id)) = (
                PaneId::parse(parts[1].trim()),
                WindowId::parse(parts[2].trim()),
                GroupId::parse(parts[3].trim()),
            ) else {
                continue;
            };
            // Same guard as a visible pane's title (see is_graphics_payload).
            // A parked member streams no content, so its tab label is tmux's
            // `pane_title` and nothing else — which is exactly where a Kitty
            // graphics probe lands when tmux reads the APC as a title. Without
            // this the strip labelled the member `Ga=q,f=32,s=1,…` while the
            // visible pane running the same program was labelled properly.
            let title = parts[6].to_string();
            members.insert(
                pane_id,
                StashMember {
                    window_id,
                    group_id,
                    group_pos: parts[4].trim().parse().ok(),
                    command: normalize_pane_command(parts[5]),
                    title: if is_graphics_payload(&title) {
                        String::new()
                    } else {
                        title
                    },
                },
            );
        }
        self.stash_members = members;
    }

    /// Whether `to_tmux_state` would describe the session in full: the
    /// initial list-panes and list-windows have been parsed and no
    /// capture-pane refill is on its way — a snapshot taken mid-refill would
    /// carry the blank panes a reset parser holds until capture-pane answers.
    pub fn initial_state_ready(&self) -> bool {
        self.panes_synced && self.windows_synced && self.pending_captures.is_empty()
    }

    /// Convert current state to TmuxState for the frontend.
    pub fn to_tmux_state(&mut self) -> TmuxState {
        let active_window = self.active_window_id.as_ref();

        // Send panes from every window in the session. The frontend filters
        // by activeWindowId via selectVisiblePanes, so panes from inactive
        // windows live harmlessly in context.panes[] — and that cache is
        // what makes SELECT_TAB feel instant: the optimistic activeWindowId
        // flip can render the target tab without waiting for the server
        // round-trip. Hidden pane-group and float windows ride along on the
        // same code path (no special-casing needed once the active-window
        // filter is gone).
        // Tmux stores `pane.active` per window — every window has its own
        // active pane. Collapse to a session-wide single active pane so the
        // frontend can treat `pane.active` as a uniqueness flag (used by
        // keyboard routing, optimistic-prediction lookups, focus indicators).
        // Without this collapse, multiple panes report active=true and any
        // downstream code that assumes "at most one active pane" misbehaves.
        let mut panes: Vec<TmuxPane> = self
            .panes
            .values_mut()
            .filter_map(|p| {
                let mut pane = p.build_tmux_pane()?;
                pane.active = pane.active && active_window == Some(&pane.window_id);
                Some(pane)
            })
            .collect();

        // Append the hidden pane-group members parked in the stash session as
        // lightweight stubs, so a group's tab strip can render every member even
        // though only the visible one is a real pane in this session. Prune
        // members whose group no longer has a visible pane here (the group was
        // dissolved, or its tab was closed wholesale) — those are orphans, not
        // tabs. The stub's stash `window_id` is never the active window, so
        // `selectVisiblePanes` keeps it out of the layout automatically.
        let active_group_ids: HashSet<&GroupId> = self
            .panes
            .values()
            .filter_map(|p| p.group_id.as_ref())
            .collect();
        self.stash_members
            .retain(|_, m| active_group_ids.contains(&m.group_id));
        for (pane_id, member) in &self.stash_members {
            panes.push(stash_member_stub(pane_id, member));
        }

        let windows: Vec<TmuxWindow> = self.windows.values().map(|w| w.to_tmux_window()).collect();

        // The grid's size is the ACTIVE window's extent — what the client
        // draws and sizes its viewport against. Every other window is in the
        // list too (hidden group members, floats, sidebars, a tab left at an
        // older size), each in its own layout; a max over all of them told
        // the client the grid was as tall as the tallest hidden window, so it
        // asked for a resize on every update and, waiting for a size that
        // could never come, kept its layout animations off for good.
        let in_active_window = |p: &&TmuxPane| active_window.is_none_or(|w| p.window_id == *w);
        let extent = |f: fn(&TmuxPane) -> u32, fallback: u32| {
            panes
                .iter()
                .filter(in_active_window)
                .map(f)
                .max()
                .or_else(|| panes.iter().map(f).max())
                .unwrap_or(fallback)
        };
        let total_width = extent(|p| p.x + p.width, 80);
        let total_height = extent(|p| p.y + p.height, 24);

        // Find the active pane ID from the active window
        // (each window has its own active pane, we want the one in the active window)
        let active_pane_id = panes
            .iter()
            .find(|p| p.active && active_window == Some(&p.window_id))
            .or_else(|| panes.iter().find(|p| p.active))
            .map(|p| p.tmux_id.clone());

        TmuxState {
            session_name: self.session_name.clone(),
            active_window_id: self.active_window_id.clone(),
            active_pane_id,
            panes,
            windows,
            total_width,
            total_height,
            focus_request: self.focus_request.clone(),
            seq: self.delta_seq,
        }
    }
}
