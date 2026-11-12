//! A pane nobody is shown, sent less often.
//!
//! A pane in a tab the session is not showing (not its active window, and
//! not a float or sidebar, which are drawn over it) is on no client's
//! screen; an agent's spinner there redraws twenty times a second, and every
//! frame used to cross the link in full (`perf:hidden-bytes`). Its screen
//! changes (content, cursor, scrollback size, images) now go out at most
//! once per [`HIDDEN_PANE_EVERY`]: the first at once, then the latest when
//! the interval ends, so the client's copy is never older than that and its
//! last frame always arrives. Anything else about the pane (its state, title,
//! size, a question it asks) goes at once, and so does all of it the moment
//! its tab is shown.
//!
//! A pane held back keeps its last sent copy in `prev_state`, so the delta
//! that finally carries it holds every change since: nothing is lost, only
//! frames in between are skipped.

use std::collections::HashMap;
use std::time::Duration;

use super::Instant;
use crate::{PaneDelta, PaneId, TmuxState};

/// How often a hidden pane's screen is sent while it keeps changing.
pub const HIDDEN_PANE_EVERY: Duration = Duration::from_secs(1);

/// When each hidden pane's screen was last sent, and when one held back is due.
#[derive(Debug, Default)]
pub(crate) struct HiddenPanes {
    sent: HashMap<PaneId, Instant>,
    due: Option<Instant>,
}

/// Whether `pane` is on no client's screen in `state`: its window is not the
/// active one, and is no float or sidebar (those are drawn over the active
/// tab, so they count as shown). A pane whose window is unknown (a hidden group member, parked in a
/// session of its own) is shown by no one either.
pub(crate) fn is_hidden(state: &TmuxState, pane: &crate::TmuxPane) -> bool {
    if state.active_window_id.as_ref() == Some(&pane.window_id) {
        return false;
    }
    !state.windows.iter().any(|window| {
        window.id == pane.window_id
            && window
                .window_type
                .is_some_and(|kind| kind != crate::WindowType::Tab)
    })
}

/// Whether `delta` changes only what is drawn inside the pane: such a change
/// may wait. Read by clearing those fields and asking what is left, so a
/// field added to [`PaneDelta`] later goes at once until it is listed here.
fn screen_only(delta: &PaneDelta) -> bool {
    let mut rest = delta.clone();
    rest.content = None;
    rest.cursor_x = None;
    rest.cursor_y = None;
    rest.cursor_shape = None;
    rest.cursor_hidden = None;
    rest.history_size = None;
    rest.images = None;
    rest.is_empty()
}

impl HiddenPanes {
    /// Whether `delta` of a pane goes out now. A hidden pane's screen change
    /// within [`HIDDEN_PANE_EVERY`] of the last one sent waits, and the time
    /// it is due is kept for [`Self::due`].
    pub(crate) fn send_now(
        &mut self,
        pane: &PaneId,
        hidden: bool,
        delta: &PaneDelta,
        now: Instant,
    ) -> bool {
        if !hidden || !screen_only(delta) {
            self.sent.remove(pane);
            return true;
        }
        match self.sent.get(pane) {
            Some(&last) if now < last + HIDDEN_PANE_EVERY => {
                let at = last + HIDDEN_PANE_EVERY;
                self.due = Some(self.due.map_or(at, |due| due.min(at)));
                false
            }
            _ => {
                self.sent.insert(pane.clone(), now);
                true
            }
        }
    }

    /// The panes of the last update are all accounted for: forget what was
    /// due, before [`Self::send_now`] is asked about the next one.
    pub(crate) fn start_update(&mut self, panes: &[crate::TmuxPane]) {
        self.due = None;
        self.sent
            .retain(|id, _| panes.iter().any(|pane| &pane.tmux_id == id));
    }

    /// When a held-back pane is due, for the monitor to send it then.
    pub(crate) fn due(&self) -> Option<Instant> {
        self.due
    }
}

#[cfg(test)]
mod tests;
