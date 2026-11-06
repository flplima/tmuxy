//! The one poll of every pane on the socket, run by whichever host is up.
//!
//! A pane's `@tmuxy-pane-state` is written by whatever runs in it (an
//! agent's hooks, `tmuxy pane state`, a send's question) and tmux announces
//! no option change. A monitor would see it, but there is one only while a
//! client watches that session. So the host reads every pane itself, with
//! one read-only `list-panes -a` across every session — a read, which tmux
//! runs safely beside an attached control-mode client (docs/TMUX.md) — and
//! hands the rows to what follows them: the agent-dialog correction
//! ([`agent_screen`]), on every host, and the web's push notifications.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

pub mod agent_screen;

/// How often the panes are read.
pub const INTERVAL: Duration = Duration::from_millis(1500);

/// One `list-panes -a` row, tab-separated, the free-text fields last.
pub const PANES_FORMAT: &str = "#{pane_id}\t#{session_name}\t#{@tmuxy-notify}\t\
     #{@tmuxy-pane-state}\t#{pane_current_command}\t#{@tmuxy-ask}\t#{@tmuxy-label}\t\
     #{window_name}";

/// A pane, as [`PANES_FORMAT`] prints it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PaneRow {
    pub pane_id: String,
    pub session: String,
    /// `@tmuxy-notify` as the pane resolves it (the global option).
    pub notify: String,
    pub state: String,
    pub command: String,
    /// A send's question is up on the pane: the state is the question's.
    pub asking: bool,
    pub label: String,
    pub window: String,
}

/// The rows of a [`PANES_FORMAT`] listing; a line missing a field is skipped.
pub fn parse_rows(listing: &str) -> Vec<PaneRow> {
    listing
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(8, '\t').collect();
            let [pane_id, session, notify, state, command, ask, label, window] = f[..] else {
                return None;
            };
            Some(PaneRow {
                pane_id: pane_id.to_string(),
                session: session.to_string(),
                notify: notify.to_string(),
                state: state.to_string(),
                command: command.to_string(),
                asking: !ask.is_empty(),
                label: label.to_string(),
                window: window.to_string(),
            })
        })
        .collect()
}

/// Whether a process name is a bare version: Claude Code runs as
/// `…/claude/versions/<version>`, so its pane's command reads `2.1.30`.
pub fn is_version(command: &str) -> bool {
    command.contains('.')
        && command
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Every pane on the socket, read with one read-only `list-panes -a`;
/// `None` when there is no tmux server to ask.
pub fn read_panes() -> Option<Vec<PaneRow>> {
    let output = crate::session::tmux_command()
        .args(["list-panes", "-a", "-F", PANES_FORMAT])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_rows(&String::from_utf8_lossy(&output.stdout)))
}

/// The rows as last read: empty until the first read.
pub type Rows = watch::Receiver<Arc<Vec<PaneRow>>>;

/// Read the panes every [`INTERVAL`], for as long as the future runs,
/// publishing each read (a server that cannot be asked publishes nothing),
/// and correcting agent panes from their screens as it goes. `watch` is how
/// the host's other consumers subscribe.
pub async fn run(watch: watch::Sender<Arc<Vec<PaneRow>>>) {
    let mut corrector = agent_screen::Corrector::default();
    loop {
        tokio::time::sleep(INTERVAL).await;
        // A pass that panicked starts the next from nothing seen.
        let (back, rows) = tokio::task::spawn_blocking(move || {
            let rows = read_panes();
            if let Some(rows) = &rows {
                corrector.pass(rows);
            }
            (corrector, rows)
        })
        .await
        .unwrap_or_default();
        corrector = back;
        if let Some(rows) = rows {
            watch.send_replace(Arc::new(rows));
        }
    }
}

/// A channel [`run`] publishes to, and its first receiver.
pub fn channel() -> (watch::Sender<Arc<Vec<PaneRow>>>, Rows) {
    watch::channel(Arc::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pane_list_row_reads_into_its_fields() {
        let rows = parse_rows(
            "%3\twork\ton\tworking\tclaude\t\t\tmain\n\
             %4\twork\ton\t\tzsh\t\tbuild\tside\twith\ttabs\n\
             %5\twork\toff\tneeds-input\t2.1.30\tMay I?\t\tmain\n\
             %6\ttoo\tshort\n",
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0],
            PaneRow {
                pane_id: "%3".into(),
                session: "work".into(),
                notify: "on".into(),
                state: "working".into(),
                command: "claude".into(),
                asking: false,
                label: String::new(),
                window: "main".into(),
            }
        );
        assert_eq!(rows[1].label, "build");
        assert_eq!(rows[1].window, "side\twith\ttabs");
        assert!(rows[2].asking);
    }

    #[test]
    fn a_bare_version_is_a_version() {
        assert!(is_version("2.1.30"));
        assert!(!is_version("claude"));
        assert!(!is_version("2..1"));
        assert!(!is_version("v2.1"));
    }
}
