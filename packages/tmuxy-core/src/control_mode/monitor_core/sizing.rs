//! Sizing every window to the client's viewport: tmuxy sets `window-size
//! manual`, so tmux sizes nothing on its own, and an untargeted `resizew`
//! only reaches the session's current window.

use super::*;
use tracing::warn;

/// The window was set to `window-size manual` when the aggregator first saw
/// it (`window_setup_commands`), so tmux keeps the size.
pub(super) fn resize_command(window_id: &WindowId, (cols, rows): (u32, u32)) -> String {
    format!("resizew -t {window_id} -x {cols} -y {rows}")
}

/// Bounds a size tmux will not take, which would otherwise be a `resizew` on
/// every control-mode report for the session's life.
pub(super) const MAX_RESIZE_ATTEMPTS: u8 = 3;

/// `actual` is what tmux reports the window's grid to be (`None` before any
/// pane of it has been seen), `asked` the size last requested, how many times
/// running, and which `list-panes` report was current when it was last asked;
/// `reports` is the report count now. tmux's report is the authority, because
/// a `resizew` can be dropped.
///
/// An ask is judged by the report that follows it: tmux reports nothing in
/// the first steps of an attach, and counting steps spent the whole budget
/// before the first report, leaving a phone-width client at the control-mode
/// PTY's 200 columns.
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
    /// A sidebar is sized to its own column ([`sidebar_dock`]): docked beside
    /// the pane grid, a full-width shell would wrap at the viewport's columns
    /// while the UI draws it 40 cells wide.
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

        let live: HashSet<&WindowId> = desired.iter().map(|(wid, _)| wid).collect();
        self.resize_attempts.retain(|wid, _| live.contains(wid));
        self.resize_given_up.retain(|wid| live.contains(wid));
        let reports = self.aggregator.pane_reports;
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
            // A window still the wrong size has stopped being asked: said
            // once, since silence here looks like success while the client
            // draws a grid tmux never agreed to.
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
