//! Web push notifications: a pane entering `needs-input` or `error` is
//! pushed to every device that turned notifications on — a browser tab, or
//! the app installed on a phone's home screen, open or not.
//!
//! - The device subscribes in the page (`pushManager.subscribe`, with this
//!   server's VAPID public key from `GET /api/push`) and hands the
//!   subscription to `POST /api/push/subscription`; turning them off is
//!   `DELETE` there. All three are API routes behind the same origin rules
//!   and auth as `/commands`.
//! - The watcher (`watch`) reads every pane's state while a subscription
//!   exists, and each entry into a notifying state is one push to each
//!   device: encrypted for that browser and signed with the VAPID key
//!   (`crypto`), sent to the push service its subscription names (Apple's,
//!   Google's, Mozilla's). A subscription the service says is gone (404, 410)
//!   is forgotten.
//! - `@tmuxy-notify off` in tmuxy.conf sends none.
//!
//! See docs/TELEMETRY.md for the connection this adds.

mod crypto;
mod store;
mod watch;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::state::AppState;
use store::{Store, Subscription};
pub(crate) use watch::is_version;
use watch::{Notice, Watch};

/// How often the watcher reads the panes while a device is subscribed.
const WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// How long a push service keeps a notification for a device that is off.
const PUSH_TTL_SECS: u32 = 60 * 60;

/// The most bytes of a subscription request the server reads.
const MAX_SUBSCRIPTION_BYTES: usize = 8 * 1024;

/// The server's web push: where it keeps its key and its devices, and the
/// client it pushes with. The store is touched only under the lock, so two
/// subscribes at once cannot lose one another.
pub struct Push {
    store: StdMutex<Store>,
    client: reqwest::Client,
}

impl Default for Push {
    fn default() -> Self {
        Self::with_store(Store::in_state_dir())
    }
}

impl Push {
    pub(crate) fn with_store(store: Store) -> Self {
        Self {
            store: StdMutex::new(store),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&Store) -> T) -> Option<T> {
        self.store.lock().ok().map(|store| f(&store))
    }

    fn public_key(&self) -> Option<String> {
        self.with(|s| s.vapid_key().ok().map(|k| crypto::b64url(&k.public_key())))
            .flatten()
    }

    fn has_subscriptions(&self) -> bool {
        self.with(|s| !s.subscriptions().is_empty())
            .unwrap_or(false)
    }

    /// Push `notice` to every device, forgetting the ones the push service
    /// says are gone.
    pub(crate) async fn send(&self, notice: &Notice) {
        let Some((key, devices)) = self.with(|s| (s.vapid_key().ok(), s.subscriptions())) else {
            return;
        };
        let Some(key) = key else {
            warn!(target: "tmuxy_server::push", "no VAPID key; nothing pushed");
            return;
        };
        let payload = serde_json::to_vec(notice).unwrap_or_default();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let sends = devices.iter().map(|device| {
            let key = &key;
            let payload = &payload;
            async move { (device, self.send_one(key, device, payload, now).await) }
        });
        for (device, outcome) in futures_util::future::join_all(sends).await {
            match outcome {
                Ok(()) => {}
                Err(Gone) => {
                    info!(target: "tmuxy_server::push", "a push subscription is gone; forgetting it");
                    let _ = self.with(|s| s.remove(&device.endpoint));
                }
            }
        }
    }

    async fn send_one(
        &self,
        key: &crypto::VapidKey,
        device: &Subscription,
        payload: &[u8],
        now: u64,
    ) -> Result<(), Gone> {
        let Ok((p256dh, auth)) = device.checked() else {
            return Err(Gone);
        };
        let Ok(body) = crypto::encrypt(&p256dh, &auth, payload) else {
            return Err(Gone);
        };
        let Some(authorization) = key.authorization(&device.endpoint, now) else {
            return Err(Gone);
        };
        let response = self
            .client
            .post(&device.endpoint)
            .header("TTL", PUSH_TTL_SECS.to_string())
            .header("Urgency", "high")
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("Authorization", authorization)
            .body(body)
            .send()
            .await;
        match response {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) if matches!(r.status().as_u16(), 404 | 410) => Err(Gone),
            Ok(r) => {
                warn!(target: "tmuxy_server::push", status = %r.status(), "push service refused a push");
                Ok(())
            }
            Err(e) => {
                warn!(target: "tmuxy_server::push", error = %e, "push not delivered");
                Ok(())
            }
        }
    }
}

/// A subscription the push service no longer knows, or one no push can be
/// made for: forgotten.
struct Gone;

/// Watch the panes and push what comes to need the user, for the life of
/// the server.
pub async fn watch(state: Arc<AppState>) {
    // The key is read (or made, or an unreadable one replaced along with its
    // devices) before any device can subscribe, so no new subscription is
    // forgotten with an old key.
    let _ = state.push.public_key();
    let shutdown = state.shutdown.clone();
    let host = tmuxy_core::host_name();
    let watched = Arc::clone(&state);
    state
        .spawn(async move {
            let state = watched;
            let mut watch = Watch::default();
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(WATCH_INTERVAL) => {}
                    _ = shutdown.cancelled() => return,
                }
                if !state.push.has_subscriptions() {
                    // A device that subscribes later starts from what is
                    // already showing, not from a stale picture.
                    watch = Watch::default();
                    continue;
                }
                let Some(rows) = watch::read_panes().await else {
                    continue;
                };
                for notice in watch.update(&rows, &host) {
                    debug!(target: "tmuxy_server::push", pane = %notice.pane_id, "pushing a notification");
                    state.push.send(&notice).await;
                }
            }
        })
        .await;
}

// ============================================
// Routes
// ============================================

/// `GET /api/push`: the VAPID public key a device subscribes with.
pub async fn key_handler(State(state): State<Arc<AppState>>) -> Response {
    match state.push.public_key() {
        Some(key) => Json(serde_json::json!({ "publicKey": key })).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "no push key\n").into_response(),
    }
}

/// A JSON body of at most `MAX_SUBSCRIPTION_BYTES`, or the status and
/// reason it is refused with.
async fn read_json<T: serde::de::DeserializeOwned>(
    headers: &HeaderMap,
    body: Body,
) -> Result<T, (StatusCode, String)> {
    if !crate::sse::has_json_content_type(headers) {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type must be application/json\n".to_string(),
        ));
    }
    let bytes = axum::body::to_bytes(body, MAX_SUBSCRIPTION_BYTES)
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "too large\n".to_string()))?;
    serde_json::from_slice(&bytes).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("not a push subscription: {e}\n"),
        )
    })
}

/// `POST /api/push/subscription`: a device turns notifications on.
pub async fn subscribe_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let subscription: Subscription = match read_json(&headers, body).await {
        Ok(s) => s,
        Err(refused) => return refused.into_response(),
    };
    if let Err(why) = subscription.checked() {
        return (StatusCode::BAD_REQUEST, format!("{why}\n")).into_response();
    }
    match state.push.with(|s| s.add(subscription)) {
        Some(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not save the subscription\n",
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
struct Unsubscribe {
    endpoint: String,
}

/// `DELETE /api/push/subscription`: a device turns notifications off.
pub async fn unsubscribe_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let request: Unsubscribe = match read_json(&headers, body).await {
        Ok(r) => r,
        Err(refused) => return refused.into_response(),
    };
    match state.push.with(|s| s.remove(&request.endpoint)) {
        Some(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not forget the subscription\n",
        )
            .into_response(),
    }
}
