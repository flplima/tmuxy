use super::*;
use crate::{PaneId, WindowId};

impl StateAggregator {
    /// Like `step`, but accepts an explicit `now` so tests can drive the
    /// settling extension deterministically.
    pub fn step_at(&mut self, event: ControlModeEvent, now: Instant) -> StepResult {
        // A window closing needs the same re-list as one appearing: with
        // renumber-windows on, tmux shifts every later window's index and
        // announces none of them, and the tab strip is ordered by index.
        let is_window_add = matches!(
            &event,
            ControlModeEvent::WindowAdd { .. }
                | ControlModeEvent::UnlinkedWindowAdd { .. }
                | ControlModeEvent::WindowClose { .. }
                | ControlModeEvent::UnlinkedWindowClose { .. }
        );
        let mut result = self.process_event(event);
        let mut effects = Vec::new();

        // Auto-adopt before anything else so emissions reflect tagged state.
        // When we tag windows on a step where process_event reported
        // state_changed=false (e.g. WindowAdd, which intentionally defers its
        // own emit), promote the step to a window-typed state change. Without
        // this, the frontend sees an untagged window until the next
        // state-changing event arrives — which can be 15s+ in CI under tmux
        // 3.4 when the CC stream is busy with sync_initial_state.
        let tag_cmds = self.collect_window_tag_commands();
        let tagged_any = !tag_cmds.is_empty();
        if tagged_any {
            effects.push(SideEffect::AdoptUntaggedWindows(tag_cmds));
            if !result.state_changed {
                result.state_changed = true;
                result.change_type = ChangeType::Window;
            }
        }

        // Image / clipboard side effects fire before list-pane refreshes, so a
        // consumer has the images and the clipboard by the time the refreshed
        // panes arrive.
        for (pane_id, images) in result.new_images.iter() {
            if !images.is_empty() {
                effects.push(SideEffect::StoreImages {
                    pane_id: pane_id.clone(),
                    images: images.clone(),
                });
            }
        }
        for (pane_id, text) in result.clipboard_writes.iter() {
            effects.push(SideEffect::WriteClipboard {
                pane_id: pane_id.clone(),
                text: text.clone(),
            });
        }
        for cmd in result.commands.iter() {
            effects.push(SideEffect::SendTmuxCommand(cmd.clone()));
        }
        for (id, output, error) in result.command_replies.iter() {
            effects.push(SideEffect::CommandReply {
                id: *id,
                output: output.clone(),
                error: error.clone(),
            });
        }

        if is_window_add {
            effects.push(SideEffect::RefreshAfterWindowAdd);
        }

        if !result.panes_needing_refresh.is_empty() {
            effects.push(SideEffect::RefreshPanes {
                pane_ids: result.panes_needing_refresh.clone(),
            });
        }

        if let ChangeType::FlowPause { ref pane_id } = result.change_type {
            effects.push(SideEffect::ResumePane(pane_id.clone()));
        }

        if result.state_changed {
            effects.push(SideEffect::EmitState {
                change: result.change_type.clone(),
            });
        }

        // Extend settling AFTER computing effects — extension is driven by the
        // computed `change_type`, including the suppressed `state_changed=false`
        // case where settling still needs to be kept alive.
        self.maybe_extend_settling(&result.change_type, now);

        StepResult {
            effects,
            change_type: result.change_type,
        }
    }

    /// Time-driven transitions. Today this drains the settling deadline: when
    /// `now` is past `settling_until`, the aggregator clears its settling
    /// state, unsuppresses window emissions, and (if any events actually
    /// arrived during the window) yields a consolidated `EmitState`. If the
    /// safety ceiling fires with no events ever observed, the suppression
    /// flag is cleared silently — no emit, no foot-gun for the runtime.
    pub fn tick(&mut self, now: Instant) -> Vec<SideEffect> {
        let Some(deadline) = self.settling_until else {
            return Vec::new();
        };
        if now < deadline {
            return Vec::new();
        }
        let was_awaiting = self.settling_awaiting_first_event;
        self.settling_until = None;
        self.settling_started = None;
        self.settling_awaiting_first_event = false;
        self.suppress_window_emissions = false;
        if was_awaiting {
            // Safety timeout — no events arrived after the compound command.
            // Nothing to emit; just leave the aggregator unsuppressed.
            return Vec::new();
        }
        vec![SideEffect::EmitState {
            change: ChangeType::Full,
        }]
    }

    /// The pane a keystroke would reach: the active pane of the active window.
    fn active_pane_id(&self) -> Option<PaneId> {
        self.active_window_id
            .as_ref()
            .and_then(|id| self.windows.get(id))
            .and_then(|w| w.active_pane_id.clone())
    }

