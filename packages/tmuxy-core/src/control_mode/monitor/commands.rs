use super::*;

impl<C: ControlLink> TmuxMonitor<C> {
    /// Send a command a client asked for, with or without wanting its output.
    ///
    /// One path for both, so the things that have to happen around a user
    /// command — the `\;` unescape, settling for the multi-step group
    /// scripts, and the re-lists after option writes, reorders and pane
    /// marks (tmux announces none of those) — cannot drift between the
    /// fire-and-forget and the reply-carrying variant.
    pub(super) async fn send_user_command<E: StateEmitter>(
        &mut self,
        emitter: &E,
        command: &str,
        reply: Option<oneshot::Sender<CommandReply>>,
    ) {
        debug!(
            command = %crate::trace::redact_command(command),
            wants_reply = reply.is_some(),
            "processing user command"
        );
        let unescaped = command.replace(" \\; ", " ; ");
        let is_compound = is_multi_step_run_shell(&unescaped);
        if is_compound {
            self.aggregator.arm_settling(Instant::now());
            debug!("settling armed for multi-step run-shell");
        }

        // A fire-and-forget command is still marker-wrapped when it is not a
        // keystroke, so tmux's `%error` can be attributed to it and shown to
        // the user (a split that failed for "pane too small" would otherwise
        // do nothing, silently). Keystrokes are the hot path — one command
        // per key — and the only way they fail is a vanished pane, which the
        // layout already shows; they go out bare.
        //
        // A `run-shell` nobody waits on is relayed (`run_shell`): its output
        // comes back inside the reply instead of in a tmux 3.4 view-mode the
        // UI does not draw. A caller that asked for the output gets it as
        // tmux sends it.
        let relay_key = run_shell::relay_key(self.next_reply_id + 1);
        let relayed = match reply {
            Some(_) => None,
            None => run_shell::relay_run_shell(
                &unescaped,
                &relay_key,
                &crate::session_snapshot::tmux_shell_command(),
            ),
        };
        let (outgoing, waiter) = match (reply, relayed) {
            (Some(reply), _) => (unescaped.clone(), Some(ReplyWaiter::Caller(reply))),
            (None, Some(relayed)) => (relayed, Some(ReplyWaiter::RunShell(relay_key))),
            (None, None) if reports_failure(&unescaped) => {
                (unescaped.clone(), Some(ReplyWaiter::ReportFailure))
            }
            (None, None) => (unescaped.clone(), None),
        };
        let sent = match waiter {
            None => self.connection.send_command(&outgoing).await,
            Some(waiter) => {
                // The id `relay_key` was named after.
                self.next_reply_id += 1;
                let id = self.next_reply_id;
                let lines = super::state::reply_wrapped_lines(id, &outgoing);
                let sent = self.connection.send_commands_batch(&lines).await;
                match (&sent, waiter) {
                    (Ok(()), waiter) => {
                        self.pending_replies
                            .insert(id, (waiter, tokio::time::Instant::now()));
                    }
                    // The command never went out: tell the caller now rather
                    // than at the timeout.
                    (Err(e), ReplyWaiter::Caller(reply)) => {
                        let _ = reply.send(CommandReply {
                            output: String::new(),
                            error: Some(e.to_string()),
                        });
                    }
                    (Err(_), ReplyWaiter::ReportFailure | ReplyWaiter::RunShell(_)) => {}
                }
                sent
            }
        };

        if let Err(e) = sent {
            emitter.emit_error(format!("Failed to run command: {}", e));
            if is_compound {
                self.aggregator.clear_settling();
            }
            return;
        }
        trace!(cmd = %unescaped, "sent command via control mode");

        // What tmux leaves unannounced (`tmux_compat::SILENT_COMMANDS`) would
        // otherwise reach the clients on the next event or the idle heartbeat
        // — seconds later. Re-list it right behind the command.
        let relists = crate::tmux_compat::relists_after(&unescaped);
        if relists.windows {
            if let Err(e) = self
                .connection
                .send_command(tmux_formats::LIST_WINDOWS_CMD)
                .await
            {
                emitter.emit_error(format!("Failed to refresh windows: {}", e));
            }
        }
        if relists.panes {
            if let Err(e) = self
                .connection
                .send_command(tmux_formats::LIST_PANES_CMD)
                .await
            {
                emitter.emit_error(format!("Failed to refresh panes: {}", e));
            }
        }
    }

