//! A watched session: everything a host keeps beside a session's monitor.
//!
//! The web server keeps one per session a browser watches, the desktop app
//! one per window. A host supplies only a [`Sink`], where an event goes, and
//! the [`super::Host`] policy the monitor loop runs under.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::watch;

use super::bindings::{self, ConfigChange, ImageStore, KeyBindings};
use super::event::{ConnectionInfo, HostEvent};
use crate::client_size::SizePolicy;
use crate::control_mode::{MonitorCommand, MonitorCommandSender, StoredImage};
use crate::preview::PreviewPages;
use crate::session_snapshot::{self as snapshot, SnapshotKeeper};
use crate::theme::ThemeSettings;
use crate::{CommandError, PaneId};

/// The web's connection id, or the desktop's 0 (one client per window).
pub type ClientId = u64;

/// Where a session's events go.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, event: HostEvent);

    /// The theme settings were read afresh: what the host does with them
    /// besides telling its client (the desktop puts the window's blur and its
    /// two-finger slide where they say).
    fn appearance(&self, _settings: &ThemeSettings) {}
}

/// How long a command waits for a monitor that is still connecting. The
/// monitor's own connect gives tmux ten seconds to answer, so any shorter
/// wait refuses a command a connect still in progress would have served (a
/// page whose stream came back sends what was typed meanwhile at once).
pub const MONITOR_READY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
enum Link {
    /// The monitor loop is connecting, or about to go round again: wait.
    Connecting,
    Up(MonitorCommandSender),
    /// The loop has stopped, parked or given up: nothing to wait for.
    Down,
}

#[derive(Default)]
struct Sizes {
    clients: HashMap<ClientId, (u32, u32)>,
    /// The client used last (a command or a new size): whose viewport a
    /// `latest` session takes.
    latest: Option<ClientId>,
    /// `@tmuxy-size`, as the config last said it.
    policy: SizePolicy,
    /// The size last delivered to the monitor, so the same size is not asked
    /// for twice — which stops a feedback loop between clients of different
    /// sizes. Cleared when the connection ends: the next attach starts at the
    /// control-mode PTY's size.
    sent: Option<(u32, u32)>,
}

impl Sizes {
    fn size(&self) -> Option<(u32, u32)> {
        let latest = self.latest.and_then(|id| self.clients.get(&id).copied());
        self.policy.resolve(self.clients.values().copied(), latest)
    }
}

pub struct RuntimeConfig {
    pub session: String,
    /// The host's staged preview pages, and the scope this session's are
    /// kept under (the session name on the web, the window label on the
    /// desktop).
    pub preview: Arc<PreviewPages>,
    pub preview_scope: String,
    /// Whether a session about to be created is rebuilt from its snapshot:
    /// off for `tmuxy server --no-restore` and `TMUXY_NO_RESTORE=1`.
    pub restore: bool,
}

pub struct SessionRuntime {
    session: RwLock<String>,
    sink: Arc<dyn Sink>,
    link: watch::Sender<Link>,
    keeper: Arc<SnapshotKeeper>,
    images: RwLock<ImageStore>,
    bindings: Mutex<Option<KeyBindings>>,
    sizes: Mutex<Sizes>,
    preview: Arc<PreviewPages>,
    preview_scope: String,
    restore: bool,
    /// `TMUXY_NO_SNAPSHOT=1` turns the autosave off, read once here.
    autosave: bool,
}

impl SessionRuntime {
    pub fn new(config: RuntimeConfig, sink: Arc<dyn Sink>) -> Arc<Self> {
        let (link, _) = watch::channel(Link::Connecting);
        Arc::new(Self {
            session: RwLock::new(config.session),
            sink,
            link,
            keeper: Arc::new(SnapshotKeeper::new()),
            images: RwLock::new(ImageStore::default()),
            bindings: Mutex::new(None),
            sizes: Mutex::new(Sizes::default()),
            preview: config.preview,
            preview_scope: config.preview_scope,
            restore: config.restore && !snapshot::restore_disabled(),
            autosave: !snapshot::autosave_disabled(),
        })
    }