    /// Whether `pane_id` may have a clipboard write honoured at `now` — the
    /// rate limit of `MIN_CLIPBOARD_INTERVAL` — recording `now` when it may.
    fn clipboard_write_due(&mut self, pane_id: &PaneId, now: Instant) -> bool {
        let Some(pane) = self.panes.get_mut(pane_id) else {
            return false;
        };
        let due = pane
            .last_clipboard_write
            .is_none_or(|last| now.duration_since(last) >= MIN_CLIPBOARD_INTERVAL);
        if due {
            pane.last_clipboard_write = Some(now);
        }
        due
    }

    /// Shared body of the `%output` / `%extended-output` arms.
    pub(super) fn output_result(&mut self, pane_id: PaneId, content: &[u8]) -> ProcessEventResult {
        let (changed, new_imgs, clipboard) = self.handle_output(&pane_id, content);
        let new_images = if new_imgs.is_empty() {
            Vec::new()
        } else {
            vec![(pane_id.clone(), new_imgs)]
        };
        let active = self.active_pane_id();
        let clipboard_writes = clipboard
            .and_then(|text| accepted_clipboard_write(&pane_id, active.as_ref(), text))
            .filter(|_| self.clipboard_write_due(&pane_id, Instant::now()))
            .map(|text| vec![(Some(pane_id.clone()), text)])
            .unwrap_or_default();
        ProcessEventResult {
            state_changed: changed,
            panes_needing_refresh: Vec::new(),
            change_type: if changed {
                ChangeType::PaneOutput { pane_id }
            } else {
                ChangeType::None
            },
            new_images,
            clipboard_writes,
            command_replies: Vec::new(),
            commands: Vec::new(),
        }
    }

    pub(super) fn handle_output(
        &mut self,
        pane_id: &PaneId,
        content: &[u8],
    ) -> (bool, Vec<(u32, super::images::StoredImage)>, Option<String>) {
        // Only process output for panes we know about from list-panes.
        // This prevents creating panes from other tmux sessions.
        // Panes are added via parse_list_panes_line() which sets window_id.
        if let Some(pane) = self.panes.get_mut(pane_id) {
            // Suppress output for panes that recently moved between windows
            // (e.g., break-pane). The VT100 was reset and a capture-pane is
            // pending — processing %output now would accumulate stale content
            // from the old window before the authoritative capture arrives.
            if self.panes_moved_window.contains(pane_id) {
                return (false, Vec::new(), None);
            }
            // Only process if pane has a valid window_id (was seen in list-panes)
            if pane.window_id.is_some() {
                // A set, not a Vec: `contains` on the Vec made every chunk of
                // output O(images²) in a pane that had accumulated them.
                let store_before: HashSet<u32> = pane.image_store.keys().copied().collect();
                if pane.output_bytes == 0 {
                    debug!(pane = %pane_id, bytes = content.len(), "pane first output");
                }
                pane.output_bytes += content.len() as u64;
                pane.process_output(content);
                // Collect newly added images
                let new_imgs: Vec<(u32, super::images::StoredImage)> = pane
                    .image_store
                    .iter()
                    .filter(|(id, _)| !store_before.contains(id))
                    .map(|(id, img)| (*id, img.clone()))
                    .collect();
                // Drain any OSC 52 clipboard request the app emitted in this chunk.
                let clipboard = pane.osc_parser.take_clipboard();
                // ...and any OSC 0/2 title, applied HERE rather than waiting for
                // tmux to report `pane_title` on the next list-panes. That only
                // happens on a metadata sync or the 15-second idle heartbeat, so
                // a program announcing a new title left the header showing the
                // old one for up to fifteen seconds. tmux sees the same escape
                // and agrees at the next poll; this only removes the lag.
                if let Some(title) = pane.osc_parser.take_title() {
                    // Same guard list-panes titles get: a Kitty graphics probe
                    // read as a title names the pane after a protocol.
                    pane.title = if is_graphics_payload(&title) {
                        String::new()
                    } else {
                        title
                    };
                }
                return (true, new_imgs, clipboard);
            }
        }
        // Buffer output for panes not yet created in state.
        // During split, %output can arrive before %layout-change creates the pane.
        // Cap per-pane buffer and total entry count to prevent unbounded growth.
        if self.early_output.len() < 32 || self.early_output.contains_key(pane_id) {
            let buf = self.early_output.entry(pane_id.clone()).or_default();
            buf.extend(content);
            if buf.len() > 8192 {
                let start = buf.len() - 8192;
                *buf = buf[start..].to_vec();
            }
        }
        (false, Vec::new(), None)
    }

    /// Handle layout change and return list of pane IDs that need content refresh.
    pub(super) fn handle_layout_change(
        &mut self,
        window_id: &WindowId,
        layout: &str,
    ) -> Vec<PaneId> {
        if let Some(window) = self.windows.get_mut(window_id) {
            window.layout = layout.to_string();
            window.pane_tree = crate::layout::parse(layout).map(|root| root.pane_tree());
        }

        // Parse layout to update pane positions and return panes that were resized
        self.parse_layout(window_id, layout)
    }

