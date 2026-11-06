//! Sizing every window to the client's viewport: tmuxy sets `window-size
//! manual`, so tmux sizes nothing on its own, and an untargeted `resizew`
//! only reaches the session's current window.

use super::*;
use tracing::warn;

/// Size one window. The window was set to `window-size manual` when the
/// aggregator first saw it (`window_setup_commands`), so tmux keeps the size.
pub(super) fn resize_command(window_id: &WindowId, (cols, rows): (u32, u32)) -> String {
    format!("resizew -t {window_id} -x {cols} -y {rows}")
}

/// How many times running a window may be asked for the SAME size before the
/// monitor stops asking. Sizing is judged by what tmux reports, so a window
/// that took the size stops being asked after one command whatever this is;
/// this only bounds the case where tmux will not take it, which would
/// otherwise be a `resizew` on every control-mode step for the session's life.
pub(super) const MAX_RESIZE_ATTEMPTS: u8 = 3;

/// Should this window be sent a `resizew` for `desired`?
///
/// `actual` is what tmux reports the window's grid to be (`None` before any
/// pane of it has been seen), `asked` the size last requested, how many times
/// running, and which `list-panes` report was current when it was last asked;
/// `reports` is the report count now. tmux's report is the authority: a
/// window already at the size is done no matter how it got there, and one
/// that is not gets asked again, because a `resizew` can be dropped and
/// believing the send left the client asking for a size tmux never applied.
///
/// An ask is judged by the report that FOLLOWS it, so until a new report has
/// arrived there is nothing to judge and no second ask. This runs on every
/// control-mode step, and counting a step as an attempt burned the whole
/// budget in the first thirty milliseconds of an attach — three `resizew`s
/// before tmux had reported a single pane — after which the window was never
/// asked again, and a phone-width client kept the control-mode PTY's 200
/// columns. The count only stops a size tmux refuses from becoming a command
/// on every report.
pub(super) fn needs_resize(
    actual: Option<(u32, u32)>,
    desired: (u32, u32),
    asked: Option<((u32, u32), u8, u64)>,
    reports: u64,
) -> bool {
    if actual == Some(desired) {
        return false;
    }
    match asked {
        Some((prev, tries, asked_at)) if prev == desired => {
            reports != asked_at && tries < MAX_RESIZE_ATTEMPTS
        }
        _ => true,
    }
}

impl<W> MonitorCore<W> {
    /// The `resizew`s that bring every known window to the client's size,
    /// once one is known: a sidebar to its own column ([`sidebar_dock`]
    /// sizing — docked beside the pane grid, a full-width shell would wrap at
    /// the viewport's columns while the UI draws it 40 cells wide), every
    /// other window to the viewport.
    ///
    /// [`sidebar_dock`]: crate::constants::sidebar_dock
    pub(super) fn size_windows(&mut self) -> Option<Action<W>> {
        let (cols, rows) = self.client_size?;
        let (viewport_windows, sidebar_windows) = self.aggregator.window_ids_by_sizing();
        if viewport_windows.is_empty() && sidebar_windows.is_empty() {
            return None;
        }
        // A sidebar runs the full height of the app body in its own column
        // width. It keeps the viewport's rows unless the client set the rows
        // its column holds (the dock's rows are shorter than the pane grid's
        // — see `tmux_options::SIDEBAR_ROWS`).
        let desired: Vec<(WindowId, (u32, u32))> = viewport_windows
            .into_iter()
            .map(|wid| (wid, (cols, rows)))
            .chain(
                sidebar_windows
                    .into_iter()
                    .map(|(wid, sidebar_cols, sidebar_rows)| {
                        (wid, (sidebar_cols, sidebar_rows.unwrap_or(rows).max(1)))
                    }),
            )
            .collect();

        // Drop windows that are gone, so nothing inherits a stale retry count.
        let live: HashSet<&WindowId> = desired.iter().map(|(wid, _)| wid).collect();
        self.resize_attempts.retain(|wid, _| live.contains(wid));
        self.resize_given_up.retain(|wid| live.contains(wid));
        let reports = self.aggregator.pane_reports;

        // tmux's own report decides whether a window still needs sizing. A
        // window already AT the wanted size is done however many commands it
        // took; one that is not is asked again, because the previous `resizew`
        // may simply never have landed. `MAX_RESIZE_ATTEMPTS` keeps that from
        // becoming a command per step forever if tmux will not take the size.
        let pending: Vec<&(WindowId, (u32, u32))> = desired
            .iter()
            .filter(|(wid, size)| {
                needs_resize(
                    self.aggregator.window_extent(wid),
                    *size,
                    self.resize_attempts.get(wid).copied(),
                    reports,
                )
            })
            .collect();
        if pending.is_empty() {
            // Nothing to send. If a window is nevertheless still the wrong
            // size, we have stopped asking — say so once, because silence here
            // is indistinguishable from success and leaves the client drawing
            // a grid tmux never agreed to (a phone asking for 41 columns and
            // getting the control-mode PTY's 200 is what this looked like).
            for (wid, size) in &desired {
                let actual = self.aggregator.window_extent(wid);
                if actual == Some(*size) {
                    continue;
                }
                let tries = self.resize_attempts.get(wid).map_or(0, |a| a.1);
                if tries >= MAX_RESIZE_ATTEMPTS && self.resize_given_up.insert(wid.clone()) {
                    warn!(
                        window = %wid,
                        wanted = ?size,
                        actual = ?actual,
                        tries,
                        "tmux will not take this window size; no longer asking"
                    );
                }
            }
            return None;
        }
        debug!(
            count = pending.len(),
            cols, rows, "applying client size to windows"
        );
        let mut commands = Vec::with_capacity(pending.len());
        for (wid, size) in pending {
            // Asking again means the size is not settled, so a later refusal
            // is worth reporting afresh.
            self.resize_given_up.remove(wid);
            commands.push(resize_command(wid, *size));
            match self.resize_attempts.get_mut(wid) {
                Some(entry) if entry.0 == *size => {
                    entry.1 = entry.1.saturating_add(1);
                    entry.2 = reports;
                }
                _ => {
                    self.resize_attempts
                        .insert(wid.clone(), (*size, 1, reports));
                }
            }
        }
        Some(Action::Send(commands))
    }
}
