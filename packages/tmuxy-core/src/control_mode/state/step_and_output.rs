use super::*;
use crate::{PaneId, WindowId};

/// How many panes not yet in the state may have their `%output` kept for
/// them (a split's output lands before the layout that creates the pane):
/// a burst of splits is a handful, anything past this is not a split.
const MAX_EARLY_OUTPUT_PANES: usize = 32;

/// How much of such a pane's output is kept, newest last: a shell's first
/// prompt and then some. The capture the new pane gets refills its screen
/// anyway; this only spares it a blank first frame.
const MAX_EARLY_OUTPUT_BYTES: usize = 8192;

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
        let send = |batch, commands: Vec<String>| SideEffect::Send { batch, commands };

        // Window setup before anything else so emissions reflect tagged state.
        // When we tag windows on a step where process_event reported
        // state_changed=false (e.g. WindowAdd, which intentionally defers its
        // own emit), promote the step to a window-typed state change. Without
        // this, the frontend sees an untagged window until the next
        // state-changing event arrives — which can be 15s+ in CI under tmux
        // 3.4 when the CC stream is busy with sync_initial_state.
        let setup = self.window_setup_commands();
        if !setup.is_empty() {
            effects.push(send(Batch::WindowSetup, setup));
            if !result.state_changed {
                result.state_changed = true;
                result.change_type = ChangeType::Window;
            }
        }

        // Images, clipboard writes and notices before the refreshes, so a
        // consumer has the images and the clipboard by the time the
        // refreshed panes arrive.
        for (pane_id, images) in std::mem::take(&mut result.new_images) {
            if !images.is_empty() {
                effects.push(SideEffect::Notify(Notice::Images { pane_id, images }));
            }
        }
        for (pane_id, text) in std::mem::take(&mut result.clipboard_writes) {
            effects.push(SideEffect::Notify(Notice::Clipboard { pane_id, text }));
        }
        for text in std::mem::take(&mut result.messages) {
            effects.push(SideEffect::Notify(Notice::Message(text)));
        }
        if !result.commands.is_empty() {
            effects.push(send(Batch::Own, std::mem::take(&mut result.commands)));
        }
        for (id, output, error) in std::mem::take(&mut result.command_replies) {
            effects.push(SideEffect::Reply { id, output, error });
        }

        if is_window_add {
            effects.push(send(
                Batch::WindowRelist,
                self.markers.window_relist_commands().to_vec(),
            ));
        }
        if !result.panes_needing_refresh.is_empty() {
            let refresh = self.pane_refresh_commands(&result.panes_needing_refresh);
            effects.push(send(Batch::PaneRefresh, refresh));
        }
        if let Some(pane_id) = result.resume.take() {
            effects.push(send(
                Batch::Resume,
                vec![format!("refresh-client -A '{pane_id}:continue'")],
            ));
        }
        if result.state_changed {
            effects.push(SideEffect::Emit(result.change_type));
        }

        // Extend settling AFTER computing effects — extension is driven by the
        // computed `change_type`, including the suppressed `state_changed=false`
        // case where settling still needs to be kept alive.
        self.maybe_extend_settling(result.change_type, now);

        StepResult {
            effects,
            change_type: result.change_type,
        }
    }

    /// Time-driven transitions. Today this drains the settling deadline: when
    /// `now` is past `settling_until`, the aggregator clears its settling
    /// state, unsuppresses window emissions, and (if any events actually
    /// arrived during the window) returns the change a consolidated state
    /// emission is due for. If the safety ceiling fires with no events ever
    /// observed, the suppression flag is cleared silently — no emit, no
    /// foot-gun for the runtime.
    pub fn tick(&mut self, now: Instant) -> Option<ChangeType> {
        let deadline = self.settling_until?;
        if now < deadline {
            return None;
        }
        let was_awaiting = self.settling_awaiting_first_event;
        self.settling_until = None;
        self.settling_started = None;
        self.settling_awaiting_first_event = false;
        self.suppress_window_emissions = false;
        if was_awaiting {
            // Safety timeout — no events arrived after the compound command.
            // Nothing to emit; just leave the aggregator unsuppressed.
            return None;
        }
        Some(ChangeType::Other)
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
                ChangeType::Output
            } else {
                ChangeType::None
            },
            new_images,
            clipboard_writes,
            ..Default::default()
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
                let clipboard = pane.take_clipboard();
                return (true, new_imgs, clipboard);
            }
        }
        // Buffer output for panes not yet created in state.
        // During split, %output can arrive before %layout-change creates the pane.
        // Cap per-pane buffer and total entry count to prevent unbounded growth.
        if self.early_output.len() < MAX_EARLY_OUTPUT_PANES
            || self.early_output.contains_key(pane_id)
        {
            let buf = self.early_output.entry(pane_id.clone()).or_default();
            buf.extend(content);
            if buf.len() > MAX_EARLY_OUTPUT_BYTES {
                let start = buf.len() - MAX_EARLY_OUTPUT_BYTES;
                debug!(pane = %pane_id, dropped = start, "early output over its cap: oldest bytes dropped");
                *buf = buf[start..].to_vec();
            }
        } else {
            debug!(pane = %pane_id, bytes = content.len(), "early output for one pane too many: dropped");
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
                pane.index = lp.index;
                let moved_window = !pane.in_window(window_id);
                let was_resized = pane.resize(lp.width, lp.height);
                if moved_window {
                    // A pane moving between windows (break-pane, swap-pane):
                    // its grid is reset so %output that arrives before the
                    // capture does not build on the old window's content, and
                    // handle_output() holds that output until the capture.
                    pane.move_to_window(window_id.clone());
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
        // would hold back `initial_state_ready` forever.
        self.prune_capture_bookkeeping();

        resized_panes
    }
}
