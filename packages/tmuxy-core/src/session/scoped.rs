//! A tmux target of a task's own, over the process-wide one.
//!
//! The desktop app's later windows each choose where they attach: a session on
//! this machine, or a tmux server over SSH. Everything that window does — its
//! control-mode connection, the reads its monitor and its commands make — has
//! to resolve that window's socket, session and ssh host, while the first
//! window and the CLI keep the process-wide [`super::connect_target`].
//!
//! A window's work runs inside [`with_cell`], which makes its [`TargetCell`]
//! the task's; [`super::connect_target`] reads the cell first. The cell is
//! shared and writable so a window can be pointed elsewhere while its monitor
//! runs, the way `tmuxy connect` retargets the first window. A task spawned
//! from inside one does not inherit it: wrap the spawned future with
//! [`inherit`].

use std::future::Future;
use std::sync::{Arc, RwLock};

use super::ConnectTarget;

/// One window's target: `None` until it has chosen one, which reads as the
/// process-wide target.
pub type TargetCell = Arc<RwLock<Option<ConnectTarget>>>;

tokio::task_local! {
    static CELL: TargetCell;
}

/// Run `fut` with `cell` as the target every tmux invocation inside it resolves.
pub async fn with_cell<F: Future>(cell: TargetCell, fut: F) -> F::Output {
    CELL.scope(cell, fut).await
}

/// `fut`, carrying the calling task's cell if it has one: for a future about
/// to be spawned, which would otherwise resolve the process-wide target.
pub fn inherit<F: Future>(fut: F) -> impl Future<Output = F::Output> {
    let cell = CELL.try_with(Arc::clone).ok();
    async move {
        match cell {
            Some(cell) => CELL.scope(cell, fut).await,
            None => fut.await,
        }
    }
}

/// Point the calling task's window at `target`, when the task runs inside
/// [`with_cell`]; `false` (nothing written) when it does not.
pub fn retarget(target: ConnectTarget) -> bool {
    CELL.try_with(|cell| {
        *cell
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(target);
    })
    .is_ok()
}

/// The calling task's own target, when it runs inside [`with_cell`] and the
/// cell holds one.
pub(super) fn task_target() -> Option<ConnectTarget> {
    CELL.try_with(|cell| {
        cell.read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    })
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(socket: &str, ssh: Option<&str>) -> ConnectTarget {
        ConnectTarget {
            socket: socket.to_string(),
            session: "work".to_string(),
            ssh: ssh.map(String::from),
        }
    }

    #[tokio::test]
    async fn a_task_resolves_its_own_target_and_a_spawned_one_inherits_it() {
        let cell: TargetCell = Arc::new(RwLock::new(Some(target("remote", Some("me@box")))));
        with_cell(cell.clone(), async {
            assert_eq!(super::super::tmux_socket(), "remote");
            assert_eq!(super::super::session_name(), "work");
            assert_eq!(super::super::ssh_target(), Some(vec!["me@box".to_string()]));
            let spawned = tokio::spawn(inherit(async { super::super::tmux_socket() }));
            assert!(matches!(spawned.await.as_deref(), Ok("remote")));
        })
        .await;
        // Outside the scope: the process-wide target, never the window's.
        assert_ne!(super::super::ssh_target(), Some(vec!["me@box".to_string()]));

        // Retargeted while running, the next read sees the new one whole.
        with_cell(cell.clone(), async {
            assert!(retarget(target("other", None)));
            assert_eq!(super::super::tmux_socket(), "other");
            assert_eq!(super::super::ssh_target(), None);
        })
        .await;
    }

    #[tokio::test]
    async fn an_empty_cell_reads_as_the_process_wide_target() {
        let cell: TargetCell = Arc::new(RwLock::new(None));
        let inside = with_cell(cell, async { super::super::tmux_socket() }).await;
        assert_eq!(inside, super::super::tmux_socket());
    }
}
