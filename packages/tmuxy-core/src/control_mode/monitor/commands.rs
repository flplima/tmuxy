use super::*;

impl<C: ControlLink> TmuxMonitor<C> {
    /// Send a command a client asked for, with or without wanting its output
    /// (`MonitorCore::command` decides everything around it).
    async fn send_user_command<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
        command: &str,
        reply: Option<Caller>,
    ) -> bool {
        debug!(
            command = %crate::trace::redact_command(command),
            wants_reply = reply.is_some(),
            "processing user command"
        );
        let outgoing = self.core.command(command, reply, Instant::now());
        if let Err(e) = self.connection.send_commands(&outgoing.lines).await {
            let actions = self.core.not_sent(&outgoing, &e.to_string());
            return self.dispatch(emitter, rs, actions).await;
        }
        trace!(cmd = %command, "sent command via control mode");
        // What tmux leaves unannounced (`tmux_compat::SILENT_COMMANDS`) would
        // otherwise reach the clients on the next event or the idle heartbeat
        // — seconds later. Re-listed right behind the command.
        if !outgoing.relists.is_empty() {
            let relists = Action::Send(outgoing.relists);
            return self.dispatch(emitter, rs, vec![relists]).await;
        }
        true
    }

    /// Hand every waiting `GetState` the aggregator's state, once it describes
    /// the session in full (`StateAggregator::initial_state_ready`).
    pub(super) fn answer_state_requests(&mut self) {
        if self.pending_state_requests.is_empty() || !self.core.aggregator().initial_state_ready() {
            return;
        }
        let state = self.core.aggregator_mut().to_tmux_state();
        for reply in self.pending_state_requests.drain(..) {
            let _ = reply.send(state.clone());
        }
    }

    /// Handle a `MonitorCommand` from external code. Returns false to stop the loop.
    pub(super) async fn on_command<E: StateEmitter>(
        &mut self,
        emitter: &E,
        rs: &mut RunState,
        cmd: Option<MonitorCommand>,
    ) -> bool {
        trace!(?cmd, "received monitor command");
        match cmd {
            Some(MonitorCommand::ResizeWindow { cols, rows }) => {
                debug!(cols, rows, "processing ResizeWindow");
                let actions = self.core.set_client_size(cols, rows);
                self.dispatch(emitter, rs, actions).await
            }
            Some(MonitorCommand::RunCommand { command }) => {
                self.send_user_command(emitter, rs, &command, None).await
            }
            Some(MonitorCommand::RunCommandWithReply { command, reply }) => {
                self.send_user_command(emitter, rs, &command, Some(reply))
                    .await
            }
            Some(MonitorCommand::GetState { reply }) => {
                self.pending_state_requests.push(reply);
                self.answer_state_requests();
                true
            }
            Some(MonitorCommand::Shutdown) => {
                info!("received shutdown command, gracefully closing");
                self.connection.graceful_close().await;
                false
            }
            None => {
                warn!("command channel closed, stopping");
                false
            }
        }
    }
}
