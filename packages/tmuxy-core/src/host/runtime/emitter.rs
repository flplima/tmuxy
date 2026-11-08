use std::sync::Arc;

use super::SessionRuntime;
use crate::control_mode::{LogKind, LogSink, StateEmitter, StoredImage, MAX_CLIPBOARD_BYTES};
use crate::host::HostEvent;
use crate::session_snapshot as snapshot;
use crate::{PaneId, StateUpdate};

impl LogSink for SessionRuntime {
    fn log(&self, kind: LogKind, message: String) {
        // Mirrored to the log so a bug report carries the reason a connection
        // died, which is otherwise only visible to the running UI. A command
        // or tmux's output is raw content: `trace`, below the action trace's
        // floor (docs/TRACING.md).
        match kind {
            LogKind::Error => tracing::warn!(target: "tmuxy_core::host", "{message}"),
            LogKind::Info => tracing::info!(target: "tmuxy_core::host", "{message}"),
            LogKind::Command | LogKind::Output => {
                tracing::trace!(target: "tmuxy_core::host", ?kind, "{message}")
            }
        }
        self.emit(HostEvent::Log { kind, message });
    }
}

impl StateEmitter for Arc<SessionRuntime> {
    /// A full state names every live pane, so it is when the pictures of
    /// dead ones are forgotten. The keeper follows a change of SHAPE (a
    /// split, a closed pane, a tag, a program starting; never bytes
    /// arriving), which is what a snapshot records. The emit is traced by the
    /// DELTA seq, so the return leg joins to the client's applied `seq`
    /// (docs/TRACING.md).
    fn emit_state(&self, update: StateUpdate) {
        self.preview.sync_update(&self.preview_scope, &update);
        match &update {
            StateUpdate::Full { state } => {
                self.images
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .retain_live_panes(state);
                if self.autosave {
                    self.keeper.note_change();
                }
                tracing::debug!(target: "tmuxy_core::emit", kind = "full", "emit state");
            }
            StateUpdate::Delta { delta } => {
                if self.autosave && snapshot::is_structural(delta) {
                    self.keeper.note_change();
                }
                tracing::debug!(target: "tmuxy_core::emit", seq = delta.seq, kind = "delta", "emit state");
            }
        }
        self.emit(HostEvent::StateUpdate(Box::new(update)));
    }

    fn emit_error(&self, error: String) {
        tracing::warn!(target: "tmuxy_core::host", session = %self.session(), "{error}");
        self.emit(HostEvent::Error { message: error });
    }

    fn emit_disconnected(&self, reason: Option<String>) {
        self.emit(HostEvent::Detached { reason });
    }

    fn store_images(&self, pane_id: &PaneId, images: Vec<(u32, StoredImage)>) {
        // The bytes arrive once, when they are decoded: a picture not stored
        // here is a placement the client can never fetch.
        self.images
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(pane_id, images);
    }

    fn write_clipboard(&self, pane_id: Option<&PaneId>, text: String) {
        // The aggregator caps both producers (OSC 52 and the paste-buffer
        // mirror); checked again where the text leaves the process, so a new
        // producer cannot slip past the cap.
        if text.len() > MAX_CLIPBOARD_BYTES {
            tracing::debug!(
                ?pane_id,
                bytes = text.len(),
                "clipboard write over the cap, dropped"
            );
            return;
        }
        self.emit(HostEvent::Clipboard {
            pane_id: pane_id.map(|p| p.to_string()).unwrap_or_default(),
            text,
        });
    }

    fn show_message(&self, text: String) {
        self.emit(HostEvent::Message { text });
    }

    /// The bindings and theme are read again now: the prefix read before the
    /// sync is tmux's default on a server that already existed. Read off the
    /// monitor loop, whose own connection answers them.
    fn on_initial_sync_complete(&self) {
        let runtime = Arc::clone(self);
        tokio::spawn(async move { runtime.after_initial_sync().await });
    }
}

impl LogSink for Arc<SessionRuntime> {
    fn log(&self, kind: LogKind, message: String) {
        self.as_ref().log(kind, message);
    }
}
