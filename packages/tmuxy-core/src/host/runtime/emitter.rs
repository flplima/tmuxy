use std::sync::Arc;

use super::SessionRuntime;
use crate::control_mode::{LogKind, LogSink, StateEmitter, StoredImage};
use crate::host::HostEvent;
use crate::transport;
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
    fn emit_state(&self, update: StateUpdate) {
        self.preview.sync_update(&self.preview_scope, &update);
        transport::on_state_update(&update, &self.keeper, |state| {
            // try_write, so a contended lock never stalls the monitor loop;
            // the next full state sweeps again.
            if let Ok(mut images) = self.images.try_write() {
                images.retain_live_panes(state);
            }
        });
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
        // A dropped picture is redrawn by the next frame.
        if let Ok(mut store) = self.images.try_write() {
            store.insert(pane_id, images);
        }
    }

    fn write_clipboard(&self, pane_id: Option<&PaneId>, text: String) {
        if !transport::clipboard_write_allowed(&text) {
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