    /// Update only the geometry (x, y, width, height) of existing panes from a layout string.
    /// Does NOT create or remove panes. Used for visible_layout during zoom.
    pub(super) fn update_pane_geometry_from_layout(&mut self, window_id: &WindowId, layout: &str) {
        let layout = match layout.find(',') {
            Some(idx) => &layout[idx + 1..],
            None => return,
        };

        let parsed_panes = parse_layout_panes(layout);
        for lp in &parsed_panes {
            if let Some(pane) = self.panes.get_mut(&lp.id) {
                if pane.in_window(window_id) {
                    pane.x = lp.x;
                    pane.y = lp.y;
                    let _ = pane.resize(lp.width, lp.height);
                }
            }
        }
    }

    /// Parse tmux layout string to extract pane positions, creating panes as needed.
    /// Returns a list of pane IDs that were resized.
    ///
    /// Layout format: `checksum,WxH,x,y,pane-id` (leaf) or
    ///                `checksum,WxH,x,y[children]` (vertical split) or
    ///                `checksum,WxH,x,y{children}` (horizontal split)
    ///
    /// This is the authoritative source for pane geometry. Panes discovered in the
    /// layout that don't exist in `self.panes` are created with default metadata.
    /// Panes in this window that are NOT in the layout are removed (reconciliation).
    fn parse_layout(&mut self, window_id: &WindowId, layout: &str) -> Vec<PaneId> {
        // Skip the checksum prefix (e.g., "abc123,")
        let layout = match layout.find(',') {
            Some(idx) => &layout[idx + 1..],
            None => return Vec::new(),
        };

        // Parse all pane geometries from the layout string
        let parsed_panes = parse_layout_panes(layout);
        if parsed_panes.is_empty() {
            return Vec::new();
        }

        // Look up the window's active pane for setting initial active flag on new panes
        let active_pane_id = self
            .windows
            .get(window_id)
            .and_then(|w| w.active_pane_id.clone());

        let mut resized_panes = Vec::new();
        let mut seen_panes: HashSet<PaneId> = HashSet::new();

        for lp in &parsed_panes {
            seen_panes.insert(lp.id.clone());

            if let Some(pane) = self.panes.get_mut(&lp.id) {
                // Existing pane: update geometry and window assignment
                pane.x = lp.x;
                pane.y = lp.y;
                // Detect pane moving between windows (e.g., break-pane, swap-pane).
                // Reset the VT100 parser immediately to clear stale content from the
                // old window. Without this, %output events that arrive before the
                // capture-pane response would build on top of the stale buffer.
                let moved_window = !pane.in_window(window_id);
                pane.window_id = Some(window_id.clone());
                pane.index = lp.index;
                let was_resized = pane.resize(lp.width, lp.height);
                if moved_window && !was_resized {
                    // resize() already resets VT100 when dimensions change.
                    // When only the window changed (same dimensions), reset manually.
                    pane.terminal = pane.fresh_terminal();
                    pane.image_parser.reset();
                    pane.content_dirty = true;
                    pane.cached_content = None;
                }
                if moved_window {
                    // Track that this pane moved windows so handle_output()
                    // suppresses stale %output until capture-pane arrives.
                    self.panes_moved_window.insert(lp.id.clone());
                }
                if was_resized || moved_window {
                    resized_panes.push(lp.id.clone());
                }
            } else {
                // New pane discovered in layout: create with geometry
                let mut pane = PaneState::new(lp.id.clone(), lp.width, lp.height);
                pane.window_id = Some(window_id.clone());
                pane.index = lp.index;
                pane.x = lp.x;
                pane.y = lp.y;
                pane.active = active_pane_id.as_ref() == Some(&lp.id);
                pane.replay_early_output(&mut self.early_output);
                self.panes.insert(lp.id.clone(), pane);
                // Queue capture for new panes so their content is fetched
                // authoritatively. Layout dimensions may include the
                // pane-border-status row, causing a dimension mismatch with
                // list-panes that triggers a VT100 reset. The capture ensures
                // content is restored even if %output events are lost.
                resized_panes.push(lp.id.clone());
            }
        }

        // Reconcile: remove panes from this window that are no longer in the layout
        self.panes.retain(|pane_id, pane| {
            if pane.in_window(window_id) {
                seen_panes.contains(pane_id)
            } else {
                true // keep panes from other windows
            }
        });

        // Prune in-flight captures for panes that no longer exist — their
        // marker-routed responses are discarded on arrival, and a dead entry
        // would freeze content preservation in to_state_update.
        self.pending_captures
            .retain(|id| self.panes.contains_key(id));

        resized_panes
    }
}
