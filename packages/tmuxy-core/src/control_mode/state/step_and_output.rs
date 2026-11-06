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
    /// `step` at an explicit `now`, the clock settling is measured on.
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

        // Window setup first, so emissions carry the tagged state. A step that
        // tags a window but asked for no emission (a WindowAdd defers its
        // own) becomes a window change: otherwise the frontend showed an
        // untagged window until the next change, 15s+ in CI under tmux 3.4
        // while the stream was busy with `sync_initial_state`.
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

        // Driven by `change_type`, so a step whose emission settling held
        // back still keeps settling alive.
        self.maybe_extend_settling(result.change_type, now);

        StepResult {
            effects,
            change_type: result.change_type,
        }
    }

    /// Ends settling once `now` passes its deadline, returning the change the
    /// consolidated emission is due for; `None` when no event arrived while
    /// it was armed.
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
        // Output for a pane no list-panes or layout has placed is another
        // session's, or a split's that came early.
        if let Some(pane) = self.panes.get_mut(pane_id) {
            if self.panes_moved_window.contains(pane_id) {
                return (false, Vec::new(), None);
            }
            if pane.window_id.is_some() {
                let store_before: HashSet<u32> = pane.image_store.keys().copied().collect();
                if pane.output_bytes == 0 {
                    debug!(pane = %pane_id, bytes = content.len(), "pane first output");
                }
                pane.output_bytes += content.len() as u64;
                pane.process_output(content);
                let new_imgs: Vec<(u32, super::images::StoredImage)> = pane
                    .image_store
                    .iter()
                    .filter(|(id, _)| !store_before.contains(id))
                    .map(|(id, img)| (*id, img.clone()))
                    .collect();
                let clipboard = pane.take_clipboard();
                return (true, new_imgs, clipboard);
            }
        }
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

    pub(super) fn handle_layout_change(
        &mut self,
        window_id: &WindowId,
        layout: &str,
    ) -> Vec<PaneId> {
        if let Some(window) = self.windows.get_mut(window_id) {
            window.layout = layout.to_string();
            window.pane_tree = crate::layout::parse(layout).map(|root| root.pane_tree());
        }

        self.parse_layout(window_id, layout)
    }

    /// Geometry only, from a zoomed window's visible layout: no pane is
    /// created or removed.
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

    /// The authoritative pane geometry: a pane the layout names is created
    /// if new, one of this window's it leaves out is removed. Returns the
    /// panes that need a capture.
    ///
    /// tmux's layout format: `checksum,WxH,x,y,pane-id` (leaf),
    /// `checksum,WxH,x,y[children]` (vertical split) or
    /// `checksum,WxH,x,y{children}` (horizontal split).
    fn parse_layout(&mut self, window_id: &WindowId, layout: &str) -> Vec<PaneId> {
        // The checksum prefix.
        let layout = match layout.find(',') {
            Some(idx) => &layout[idx + 1..],
            None => return Vec::new(),
        };

        let parsed_panes = parse_layout_panes(layout);
        if parsed_panes.is_empty() {
            return Vec::new();
        }

        let active_pane_id = self
            .windows
            .get(window_id)
            .and_then(|w| w.active_pane_id.clone());

        let mut resized_panes = Vec::new();
        let mut seen_panes: HashSet<PaneId> = HashSet::new();

        for lp in &parsed_panes {
            seen_panes.insert(lp.id.clone());

            if let Some(pane) = self.panes.get_mut(&lp.id) {
                pane.x = lp.x;
                pane.y = lp.y;
                pane.index = lp.index;
                let moved_window = !pane.in_window(window_id);
                let was_resized = pane.resize(lp.width, lp.height);
                if moved_window {
                    // break-pane, swap-pane: see `panes_moved_window`.
                    pane.move_to_window(window_id.clone());
                    self.panes_moved_window.insert(lp.id.clone());
                }
                if was_resized || moved_window {
                    resized_panes.push(lp.id.clone());
                }
            } else {
                let mut pane = PaneState::new(lp.id.clone(), lp.width, lp.height);
                pane.window_id = Some(window_id.clone());
                pane.index = lp.index;
                pane.x = lp.x;
                pane.y = lp.y;
                pane.active = active_pane_id.as_ref() == Some(&lp.id);
                pane.replay_early_output(&mut self.early_output);
                self.panes.insert(lp.id.clone(), pane);
                // Captured: output it printed before it existed may have been
                // dropped (`MAX_EARLY_OUTPUT_BYTES`, `MAX_EARLY_OUTPUT_PANES`).
                resized_panes.push(lp.id.clone());
            }
        }

        self.panes.retain(|pane_id, pane| {
            if pane.in_window(window_id) {
                seen_panes.contains(pane_id)
            } else {
                true
            }
        });

        // A dead pane's entry would hold `initial_state_ready` back forever.
        self.prune_capture_bookkeeping();

        resized_panes
    }
}
