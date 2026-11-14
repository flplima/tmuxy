//! When a diff's turn ([`crate::diff_review::turn`]) starts and ends: from the socket's pane rows, a pane entering
//! `working` starts one and coming to rest (neither working nor asking the
//! user something) ends it, in the checkout of each diff
//! widget of its tab that holds the pane's folder. Nothing is read or
//! snapshotted while no diff widget is open.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::constants::tmux_options::PANE_DIFF;
use crate::diff_review::{turn, WIDGET};
use crate::host::socket_watch::{PaneRow, Rows};
use crate::PaneStateName;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    Began,
    Ended,
}

/// Whether a pane in `state` is in a turn: at work, or asking the user
/// something on the way (answering goes on with the same turn).
fn in_turn(state: &str) -> bool {
    [PaneStateName::Working, PaneStateName::NeedsInput]
        .iter()
        .any(|s| s.as_str() == state)
}

/// The panes whose agent started a turn or came to rest since `before` (each
/// pane's state then), in row order.
pub fn transitions(
    before: &HashMap<String, String>,
    rows: &[PaneRow],
) -> Vec<(String, Transition)> {
    rows.iter()
        .filter_map(|row| {
            let was = before.get(&row.pane_id).is_some_and(|state| in_turn(state));
            match (was, in_turn(&row.state)) {
                (false, true) => Some((row.pane_id.clone(), Transition::Began)),
                (true, false) => Some((row.pane_id.clone(), Transition::Ended)),
                _ => None,
            }
        })
        .collect()
}

/// One `#{…}` of a pane, as tmux answers it; `None` when it cannot be read.
fn pane_value(pane: &str, format: &str) -> Option<String> {
    let out = crate::session::tmux_command()
        .args(["display-message", "-p", "-t", pane, format])
        .output()
        .ok()?;
    let value = String::from_utf8_lossy(&out.stdout)
        .trim_end_matches('\n')
        .to_string();
    (out.status.success() && !value.is_empty()).then_some(value)
}

fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// One pass: the diff widgets' checkouts, by tab; each transition of a pane
/// whose folder is inside one of its tab's checkouts begins or ends a turn
/// there; every other checkout's turn is forgotten.
fn pass(rows: &[PaneRow], changes: &[(String, Transition)]) {
    let widgets: Vec<(String, PathBuf)> = rows
        .iter()
        .filter(|row| row.widget == WIDGET)
        .filter_map(|row| {
            let root = pane_value(&row.pane_id, &format!("#{{{PANE_DIFF}}}"))?;
            Some((row.window_id.clone(), PathBuf::from(root)))
        })
        .filter(|(_, root)| root.is_absolute())
        .collect();
    for (pane, change) in changes {
        let Some(row) = rows.iter().find(|row| &row.pane_id == pane) else {
            continue;
        };
        let roots: Vec<&PathBuf> = widgets
            .iter()
            .filter(|(window, _)| *window == row.window_id)
            .map(|(_, root)| root)
            .collect();
        if roots.is_empty() {
            continue;
        }
        let Some(folder) = pane_value(pane, "#{pane_current_path}").map(PathBuf::from) else {
            continue;
        };
        let folder = real(&folder);
        for root in roots
            .into_iter()
            .filter(|root| folder.starts_with(real(root)))
        {
            match change {
                Transition::Began => turn::begin(root, pane),
                Transition::Ended => turn::finish(root, pane),
            }
        }
    }
    let shown: Vec<PathBuf> = widgets.into_iter().map(|(_, root)| root).collect();
    turn::keep_only(&shown);
}

/// Follow the socket's pane rows for as long as the future runs.
pub async fn watch(mut rows: Rows) {
    let _ = tokio::task::spawn_blocking(turn::prune_stale_stores).await;
    let mut before: Option<HashMap<String, String>> = None;
    while rows.changed().await.is_ok() {
        let now = std::sync::Arc::clone(&rows.borrow_and_update());
        let states: HashMap<String, String> = now
            .iter()
            .map(|row| (row.pane_id.clone(), row.state.clone()))
            .collect();
        // What is already working when the host starts is no turn it saw begin.
        let changes = before
            .replace(states)
            .map(|before| transitions(&before, &now))
            .unwrap_or_default();
        let quiet = changes.is_empty() && !now.iter().any(|row| row.widget == WIDGET);
        if quiet {
            turn::keep_only(&[]);
            continue;
        }
        let _ = tokio::task::spawn_blocking(move || pass(&now, &changes)).await;
    }
}

#[cfg(test)]
mod tests;
