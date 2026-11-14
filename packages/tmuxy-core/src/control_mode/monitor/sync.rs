use super::*;

impl<C: ControlLink> TmuxMonitor<C> {
    /// Attach: the core's list of what a fresh client sends
    /// (`MonitorCore::attach_commands`), with what only this host can read —
    /// the config chain, the remembered UI choices, the server binary the
    /// scripts run and this machine's plugins.
    #[instrument(skip(self), fields(session = %self.config.session))]
    pub async fn sync_initial_state(&mut self) -> Result<(), TmuxError> {
        let commands = self.core.attach_commands(
            (INITIAL_PTY_COLS, INITIAL_PTY_ROWS),
            super::super::monitor_core::AttachConfig {
                config: attach_config(&self.config.session),
                host: attach_host(),
            },
        );
        self.connection.send_commands(&commands).await
    }

    /// Apply the throttle / debounce / immediate-emit policy for a state change.
    pub(super) fn handle_state_change<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
        change: ChangeType,
    ) {
        let now = Instant::now();
        match change {
            ChangeType::Output => {
                rs.update_rate(now);
                rs.pending_output_emit = true;
                if rs.in_throttle_mode {
                    if now.saturating_duration_since(rs.last_output_emit)
                        >= self.config.throttle_interval
                    {
                        self.emit(emitter, rs, now);
                    }
                } else {
                    rs.pending_output_first_at.get_or_insert(now);
                    rs.last_output_event_at = Some(now);
                }
            }
            ChangeType::Layout => rs.schedule_layout_emit(tokio::time::Instant::now()),
            _ => {
                self.emit(emitter, rs, now);
                rs.layout_emit_at = None;
            }
        }
    }

    /// A throttle or layout-debounce window expired: flush what is pending.
    /// The delta carries whatever output and layout were waiting alike.
    pub(super) fn flush<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState) {
        self.emit(emitter, rs, Instant::now());
        rs.layout_emit_at = None;
    }

    fn emit<E: StateEmitter>(&mut self, emitter: &E, rs: &mut RunState, now: Instant) {
        if let Some(update) = self.core.aggregator_mut().to_state_update() {
            emitter.emit_state(update);
        }
        rs.mark_emitted(now);
    }
}

/// The config chain (defaults, the user's tmuxy.conf, the essentials), then
/// the choices made through the UI (theme, mode, cursor blink): tmux forgets
/// them when its server exits, tmuxy.state.json does not. After the config,
/// and only for what the user's tmuxy.conf leaves unset — an option it sets
/// is pinned, and config beats menu state. Then the session's own profile,
/// if it has one other than the default (`crate::profiles`).
fn attach_config(session: &str) -> Vec<String> {
    let mut commands: Vec<String> = crate::session::get_config_path()
        .map(|path| format!("source-file {}", crate::tmux_quote(&path.to_string_lossy())))
        .into_iter()
        .collect();
    commands.extend(crate::session::current_managed_state_commands());
    commands.extend(crate::session::current_profile_commands(session));
    commands
}

/// Which binary runs this build's server verbs (`session::SERVER_BIN_ENV`),
/// and the plugins this machine has, for the client's menus (a fresh tmux
/// server has none until something writes them). A server over SSH is
/// another machine's, whose own tmuxy publishes its plugins. The plugin keys
/// need the tables read back, which only the running loop answers: the host
/// binds them once this sync is done (`host`'s `apply_plugin_keys`).
fn attach_host() -> Vec<String> {
    let mut commands = crate::session::server_command_env();
    if crate::session::ssh_target().is_none() {
        match crate::plugins::inventory::commands(&crate::paths::Layout::current()) {
            Ok(plugins) => commands.extend(plugins),
            Err(e) => warn!(error = %e, "the plugin inventory is not published"),
        }
    }
    commands
}
