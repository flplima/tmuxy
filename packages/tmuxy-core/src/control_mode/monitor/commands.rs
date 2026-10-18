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
        debug!(%command, wants_reply = reply.is_some(), "processing user command");
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
        let waiter = match reply {
            Some(reply) => Some(ReplyWaiter::Caller(reply)),
            None if reports_failure(&unescaped) => Some(ReplyWaiter::ReportFailure),
            None => None,
        };
        let sent = match waiter {
            None => self.connection.send_command(&unescaped).await,
            Some(waiter) => {
                self.next_reply_id += 1;
                let id = self.next_reply_id;
                let lines = super::state::reply_wrapped_lines(id, &unescaped);
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
                    (Err(_), ReplyWaiter::ReportFailure) => {}
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

        // tmux emits no control-mode notification when a user option
        // changes, so a `@tmuxy-*` write (a dragged sidebar width, a
        // hidden column, a focus request) would otherwise only reach
        // the clients on the next window event or the idle heartbeat
        // — seconds later. Re-list the windows right behind it.
        // The same goes for a reorder: `move-window` / `swap-window`
        // renumber every window past the moved one, and tmux tells
        // us about none of them — the tab strip would show two
        // tabs at one index until the heartbeat.
        if writes_tmuxy_option(&unescaped) || reorders_windows(&unescaped) {
            if let Err(e) = self
                .connection
                .send_command(tmux_formats::LIST_WINDOWS_CMD)
                .await
            {
                emitter.emit_error(format!("Failed to refresh windows: {}", e));
            }
        }
        // Likewise the marked pane: `select-pane -m/-M` changes
        // `#{pane_marked}` without any notification, so re-list the
        // panes right behind it or the flag waits for the heartbeat.
        // A PANE-scoped `@tmuxy-*` write needs the same treatment for
        // the same reason: answering a `tmuxy pane send -t` clears `@tmuxy-ask`,
        // and without this the question would stay on screen until the
        // next event moved it. And a pane swap, which tmux 3.2 does not
        // announce at all.
        if toggles_pane_mark(&unescaped)
            || writes_pane_scoped_tmuxy_option(&unescaped)
            || swaps_panes(&unescaped)
        {
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
                Some((ReplyWaiter::ReportFailure, _)) | None => {}
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
            Some(MonitorCommand::GetScrollback {
                pane_id,
                start,
                end,
                reply,
            }) => {
                let chunk = self.aggregator.pane_scrollback(&pane_id, start, end).map(
                    |(cells, history_size, width)| ScrollbackChunk {
                        cells,
                        history_size,
                        width,
                    },
                );
                let _ = reply.send(chunk);
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

/// Whether a client command writes a `@tmuxy-*` user option. Those carry
/// sidebar/focus state the clients read off `list-windows`, and tmux sends no
/// notification for them — the caller re-lists windows right after.
/// Whether a client command marks or unmarks a pane (`select-pane -m` / `-M`,
/// also `selectp`). tmux emits no notification for the mark, so the caller
/// re-lists panes right after.
pub(super) fn toggles_pane_mark(command: &str) -> bool {
    (command.contains("select-pane") || command.contains("selectp"))
        && command.split_whitespace().any(|w| w == "-m" || w == "-M")
}

/// Whether a client command changes window indices (`move-window`,
/// `swap-window`, `renumber-windows`, and their short forms). tmux emits no
/// notification for an index change, so the caller re-lists windows right after.
pub(super) fn reorders_windows(command: &str) -> bool {
    runs_any(
        command,
        &[
            "move-window",
            "movew",
            "swap-window",
            "swapw",
            "renumber-windows",
        ],
    )
}

/// Whether a client command swaps panes (`swap-pane` / `swapp`). tmux 3.2
/// emits no `%layout-change` for a swap, so the caller re-lists panes right
/// after; on later versions the re-list only repeats what the notification
/// already brought.
pub(super) fn swaps_panes(command: &str) -> bool {
    runs_any(command, &["swap-pane", "swapp"])
}

/// Whether any command of a client's command list is one of `verbs`. Only the
/// verb heading a command counts; anywhere else it is an argument (a key sent
/// to a shell, say). The list separator may still be the client's `\;` or
/// already unescaped.
pub(super) fn runs_any(command: &str, verbs: &[&str]) -> bool {
    crate::executor::split_compound(command)
        .iter()
        .flat_map(|part| part.split(" ; "))
        .any(|part| verbs.contains(&crate::executor::command_verb(part)))
}

pub(super) fn writes_tmuxy_option(command: &str) -> bool {
    ((command.contains("set-option") || command.contains("set -")) && command.contains("@tmuxy-"))
        // The stack script sets / unsets `@tmuxy-collapsible` itself, where
        // the write is invisible here; the re-list is what turns the flag into
        // a relayout (`collapsible_layout_commands`). Bindings arrive with the
        // alias already expanded to its `run-shell "bash …/tmuxy/stack …"`.
        || command.contains("tmuxy-stack")
        || command.contains("tmuxy/stack")
}

/// Whether a client command writes a PANE-scoped `@tmuxy-*` option
/// (`set-option -p` / `setp`, set or unset). Those change `list-panes` output
/// and nothing else, so the panes — not the windows — are what has to be
/// re-listed behind them.
pub(super) fn writes_pane_scoped_tmuxy_option(command: &str) -> bool {
    crate::executor::split_compound(command)
        .iter()
        .flat_map(|part| part.split(" ; "))
        .any(|part| {
            matches!(
                crate::executor::command_verb(part),
                "set-option" | "set" | "setp"
            ) && part.contains("@tmuxy-")
                && part
                    .split_whitespace()
                    .any(|tok| tok.starts_with('-') && !tok.starts_with("--") && tok.contains('p'))
        })
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
        "pane-group-add",
        "pane-group-close",
        "pane-group-switch",
        "pane-group-next",
        "pane-group-prev",
        "float-create",
    ];
    MULTI_STEP_SCRIPTS.iter().any(|s| command.contains(s))
}
