//! What a fresh control-mode client sends once attached, before anything
//! else: the same list for every host.

use super::*;
use crate::constants::tmux_formats;

/// What only the host can say about an attach: the commands that read
/// files (the config chain, the remembered UI choices, the plugins this
/// machine has, the server binary the scripts run). A guest has none of
/// them; its image bakes the config in.
#[derive(Debug, Default)]
pub struct AttachConfig {
    /// Sourcing the config, then the UI choices it leaves unset: the
    /// enforced settings go after both (M11).
    pub config: Vec<String>,
    /// Sent once the settings are enforced.
    pub host: Vec<String>,
}

/// The settings the frontend depends on, whatever the user's config says:
/// with any of them off, input fails or content is corrupted. Each is a
/// session or server option, set without `-g` — docs/TMUX-CONFIG.md records
/// a tmux 3.5a crash with global settings under control mode. The window
/// options are set on each window as it is first seen
/// (`window_setup_commands`): set here, they would reach only the window
/// current at attach.
pub(super) fn enforced_settings() -> Vec<String> {
    [
        ("mouse", "on"),
        ("focus-events", "on"),
        ("set-titles", "on"),
        // tmux honours OSC 52 by loading the text into a paste buffer, and
        // paste buffers are global to the server: a background pane's write
        // reached every client's clipboard through the buffer mirror, past
        // the active-pane gate the aggregator applies to the same sequence.
        // tmuxy carries OSC 52 to the client's clipboard itself.
        ("set-clipboard", "off"),
    ]
    .into_iter()
    .map(|(key, value)| format!("set {key} '{value}'"))
    .collect()
}

impl<W> MonitorCore<W> {
    /// `size` is the grid to start the session's current window at, until a
    /// client reports its viewport.
    pub fn attach_commands(&self, size: (u32, u32), host: AttachConfig) -> Vec<String> {
        // `window-size manual` before the resize, or the resize SIGWINCHes the
        // shell into a prompt redraw that races the captures (M4). Set on the
        // current window only, the one the resize reaches.
        let mut commands = vec![
            "set window-size manual".to_string(),
            format!(
                "resizew -t {} -x {} -y {}",
                crate::tmux_quote(&self.session),
                size.0,
                size.1
            ),
        ];
        commands.extend(host.config);
        commands.extend(enforced_settings());
        commands.extend(host.host);
        // Flow control (tmux 3.2+): tmux pauses a pane whose output this
        // client is 5+ seconds behind on, rather than buffering without bound.
        commands.push("refresh-client -f pause-after=5".to_string());
        // The server's own version, before anything that depends on it.
        commands.push(self.aggregator.markers().version_read_command());
        commands.extend(self.aggregator.markers().window_relist_commands());
        // Title changes have no notification of their own; this asks tmux to
        // send one. Nor does a theme change.
        commands.push(tmux_formats::subscribe_pane_titles_command().to_string());
        commands.push(tmux_formats::subscribe_theme_command().to_string());
        commands
    }
}
