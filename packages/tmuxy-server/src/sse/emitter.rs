use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tmuxy_core::control_mode::{LogKind, LogSink, MonitorCommandSender, StateEmitter};
use tmuxy_core::transport::{self, KeyBindings};
use tmuxy_core::{CommandError, StateUpdate};
use tracing::{debug, error, info, warn};

use super::clients::set_size_policy;
use super::commands::wait_for_monitor;
use crate::state::{AppState, SessionBroadcast};

// ============================================
// SSE State Emitter (Adapter Pattern)
// ============================================

/// Extract the SSE `event:` discriminator from an already-serialised JSON
/// payload. We peek at the `event` field rather than deserialising into the
/// full `SseEvent` enum because the discriminator is the only thing we need
/// and StateUpdate / Box<...> deserialisation is expensive on the hot path.
/// The name is the serde tag verbatim, so a variant added to `SseEvent`
/// reaches the browser under the name it serialises with. An allowlist here
/// used to decide the name instead, and every variant missing from it — the
/// `detached` and `theme-settings` frames — went out labelled `state-update`,
/// where the client's listener for them never fired and its state-update
/// listener got a payload with no `type`.
///
/// Falls back to `"state-update"` for a payload with no `event` field.
pub(super) fn sse_event_type(payload: &str) -> &str {
    // serde_json::from_str is faster than a full enum decode because we stop
    // at the first matching field, but we still avoid building a Value if we
    // can — match the literal `"event":"..."` substring.
    if let Some(idx) = payload.find("\"event\":\"") {
        let rest = &payload[idx + "\"event\":\"".len()..];
        if let Some(end) = rest.find('"') {
            return &rest[..end];
        }
    }
    "state-update"
}

/// Serialize an `SseEvent` (or compatible serde value) into a wire-format
/// JSON string, logging — rather than panicking — on failure.
///
/// `serde_json::to_string` only fails on `serde::Serialize` impls that error
/// out, which our event types can't do (every field is a plain type). If a
/// future variant ever does, we'd rather drop one message than crash the
/// monitor task that owns the broadcast channel.
pub(super) fn encode_event<T: Serialize>(event: &T) -> Option<String> {
    match serde_json::to_string(event) {
        Ok(s) => Some(s),
        Err(e) => {
            error!(error = %e, "failed to serialize SSE event");
            None
        }
    }
}

/// Emitter that broadcasts state changes to SSE clients
pub struct SseEmitter {
    broadcast: Arc<crate::state::SessionBroadcast>,
    app_state: Arc<AppState>,
    /// The session the monitor feeds, for the reads that go back through it.
    session: String,
    /// Told of every change to the session's shape, so a snapshot follows it.
    keeper: Arc<tmuxy_core::session_snapshot::SnapshotKeeper>,
}

impl SseEmitter {
    pub fn new(
        broadcast: Arc<crate::state::SessionBroadcast>,
        app_state: Arc<AppState>,
        session: String,
        keeper: Arc<tmuxy_core::session_snapshot::SnapshotKeeper>,
    ) -> Self {
        Self {
            broadcast,
            app_state,
            session,
            keeper,
        }
    }

    /// Encode + broadcast in one shot — drops the message on serialize failure
    /// (already logged by `encode_event`). Returns the assigned SSE seq id.
    fn send_event(&self, event: &SseEvent) -> Option<u64> {
        encode_event(event).map(|s| self.broadcast.broadcast(s))
    }
}

impl LogSink for SseEmitter {
    fn log(&self, kind: LogKind, message: String) {
        self.send_event(&SseEvent::Log { kind, message });
    }
}

impl StateEmitter for SseEmitter {
    fn emit_state(&self, update: StateUpdate) {
        transport::on_state_update(&update, &self.keeper, |state| {
            if let Ok(mut guard) = self.app_state.image_store.try_write() {
                guard.retain_live_panes(state);
            }
        });
        self.send_event(&SseEvent::StateUpdate(Box::new(update)));
    }