    pub fn session(&self) -> String {
        self.session
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Takes effect from the next connect (the desktop's `tmuxy connect`).
    pub fn set_session(&self, session: String) {
        *self.session.write().unwrap_or_else(|e| e.into_inner()) = session;
    }

    pub fn keeper(&self) -> &Arc<SnapshotKeeper> {
        &self.keeper
    }

    pub(crate) fn restores(&self) -> bool {
        self.restore
    }

    pub(crate) fn autosaves(&self) -> bool {
        self.autosave
    }

    pub fn emit(&self, event: HostEvent) {
        self.sink.emit(event);
    }

    /// The monitor loop is about to connect: commands wait for it.
    pub fn set_connecting(&self) {
        self.link.send_replace(Link::Connecting);
    }

    /// Nothing is connecting (the loop stopped or parked, or the host never
    /// started one): commands are refused at once.
    pub fn set_down(&self) {
        self.link.send_replace(Link::Down);
    }

    /// The connection is up: commands go to `tx` from now on, and the
    /// session is sized to its clients — queued behind the attach's own
    /// resize to the control-mode PTY, so on a reconnect this is what brings
    /// a surviving session back to the viewport it was at.
    pub async fn connected(&self, tx: MonitorCommandSender) {
        self.link.send_replace(Link::Up(tx));
        self.apply_size().await;
    }

    /// The connection ended: what reached tmux on it is no longer what the
    /// session is.
    pub fn disconnected(&self) {
        self.link.send_replace(Link::Connecting);
        self.lock_sizes().sent = None;
    }

    /// The live command channel, without waiting for a connect.
    pub fn tx_now(&self) -> Option<MonitorCommandSender> {
        match &*self.link.borrow() {
            Link::Up(tx) => Some(tx.clone()),
            Link::Connecting | Link::Down => None,
        }
    }

    /// The command channel, waiting up to [`MONITOR_READY_TIMEOUT`] for a
    /// monitor that is still connecting; a monitor that has stopped is
    /// refused at once.
    pub async fn channel(&self) -> Result<MonitorCommandSender, CommandError> {
        let mut rx = self.link.subscribe();
        let ready = async {
            rx.wait_for(|link| !matches!(link, Link::Connecting))
                .await
                .map(|link| link.clone())
        };
        match tokio::time::timeout(MONITOR_READY_TIMEOUT, ready).await {
            Ok(Ok(Link::Up(tx))) => Ok(tx),
            Ok(_) => Err(CommandError::unavailable("No monitor connection available")),
            Err(_) => Err(CommandError::unavailable(
                "tmux monitor did not come up in time",
            )),
        }
    }

    /// Tell the monitor to end its connection (a detach, a switch of
    /// servers, a shutdown).
    pub async fn shut_down_connection(&self) {
        if let Some(tx) = self.tx_now() {
            if tx.send(MonitorCommand::Shutdown).await.is_err() {
                tracing::debug!(session = %self.session(), "the monitor was already gone");
            }
        }
    }

    fn lock_sizes(&self) -> std::sync::MutexGuard<'_, Sizes> {
        self.sizes.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The size the session should be, by its `@tmuxy-size` over every
    /// client's viewport; `None` while none has reported and the size is not
    /// fixed. What a freshly created window is sized to, too.
    pub fn size(&self) -> Option<(u32, u32)> {
        self.lock_sizes().size()
    }

    /// The size last delivered to tmux, which a client's first state waits
    /// to agree with (`initial_state_for_size`).
    pub fn sent_size(&self) -> Option<(u32, u32)> {
        self.lock_sizes().sent
    }

    /// A client's viewport. A size smaller than the floor is taken at the
    /// floor (`clamp_client_size`); a zero is no report at all. Only a new
    /// size is a use of the client: one whose grid is not its own size
    /// reports the same one again on every update, and counting that made
    /// two clients take a `latest` session from each other on every frame.
    pub async fn set_client_size(&self, client: ClientId, cols: u32, rows: u32) {
        if cols == 0 || rows == 0 {
            return;
        }
        let size = crate::client_size::clamp_client_size(cols, rows);
        {
            let mut sizes = self.lock_sizes();
            if sizes.clients.insert(client, size) != Some(size) {
                sizes.latest = Some(client);
            }
        }
        self.apply_size().await;
    }

    /// A client sent a command: it is the one used last. Under `latest` that
    /// moves the session to its viewport.
    pub async fn note_activity(&self, client: ClientId) {
        let follow = {
            let mut sizes = self.lock_sizes();
            if sizes.latest == Some(client) || !sizes.clients.contains_key(&client) {
                return;
            }
            sizes.latest = Some(client);
            sizes.policy == SizePolicy::Latest
        };
        if follow {
            self.apply_size().await;
        }
    }

    pub async fn client_left(&self, client: ClientId) {
        let had_size = {
            let mut sizes = self.lock_sizes();
            if sizes.latest == Some(client) {
                sizes.latest = None;
            }
            sizes.clients.remove(&client).is_some()
        };
        if had_size {
            self.apply_size().await;
        }
    }

    async fn set_size_policy(&self, policy: SizePolicy) {
        let changed = {
            let mut sizes = self.lock_sizes();
            std::mem::replace(&mut sizes.policy, policy) != policy
        };
        if changed {
            tracing::debug!(session = %self.session(), ?policy, "size policy changed");
            self.apply_size().await;
        }
    }

    /// Resize tmux to the size the policy picks, unless that is what was
    /// delivered last. A size is recorded as delivered only once the monitor
    /// took it: with no monitor yet the next report must be able to try
    /// again, or the client's size never arrives and the window stays at the
    /// control-mode PTY's 200x50 while the client draws 41 columns.
    async fn apply_size(&self) {
        let Some(size) = ({
            let sizes = self.lock_sizes();
            sizes.size().filter(|size| sizes.sent != Some(*size))
        }) else {
            return;
        };
        let Some(tx) = self.tx_now() else {
            tracing::debug!(session = %self.session(), "no monitor yet, the size waits for the next report");
            return;
        };
        let (cols, rows) = size;
        match tx.send(MonitorCommand::ResizeWindow { cols, rows }).await {
            Ok(()) => self.lock_sizes().sent = Some(size),
            Err(e) => {
                tracing::warn!(session = %self.session(), error = %e, "monitor channel closed, resize not sent")
            }
        }
    }

    /// The bindings the monitor last read, which a new client is greeted
    /// with at no tmux round trip.
    pub fn bindings(&self) -> Option<KeyBindings> {
        self.bindings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub async fn refresh_bindings(&self) {
        let Ok(tx) = self.channel().await else {
            return;
        };
        let bindings = KeyBindings::read(&tx).await;
        *self.bindings.lock().unwrap_or_else(|e| e.into_inner()) = Some(bindings.clone());
        self.emit(HostEvent::KeyBindings(bindings));
    }

    /// The theme settings, read afresh (a `source-file` can change them).
    /// The session is sized by the same read the clients scale by, and the
    /// host applies what it applies of them.
    pub async fn theme_settings(&self) -> Result<ThemeSettings, CommandError> {
        let tx = self.channel().await?;
        let settings = crate::theme::get_theme_settings(&tx).await?;
        self.set_size_policy(settings.appearance.size).await;
        self.sink.appearance(&settings);
        Ok(settings)
    }

    pub async fn push_theme_settings(&self) {
        match self.theme_settings().await {
            Ok(settings) => self.emit(HostEvent::ThemeSettings(Box::new(settings))),
            Err(e) => {
                tracing::warn!(session = %self.session(), error = %e, "could not read theme settings")
            }
        }
    }

    pub async fn push_config(&self) {
        self.refresh_bindings().await;
        self.push_theme_settings().await;
    }

    /// The user saved a file under the config dir. A saved `tmuxy.conf` gets
    /// what a client's own `source-file` gets.
    pub async fn config_changed(&self, change: ConfigChange) {
        match change {
            ConfigChange::Css => self.emit(HostEvent::CssChanged),
            ConfigChange::Conf => {
                let Some(tx) = self.tx_now() else {
                    return;
                };
                match bindings::source_config(&tx).await {
                    Ok(()) => {
                        tracing::info!(session = %self.session(), "sourced the saved tmuxy.conf");
                        self.push_config().await;
                    }
                    Err(e) => {
                        tracing::warn!(session = %self.session(), error = %e, "could not source the saved tmuxy.conf")
                    }
                }
            }
        }
    }

    /// What a client is greeted with: who it is, and the bindings when the
    /// monitor has read them (a client that got here first is sent them by
    /// the initial sync).
    pub fn greeting(&self, client: ClientId) -> Vec<HostEvent> {
        std::iter::once(HostEvent::ConnectionInfo(ConnectionInfo::for_client(
            client,
        )))
        .chain(self.bindings().map(HostEvent::KeyBindings))
        .collect()
    }

    pub fn image(&self, pane: &PaneId, id: u32) -> Option<StoredImage> {
        self.images
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(pane, id)
            .cloned()
    }

    pub fn preview_pages(&self) -> &PreviewPages {
        &self.preview
    }

    /// Save the session's snapshot now, as the autosave would after its
    /// debounce, before a host goes down. A session still being rebuilt is
    /// half of what its snapshot says: the snapshot it is being rebuilt FROM
    /// is the one to keep.
    pub async fn save_snapshot_now(&self, timeout: Duration) {
        if !self.autosave || self.keeper.restoring() {
            return;
        }
        let Some(tx) = self.tx_now() else {
            return;
        };
        let session = self.session();
        let dir = snapshot::default_dir();
        let save = snapshot::save_now(&session, &dir, &tx);
        if tokio::time::timeout(timeout, save).await.is_err() {
            tracing::warn!(%session, "the last snapshot timed out");
        }
    }

    /// What follows the monitor's own config sync: the plugin keys first, so
    /// the bindings read next include them, then everything a config sets.
    async fn after_initial_sync(&self) {
        if let Some(tx) = self.tx_now() {
            if let Err(e) = super::plugins::apply_plugin_keys(&tx).await {
                tracing::warn!(error = %e, "could not bind the plugin keys");
            }
        }
        self.push_config().await;
    }
}

mod emitter;

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
