//! The one poll of every pane on the socket, run by whichever host is up.
//!
//! A pane's `@tmuxy-pane-state` is written by whatever runs in it (an
//! agent's hooks, `tmuxy pane state`, a send's question) and tmux announces
//! no option change. A monitor would see it, but there is one only while a
//! client watches that session. So the host reads every pane itself, with
//! one `list-panes -a` across every session: a read, which tmux runs safely
//! beside an attached control-mode client (docs/TMUX.md).

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

pub mod agent_screen;

pub const INTERVAL: Duration = Duration::from_millis(1500);

/// Tab-separated, the free-text fields last (a window name may hold a tab).
pub fn panes_format() -> String {
    use crate::constants::tmux_options::PANE_WIDGET;
    format!(
        "#{{pane_id}}\t#{{session_name}}\t#{{@tmuxy-notify}}\t#{{@tmuxy-pane-state}}\t\
         #{{pane_current_command}}\t#{{window_id}}\t#{{{PANE_WIDGET}}}\t#{{@tmuxy-ask}}\t\
         #{{@tmuxy-label}}\t#{{window_name}}"
    )
}

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
    /// The tab, `@N`.
    pub window_id: String,
    /// The widget the pane shows (`@tmuxy-pane-widget`), empty for none.
    pub widget: String,
}

/// A line missing a field is skipped.
pub fn parse_rows(listing: &str) -> Vec<PaneRow> {
    listing
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(10, '\t').collect();
            let [pane_id, session, notify, state, command, window_id, widget, ask, label, window] =
                f[..]
            else {
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
                window_id: window_id.to_string(),
                widget: widget.to_string(),
            })
        })
        .collect()
}

/// `None` when there is no tmux server to ask.
pub fn read_panes() -> Option<Vec<PaneRow>> {
    let output = crate::session::tmux_command()
        .args(["list-panes", "-a", "-F", &panes_format()])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_rows(&String::from_utf8_lossy(&output.stdout)))
}

/// The rows as last read: empty until the first read.
pub type Rows = watch::Receiver<Arc<Vec<PaneRow>>>;

/// Read the panes every [`INTERVAL`] for as long as the future runs,
/// correcting agent panes from their screens and publishing each read (a
/// server that cannot be asked publishes nothing).
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

pub fn channel() -> (watch::Sender<Arc<Vec<PaneRow>>>, Rows) {
    watch::channel(Arc::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The format asks for the fields `parse_rows` reads, in its order.
    #[test]
    fn the_format_has_a_field_for_each_one_a_row_reads() {
        let format = panes_format();
        let fields: Vec<&str> = format.split('\t').collect();
        assert_eq!(fields.len(), 10);
        let widget = format!("#{{{}}}", crate::constants::tmux_options::PANE_WIDGET);
        assert_eq!((fields[5], fields[6]), ("#{window_id}", widget.as_str()));
    }

    #[test]
    fn a_pane_list_row_reads_into_its_fields() {
        let rows = parse_rows(
            "%3\twork\ton\tworking\tclaude\t@1\t\t\t\tmain\n\
             %4\twork\ton\t\tzsh\t@2\tdiff\t\tbuild\tside\twith\ttabs\n\
             %5\twork\toff\tneeds-input\t2.1.30\t@1\t\tMay I?\t\tmain\n\
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
                window_id: "@1".into(),
                widget: String::new(),
            }
        );
        assert_eq!(
            (rows[1].window_id.as_str(), rows[1].widget.as_str()),
            ("@2", "diff")
        );
        assert_eq!(rows[1].label, "build");
        assert_eq!(rows[1].window, "side\twith\ttabs");
        assert!(rows[2].asking);
    }
}