    fn emit_error(&self, error: String) {
        self.send_event(&SseEvent::Error { message: error });
    }

    fn emit_disconnected(&self, reason: Option<String>) {
        self.send_event(&SseEvent::Detached { reason });
    }

    fn on_initial_sync_complete(&self) {
        // The config has been sourced and the settings enforced: the bindings
        // and the theme + appearance options are the ones to show now. Read
        // off the monitor loop, whose own connection answers them.
        let state = Arc::clone(&self.app_state);
        let session = self.session.clone();
        tokio::spawn(async move {
            refresh_keybindings(&state, &session).await;
            broadcast_theme_settings(&state, &session).await;
        });
    }

    fn store_images(
        &self,
        pane_id: &tmuxy_core::PaneId,
        images: Vec<(u32, tmuxy_core::control_mode::StoredImage)>,
    ) {
        // Use try_write to avoid blocking the monitor loop; drop images if contended
        if let Ok(mut guard) = self.app_state.image_store.try_write() {
            guard.insert(pane_id, images);
        }
    }

    fn write_clipboard(&self, pane_id: Option<&tmuxy_core::PaneId>, text: String) {
        if !transport::clipboard_write_allowed(&text) {
            tracing::debug!(
                ?pane_id,
                bytes = text.len(),
                "clipboard write over the cap, dropped"
            );
            return;
        }
        self.send_event(&SseEvent::Clipboard {
            pane_id: pane_id.map(|p| p.to_string()).unwrap_or_default(),
            text,
        });
    }

    fn show_message(&self, text: String) {
        self.send_event(&SseEvent::Message { text });
    }
}

// ============================================
// SSE Event Types
// ============================================

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub(super) enum SseEvent {
    #[serde(rename = "connection-info")]
    ConnectionInfo {
        connection_id: u64,
        default_shell: String,
        trace_enabled: bool,
        /// The server machine's name (`crate::host_name`), for the status line.
        hostname: String,
    },
    #[serde(rename = "state-update")]
    StateUpdate(Box<StateUpdate>),
    /// A backend error for the user (a rejected command, a failed sync).
    /// Named `tmux-error` on the wire, never `error`: the browser dispatches
    /// a server event called `error` to `EventSource.onerror` as well, and
    /// the adapter would take every reported error for a dropped connection.
    #[serde(rename = "tmux-error")]
    Error { message: String },
    #[serde(rename = "keybindings")]
    KeyBindings(KeyBindings),
    /// Theme name/mode + appearance (`tmuxy_core::theme::get_theme_settings`),
    /// pushed after the config is sourced so option changes apply live.
    #[serde(rename = "theme-settings")]
    ThemeSettings(serde_json::Value),
    /// A theme file or `custom.css` under the config dir was saved: the
    /// client re-fetches its stylesheets and the themes list.
    #[serde(rename = "css-changed")]
    CssChanged,
    #[serde(rename = "log")]
    Log { kind: LogKind, message: String },
    #[serde(rename = "fatal")]
    Fatal { message: String },
    /// The control-mode connection ended, with tmux's own `%exit` reason when
    /// it gave one (`detached` when the client was detached deliberately).
    /// Distinct from `tmux-error` so a client can tell an intentional detach
    /// from a dropped link and stop presenting one as the other.
    #[serde(rename = "detached")]
    Detached { reason: Option<String> },
    /// OSC 52 clipboard request from a terminal application.
    /// Frontend mirrors the text into the system clipboard via navigator.clipboard.
    #[serde(rename = "clipboard")]
    Clipboard { pane_id: String, text: String },
    /// A message tmux showed this client (`display-message`). Named
    /// `tmux-message`, never `message`: that is `EventSource`'s default event
    /// type, which `onmessage` would receive as well.
    #[serde(rename = "tmux-message")]
    Message { text: String },
}

