use super::*;

/// Size one window, having first made sure tmux will let us.
///
/// `window-size` and `aggressive-resize` are WINDOW options. The pair set at
/// attach reaches only whichever window was current then, so every other one
/// keeps tmux's default `window-size latest` — under which tmux sizes the
/// window to the latest attached client and undoes the `resizew`. The
/// control-mode PTY is 200x50, which is exactly the grid a phone-width client
/// was left stuck with.
///
/// Sent per window, immediately before its resize: idempotent, and it needs no
/// bookkeeping about which windows have been seen.
pub(super) fn window_sizing_commands(
    window_id: &WindowId,
    (cols, rows): (u32, u32),
) -> [String; 3] {
    [
        format!("setw -t {window_id} window-size manual"),
        format!("setw -t {window_id} aggressive-resize off"),
        format!("resizew -t {window_id} -x {cols} -y {rows}"),
    ]
}

/// The `resizew` that gives a freshly attached session the initial PTY size.
///
/// The session name is quoted: it reaches the monitor from a client
/// (`GET /events?session=`), and control mode reads an unquoted `;` in a
/// command line as the start of another command.
pub(super) fn initial_resize_command(session: &str) -> String {
    format!(
        "resizew -t {} -x {} -y {}",
        crate::executor::tmux_quote(session),
        INITIAL_PTY_COLS,
        INITIAL_PTY_ROWS
    )
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

impl<C: ControlLink> TmuxMonitor<C> {
    /// Resize every window the aggregator knows about to the remembered client
    /// size. No-op until a client has actually reported a size.
    ///
    /// tmuxy sets `window-size manual`, so tmux will not size windows on its
    /// own — every window has to be resized explicitly, and an untargeted
    /// `resizew` only reaches the session's *current* window.
    ///
    /// The pinned sidebar window is the one exception: it is docked beside the
    /// pane grid, not behind it, so it gets [`sidebar_dock::size`] instead of
    /// the viewport. Giving it the full width would make its shell wrap at the
    /// viewport's columns while the UI draws it 40 cells wide.
    pub(super) async fn apply_client_size<E: StateEmitter>(&mut self, emitter: &E) {
        let Some((cols, rows)) = self.client_size else {
            return;
        };
        let (viewport_windows, sidebar_windows) = self.aggregator.window_ids_by_sizing();
        if viewport_windows.is_empty() && sidebar_windows.is_empty() {
            return;
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
        let desired_snapshot = desired.clone();
        let reports = self.aggregator.pane_reports;

        // tmux's own report decides whether a window still needs sizing. A
        // window already AT the wanted size is done however many commands it
        // took; one that is not is asked again, because the previous `resizew`
        // may simply never have landed. `MAX_RESIZE_ATTEMPTS` keeps that from
        // becoming a command per step forever if tmux will not take the size.
        let pending: Vec<(WindowId, (u32, u32))> = desired
            .into_iter()
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
            for (wid, size) in &desired_snapshot {
                let actual = self.aggregator.window_extent(wid);
                if actual == Some(*size) {
                    continue;
                }
                let tries = self.resize_attempts.get(wid).map_or(0, |a| a.1);
                if tries >= MAX_RESIZE_ATTEMPTS && !self.resize_given_up.contains(wid) {
                    self.resize_given_up.insert(wid.clone());
                    warn!(
                        window = %wid,
                        wanted = ?size,
                        actual = ?actual,
                        tries,
                        "tmux will not take this window size; no longer asking"
                    );
                }
            }
            return;
        }
        // Asking again means the size is not settled, so a later refusal is
        // worth reporting afresh.
        for (wid, _) in &pending {
            self.resize_given_up.remove(wid);
        }

        // `window-size` and `aggressive-resize` are WINDOW options, and the
        // pair set at attach (`sync_initial_state`, `enforce_settings`) reached
        // only the window that happened to be current then. Any other window —
        // a tab made later, or simply a different one at attach — kept tmux's
        // default `window-size latest`, under which tmux sizes the window to
        // the latest attached client and undoes the `resizew` below: the
        // control-mode PTY is 200x50, which is exactly the grid a phone-width
        // client was stuck with (`targetCols: 41, totalWidth: 200`).
        //
        // Setting it per window, immediately before the resize, is idempotent
        // and needs no bookkeeping about which windows have been seen.
        let cmds: Vec<String> = pending
            .iter()
            .flat_map(|(wid, size)| window_sizing_commands(wid, *size))
            .collect();
        debug!(
            count = pending.len(),
            cols, rows, "applying client size to windows"
        );
        if let Err(e) = self.connection.send_commands_batch(&cmds).await {
            emitter.emit_error(format!("Failed to resize windows: {}", e));
        } else {
            for (wid, size) in pending {
                match self.resize_attempts.get_mut(&wid) {
                    Some(entry) if entry.0 == size => {
                        entry.1 = entry.1.saturating_add(1);
                        entry.2 = reports;
                    }
                    _ => {
                        self.resize_attempts.insert(wid, (size, 1, reports));
                    }
                }
            }
        }
    }

    /// After WindowAdd: list-panes BEFORE list-windows. break-pane creating a float
    /// window leaves the new pane absent from `self.panes` until list-panes restores
    /// it; list-windows would otherwise emit state with the pane missing.
    pub(super) async fn refresh_after_window_add<E: StateEmitter>(&mut self, emitter: &E) {
        let cmds = window_relist_commands();
        if let Err(e) = self.connection.send_commands_batch(&cmds).await {
            emitter.emit_error(format!("Failed to refresh state after window add: {}", e));
        }
    }

    /// Send list-panes (for fresh cursor positions) followed by capture-pane for
    /// each pane that flagged itself as needing refresh. Ordering is load-bearing:
    /// list-panes must precede capture-pane so the cursor repositioning logic uses
    /// the updated `tmux_cursor_x/y` when capture responses arrive.
    pub(super) async fn refresh_panes<E: StateEmitter>(
        &mut self,
        emitter: &E,
        pane_ids: &[PaneId],
    ) {
        let queued_panes = self.aggregator.queue_captures(pane_ids);
        let commands = self
            .aggregator
            .markers()
            .pane_refresh_commands(&queued_panes);
        if let Err(e) = self.connection.send_commands_batch(&commands).await {
            emitter.emit_error(format!("Failed to batch capture panes: {}", e));
        }
    }
}