    /// Hand every waiting `GetState` the aggregator's state, once it describes
    /// the session in full (`StateAggregator::initial_state_ready`).
    pub(super) fn answer_state_requests(&mut self) {
        if self.pending_state_requests.is_empty() || !self.aggregator.initial_state_ready() {
            return;
        }
        let state = self.aggregator.to_tmux_state();
        for reply in self.pending_state_requests.drain(..) {
            let _ = reply.send(state.clone());
        }
    }

    /// Fail every pending reply that has outlived REPLY_TIMEOUT.
    pub(super) fn expire_replies(&mut self) {
        let now = tokio::time::Instant::now();
        let expired: Vec<u64> = self
            .pending_replies
            .iter()
            .filter(|(_, (_, sent_at))| now.duration_since(*sent_at) >= REPLY_TIMEOUT)
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            match self.pending_replies.remove(&id) {
                Some((ReplyWaiter::Caller(reply), _)) => {
                    warn!(id, "command reply timed out");
                    let _ = reply.send(CommandReply {
                        output: String::new(),
                        error: Some("tmux did not answer in time".to_string()),
                    });
                }
                // A long `run-shell` is a legitimate reason for a late END
                // marker; with nobody waiting there is nothing to report.
                Some((ReplyWaiter::ReportFailure | ReplyWaiter::RunShell(_), _)) | None => {}
            }
        }
    }

    /// Handle a `MonitorCommand` from external code. Returns false to stop the loop.
    pub(super) async fn on_command<E: StateEmitter>(
        &mut self,
        emitter: &E,
        cmd: Option<MonitorCommand>,
    ) -> bool {
        trace!(?cmd, "received monitor command");
        match cmd {
            Some(MonitorCommand::ResizeWindow { cols, rows }) => {
                debug!(cols, rows, "processing ResizeWindow");
                // Remember it first: if the window list has not arrived yet this
                // is the only record of what the client asked for, and
                // `apply_client_size` replays it once the windows are known.
                self.client_size = Some((cols, rows));
                let window_ids = self.aggregator.window_ids();
                if window_ids.is_empty() {
                    // Nothing to target yet — size the current window so the
                    // visible pane is right immediately; the rest follow when
                    // the window list lands.
                    let resize_cmd = format!("resizew -x {} -y {}", cols, rows);
                    if let Err(e) = self.connection.send_command(&resize_cmd).await {
                        emitter.emit_error(format!("Failed to resize window: {}", e));
                    } else {
                        trace!(cmd = %resize_cmd, "sent resize command");
                    }
                } else {
                    self.apply_client_size(emitter).await;
                }
                true
            }
            Some(MonitorCommand::RunCommand { command }) => {
                self.send_user_command(emitter, &command, None).await;
                true
            }
            Some(MonitorCommand::RunCommandWithReply { command, reply }) => {
                self.send_user_command(emitter, &command, Some(reply)).await;
                true
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

/// Whether a fire-and-forget command is marker-wrapped so its `%error`
/// reaches the user. Everything but keystrokes (`send-keys`, also pinned).
/// The list separator may still be the client's `\;` or already unescaped.
pub(super) fn reports_failure(command: &str) -> bool {
    !crate::executor::split_compound(command)
        .iter()
        .flat_map(|part| part.split(" ; "))
        .any(|part| matches!(crate::executor::command_verb(part), "send-keys" | "send"))
}

/// True when a control-mode command will run a tmuxy bash script that mutates
/// tmux state across multiple separate tmux calls (split → break → set-option
/// → swap → resize, etc.). Each step fires its own %layout-change / %window-add
/// event; without settling, the frontend renders the intermediate split before
/// the script lands on the final group layout. Matching by script name (not by
/// "run-shell" alone) avoids false positives on harmless one-shot scripts like
/// reap-orphan-shells or list-* helpers.
pub(super) fn is_multi_step_run_shell(command: &str) -> bool {
    if !command.contains("run-shell") {
        return false;
    }
    const MULTI_STEP_SCRIPTS: &[&str] = &[
        "pane-group add",
        "pane-group close",
        "pane-group switch",
        "pane-group next",
        "pane-group prev",
        "float-create",
    ];
    // The CLI quotes the script's path (`'…/pane-group' add`); the UI does not.
    let unquoted = command.replace('\'', "");
    MULTI_STEP_SCRIPTS.iter().any(|s| unquoted.contains(s))
}