/// Read the session's bindings over its monitor, keep them for the next
/// stream's greeting, and broadcast them to the streams open now.
pub(super) async fn refresh_keybindings(state: &Arc<AppState>, session: &str) {
    let Ok(tx) = state.monitor_tx(session).await else {
        return;
    };
    let bindings = KeyBindings::read(&tx).await;
    let Some(msg) = encode_event(&SseEvent::KeyBindings(bindings.clone())) else {
        return;
    };
    let mut sessions = state.sessions.write().await;
    if let Some(conns) = sessions.get_mut(session) {
        conns.key_bindings = Some(bindings);
        conns.broadcast.broadcast(msg);
        debug!(%session, "broadcast refreshed keybindings");
    }
}

/// The theme name, mode and appearance to answer a client with, read over the
/// session's monitor afresh (its own `source-file` can change it), waiting
/// for a monitor that is still connecting.
pub(super) async fn theme_settings_for(
    state: &Arc<AppState>,
    session: &str,
) -> Result<serde_json::Value, CommandError> {
    let tx = wait_for_monitor(state, session).await?;
    let settings = tmuxy_core::theme::get_theme_settings(&tx).await?;
    // The session is sized by the same read the clients scale by.
    let policy = settings["appearance"]["size"].clone();
    if let Ok(policy) = serde_json::from_value(policy) {
        set_size_policy(state, session, policy).await;
    }
    Ok(settings)
}

pub(super) async fn broadcast_theme_settings(state: &Arc<AppState>, session: &str) {
    let settings = match theme_settings_for(state, session).await {
        Ok(settings) => settings,
        Err(e) => {
            warn!(%session, error = %e, "could not read theme settings");
            return;
        }
    };
    let Some(msg) = encode_event(&SseEvent::ThemeSettings(settings)) else {
        return;
    };
    let sessions = state.sessions.read().await;
    if let Some(session_conn) = sessions.get(session) {
        session_conn.broadcast.broadcast(msg);
        debug!(%session, "broadcast refreshed theme settings");
    }
}

/// Watch the config dir for the user's edits, for the life of the server. A
/// saved stylesheet is announced to every session's clients; a saved
/// `tmuxy.conf` is sourced on each session's monitor and followed by the
/// bindings and theme settings it may have changed — what a client's own
/// `source-file` gets.
pub async fn watch_config_dir(state: Arc<AppState>) {
    let shutdown = state.shutdown.clone();
    let watcher = state.clone();
    state
        .spawn(async move {
            tokio::select! {
                _ = transport::watch_config(|change| {
                    let state = watcher.clone();
                    tokio::spawn(async move { apply_config_change(&state, change).await });
                }) => {}
                _ = shutdown.cancelled() => {}
            }
        })
        .await;
}

async fn apply_config_change(state: &Arc<AppState>, change: transport::ConfigChange) {
    let sessions: Vec<(String, Arc<SessionBroadcast>, Option<MonitorCommandSender>)> = state
        .sessions
        .read()
        .await
        .iter()
        .map(|(name, conns)| {
            (
                name.clone(),
                conns.broadcast.clone(),
                conns.monitor_command_tx.clone(),
            )
        })
        .collect();
    match change {
        transport::ConfigChange::Css => {
            let Some(msg) = encode_event(&SseEvent::CssChanged) else {
                return;
            };
            for (session, broadcast, _) in &sessions {
                broadcast.broadcast(msg.clone());
                debug!(%session, "broadcast css-changed");
            }
        }
        transport::ConfigChange::Conf => {
            for (session, _, tx) in &sessions {
                let Some(tx) = tx else { continue };
                match transport::source_config(tx).await {
                    Ok(()) => info!(%session, "sourced the saved tmuxy.conf"),
                    Err(e) => {
                        warn!(%session, error = %e, "could not source the saved tmuxy.conf");
                        continue;
                    }
                }
                refresh_keybindings(state, session).await;
                broadcast_theme_settings(state, session).await;
            }
        }
    }
}
