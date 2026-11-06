use super::*;
use crate::constants::tmux_formats::{Row, StashColumn};
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

/// Normalised once, in the backend state, so no surface shows Claude Code's
/// version number where `#{pane_current_command}` should read `claude`
/// ([`crate::program::program_name`]).
pub(super) fn normalize_pane_command(command: &str) -> String {
    crate::program::program_name(command).to_string()
}

#[derive(Debug, Clone)]
pub(super) struct StashMember {
    /// The pane's window in the stash session (never the attached session's
    /// active window, so the frontend treats the emitted stub as hidden).
    pub(super) window_id: WindowId,
    pub(super) group_id: GroupId,
    /// `@tmuxy-group-pos`, when the group has been reordered.
    pub(super) group_pos: Option<u32>,
    pub(super) command: String,
    pub(super) title: String,
}

/// The frontend reads only a stub's id, group, command and title, to draw the
/// member's tab; its content streams once it is swapped into view.
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
        history_size: 0,
        selection_present: false,
        selection_start_x: 0,
        selection_start_y: 0,
        images: Vec::new(),
        cursor_shape: 0,
        cursor_hidden: false,
        pane_state: None,
        pane_ask: None,
        pane_widget: None,
        pane_restore: None,
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

    /// When to wake for `tick(now)`, while settling is armed.
    pub fn settling_deadline(&self) -> Option<Instant> {
        self.settling_until
    }

    pub fn is_settling(&self) -> bool {
        self.settling_until.is_some()
    }

    /// Clear settling without firing an emit (a settling command that could
    /// not be sent).
    pub fn clear_settling(&mut self) {
        self.settling_until = None;
        self.settling_started = None;
        self.settling_awaiting_first_event = false;
        self.suppress_window_emissions = false;
    }

    /// A structural change during settling pushes the deadline out by the
    /// debounce, never past `SETTLING_MAX` from the first such change.
    pub(super) fn maybe_extend_settling(&mut self, change: ChangeType, now: Instant) {
        if self.settling_until.is_none() || !change.is_structural() {
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

    pub(super) fn rebuild_stash_members(&mut self, output: &str) {
        let mut members = HashMap::new();
        for row in output.lines().filter_map(Row::<StashColumn>::parse) {
            let (Ok(pane_id), Ok(window_id), Ok(group_id)) = (
                PaneId::parse(row.field(StashColumn::PaneId)),
                WindowId::parse(row.field(StashColumn::WindowId)),
                GroupId::parse(row.field(StashColumn::GroupId)),
            ) else {
                continue;
            };
            // A parked member streams no content, so its tab label is tmux's
            // `pane_title` and nothing else — which is exactly where a Kitty
            // graphics probe lands when tmux reads the APC as a title.
            members.insert(
                pane_id,
                StashMember {
                    window_id,
                    group_id,
                    group_pos: row.parse_field(StashColumn::GroupPos),
                    command: normalize_pane_command(&row.text(StashColumn::Command)),
                    title: shown_title(row.text(StashColumn::Title)),
                },
            );
        }
        self.stash_members = members;
    }

    /// Whether `to_tmux_state` would describe the session in full: the
    /// initial list-panes and list-windows have been parsed and no capture is
    /// on its way — a snapshot taken before would carry the blank panes a new
    /// (or moved) pane's emulator holds until capture-pane answers.
    pub fn initial_state_ready(&self) -> bool {
        self.panes_synced && self.windows_synced && self.pending_captures.is_empty()
    }

    pub fn to_tmux_state(&mut self) -> TmuxState {
        let active_window = self.active_window_id.as_ref();

        // Every window's panes go out: the frontend filters them
        // (`selectVisiblePanes`), and holding them is what lets a tab switch
        // render before the server answers. tmux keeps an active pane per
        // window; the frontend treats `active` as unique (keyboard routing,
        // predictions, focus), so only the active window's stays active.
        let mut panes: Vec<TmuxPane> = self
            .panes
            .values_mut()
            .filter_map(|p| {
                let mut pane = p.build_tmux_pane()?;
                pane.active = pane.active && active_window == Some(&pane.window_id);
                Some(pane)
            })
            .collect();

        // The stash members, as stubs a group's tab strip draws. A member
        // whose group has no pane here any more (dissolved, or its tab
        // closed wholesale) is an orphan, not a tab. A stub's stash window
        // is never the active one, so `selectVisiblePanes` keeps it out of
        // the layout.
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

        // The grid's size is the ACTIVE window's extent, what the client sizes
        // its viewport against. A max over every window (hidden group
        // members, floats, a tab left at an older size) made the client ask
        // for a resize on every update and, waiting for a size that never
        // came, keep its layout animations off for good.
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

        // The active pane is the active window's: each window has its own,
        // and a window whose panes are not listed yet has none to name.
        // Naming another window's sent the keys typed into a tab just
        // opened to a pane of a hidden one; with none named, a client's keys
        // go to tmux's current pane.
        let active_pane_id = panes
            .iter()
            .find(|p| p.active && in_active_window(p))
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
            plugins_rev: self.plugins_rev.clone(),
            theme_rev: self.theme_rev.clone(),
            seq: self.delta_seq,
        }
    }
}
