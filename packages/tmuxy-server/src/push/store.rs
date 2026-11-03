//! What the server remembers for web push, in `<state dir>/push/`: its VAPID
//! key, and the subscriptions the devices that turned notifications on gave
//! it. Both files are the user's alone (0600): the key signs this server's
//! pushes, and a subscription is the address a push reaches one browser at.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::crypto::{from_b64url, origin, VapidKey};

/// The most devices the server pushes to; past it the oldest goes.
pub(crate) const MAX_SUBSCRIPTIONS: usize = 32;

/// A browser's push subscription, as `PushSubscription.toJSON()` gives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

impl Subscription {
    /// The keys decoded, or why the subscription is not one a push can be
    /// encrypted for. The endpoint is a push service's: HTTPS, or a loopback
    /// address over HTTP (a test's).
    pub(crate) fn checked(&self) -> Result<(Vec<u8>, Vec<u8>), &'static str> {
        let host_is_loopback = || {
            origin(&self.endpoint).is_some_and(|o| {
                let host = o.trim_start_matches("http://");
                let host = host.rsplit_once(':').map_or(host, |(h, _)| h);
                matches!(host, "127.0.0.1" | "localhost" | "[::1]")
            })
        };
        let https = self.endpoint.starts_with("https://") && origin(&self.endpoint).is_some();
        if !https && !(self.endpoint.starts_with("http://") && host_is_loopback()) {
            return Err("the endpoint is not an HTTPS URL");
        }
        if self.endpoint.len() > 2048 {
            return Err("the endpoint is too long");
        }
        let p256dh = from_b64url(&self.keys.p256dh).filter(|k| k.len() == 65);
        let auth = from_b64url(&self.keys.auth).filter(|k| k.len() == 16);
        match (p256dh, auth) {
            (Some(p256dh), Some(auth)) => Ok((p256dh, auth)),
            _ => Err("the subscription's keys are not a push subscription's"),
        }
    }
}

/// The push directory and what is in it.
pub(crate) struct Store {
    dir: PathBuf,
}

impl Store {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub(crate) fn in_state_dir() -> Self {
        Self::new(tmuxy_core::paths::state_dir().join("push"))
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("vapid-key")
    }

    fn subscriptions_path(&self) -> PathBuf {
        self.dir.join("subscriptions.json")
    }

    /// The VAPID key, made on the first call and kept from then on: a new
    /// key would orphan every subscription made with the old one. One that
    /// no longer reads (an older build kept the bare scalar) is replaced,
    /// and the devices subscribed with it are forgotten, to subscribe again.
    pub(crate) fn vapid_key(&self) -> std::io::Result<VapidKey> {
        if let Some(key) = std::fs::read_to_string(self.key_path())
            .ok()
            .and_then(|text| from_b64url(text.trim()))
            .and_then(|bytes| VapidKey::from_bytes(&bytes))
        {
            return Ok(key);
        }
        // A key file that does not read was another key: the devices on it
        // are its, not the new one's.
        if self.key_path().exists() {
            match std::fs::remove_file(self.subscriptions_path()) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        let key = VapidKey::generate()
            .ok_or_else(|| std::io::Error::other("no random source for a VAPID key"))?;
        write_private(
            &self.key_path(),
            super::crypto::b64url(&key.to_bytes()).as_bytes(),
        )?;
        Ok(key)
    }

    pub(crate) fn subscriptions(&self) -> Vec<Subscription> {
        std::fs::read(self.subscriptions_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, subscriptions: &[Subscription]) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(subscriptions).map_err(std::io::Error::other)?;
        write_private(&self.subscriptions_path(), &json)
    }

    /// Add a device, or renew one already known by its endpoint; the oldest
    /// goes past [`MAX_SUBSCRIPTIONS`].
    pub(crate) fn add(&self, subscription: Subscription) -> std::io::Result<()> {
        let mut all: Vec<Subscription> = self
            .subscriptions()
            .into_iter()
            .filter(|s| s.endpoint != subscription.endpoint)
            .collect();
        all.push(subscription);
        let excess = all.len().saturating_sub(MAX_SUBSCRIPTIONS);
        all.drain(..excess);
        self.save(&all)
    }

    /// Forget the device at `endpoint`; whether one was known.
    pub(crate) fn remove(&self, endpoint: &str) -> std::io::Result<bool> {
        let all = self.subscriptions();
        let kept: Vec<Subscription> = all
            .iter()
            .filter(|s| s.endpoint != endpoint)
            .cloned()
            .collect();
        if kept.len() == all.len() {
            return Ok(false);
        }
        self.save(&kept)?;
        Ok(true)
    }
}

/// Write `bytes` to `path` readable by the user alone, replacing it whole.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // Created 0600, never widened first: the key is a secret from its first
    // byte on disk.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        use std::io::Write as _;
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}
