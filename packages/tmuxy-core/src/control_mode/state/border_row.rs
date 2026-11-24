//! The row tmux takes out of a pane for its border status line.
//!
//! A `%layout-change` describes layout cells, `list-panes` the panes in them,
//! and under `pane-border-status top` the two differ: the status line of a
//! cell on the window's top edge has no separator above it to sit on, so
//! tmux takes it out of the pane (`layout_fix_panes`), a row lower and a row
//! shorter than its cell. Read as they came, a tab's top panes were 30 rows
//! after every layout and 29 after every list, and each report undid the
//! other's size: a capture each, at attach and on every resize.
//!
//! tmux announces no change of the option, so what a window has is read off
//! the list: with the row on top, none of its panes is at y=0.

use super::window_state::WindowSetup;
use super::*;

impl StateAggregator {
    /// Each window's border row, from the panes the last `list-panes`
    /// placed.
    pub(super) fn learn_border_rows(&mut self) {
        let mut highest: HashMap<WindowId, u32> = HashMap::new();
        for pane in self.panes.values() {
            if let Some(window_id) = &pane.window_id {
                let top = highest.entry(window_id.clone()).or_insert(pane.y);
                *top = (*top).min(pane.y);
            }
        }
        self.border_top = highest
            .into_iter()
            .map(|(window_id, top)| (window_id, top > 0))
            .collect();
    }

    /// `window_id` is about to be set to `top`: until a list shows it, what
    /// was read before stands only if it already was.
    pub(super) fn border_row_set(&mut self, window_id: &WindowId, top: bool) {
        if self.border_top.get(window_id) != Some(&top) {
            self.border_top.remove(window_id);
        }
    }

    /// The pane a layout cell of `window_id` holds, as tmux places it. A
    /// window's layout is rooted at its top-left corner, so a cell on the top
    /// edge is one at y=0. Only a window a list has shown with the row on
    /// top, and never one tmuxy sets up without it (a sidebar, a float):
    /// otherwise the cell is taken as the pane, and a list that says
    /// otherwise asks a capture, as before.
    pub(super) fn pane_in_cell(&self, window_id: &WindowId, cell: LayoutPane) -> LayoutPane {
        let borderless = matches!(
            self.window_setup.get(window_id),
            Some(WindowSetup::Sidebar | WindowSetup::Float)
        );
        if cell.y != 0 || borderless || self.border_top.get(window_id) != Some(&true) {
            return cell;
        }
        LayoutPane {
            y: 1,
            height: if cell.height > 1 {
                cell.height - 1
            } else {
                cell.height
            },
            ..cell
        }
    }
}
