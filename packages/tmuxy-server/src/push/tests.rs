use super::crypto::{self, b64url, from_b64url, origin, VapidKey};
use super::store::{Store, Subscription, SubscriptionKeys, MAX_SUBSCRIPTIONS};
use super::watch::{Notice, Watch};
use super::Push;
use aes_gcm::aead::Aead;
use aes_gcm::{AeadCore, Aes128Gcm, Key, KeyInit, Nonce};
use hkdf::Hkdf;
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::rand::SystemRandom;
use ring::signature::{UnparsedPublicKey as SignatureKey, ECDSA_P256_SHA256_FIXED};
use sha2::Sha256;
use std::sync::{Arc, Mutex};
use tmuxy_core::host::socket_watch::{parse_rows, PaneRow};

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tmuxy-push-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// A browser's side of a subscription: its key pair and auth secret. The
/// private key opens one push body: ring's ECDH keys are single-use.
struct Browser {
    secret: std::cell::Cell<Option<EphemeralPrivateKey>>,
    public: Vec<u8>,
    auth: [u8; 16],
}

impl Browser {
    fn new() -> Self {
        let secret = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()).unwrap();
        let public = secret.compute_public_key().unwrap().as_ref().to_vec();
        Self {
            secret: std::cell::Cell::new(Some(secret)),
            public,
            auth: *b"0123456789abcdef",
        }
    }

    fn public(&self) -> Vec<u8> {
        self.public.clone()
    }

    fn subscription(&self, endpoint: &str) -> Subscription {
        Subscription {
            endpoint: endpoint.to_string(),
            keys: SubscriptionKeys {
                p256dh: b64url(&self.public()),
                auth: b64url(&self.auth),
            },
        }
    }

    /// What the browser does with a push body (RFC 8291, the receiving
    /// end): the plaintext, or `None` when these keys do not open it.
    fn decrypt(&self, body: &[u8]) -> Option<Vec<u8>> {
        let salt = &body[..16];
        let rs = u32::from_be_bytes(body[16..20].try_into().unwrap());
        assert_eq!(rs, 4096);
        let idlen = body[20] as usize;
        let as_public = &body[21..21 + idlen];
        let ciphertext = &body[21 + idlen..];

        let secret = self.secret.take().expect("one body per browser key");
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(&self.public());
        key_info.extend_from_slice(as_public);
        let ikm = agree_ephemeral(
            secret,
            &UnparsedPublicKey::new(&ECDH_P256, as_public),
            |shared| {
                let mut ikm = [0u8; 32];
                Hkdf::<Sha256>::new(Some(&self.auth), shared)
                    .expand(&key_info, &mut ikm)
                    .unwrap();
                ikm
            },
        )
        .unwrap();
        let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let mut cek = Key::<Aes128Gcm>::default();
        let mut nonce = Nonce::<<Aes128Gcm as AeadCore>::NonceSize>::default();
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
            .unwrap();
        let mut record = Aes128Gcm::new(&cek).decrypt(&nonce, ciphertext).ok()?;
        assert_eq!(record.pop(), Some(2), "the one record is the last one");
        Some(record)
    }
}

/// The body decrypts, with this browser's keys only, to what was sent —
/// a fresh sender key and salt each time, so no two bodies are alike.
#[test]
fn a_push_body_is_readable_by_its_browser_alone() {
    let browser = Browser::new();
    let body = crypto::encrypt(&browser.public(), &browser.auth, b"{\"title\":\"hi\"}").unwrap();
    assert_eq!(
        browser.decrypt(&body).as_deref(),
        Some(&b"{\"title\":\"hi\"}"[..])
    );
    let again = crypto::encrypt(&browser.public(), &browser.auth, b"{\"title\":\"hi\"}").unwrap();
    assert_ne!(body, again);

    let other = Browser::new();
    assert_eq!(other.decrypt(&body), None, "another browser's keys open it");
    assert_eq!(
        crypto::encrypt(&[4u8; 65], &browser.auth, b"x"),
        Err(crypto::EncryptError::BadKey)
    );
}

/// The token is addressed to the push service's origin, expires within a
/// day, names a subject, and verifies against the public key it carries.
#[test]
fn the_vapid_token_is_signed_by_the_key_it_names() {
    let key = VapidKey::generate().unwrap();
    let header = key
        .authorization("https://web.push.apple.com/QGuQyavXutnMH?x=1", 1_000)
        .unwrap();
    let rest = header.strip_prefix("vapid t=").unwrap();
    let (token, k) = rest.split_once(", k=").unwrap();
    assert_eq!(from_b64url(k).unwrap(), key.public_key());

    let (signing_input, signature) = token.rsplit_once('.').unwrap();
    SignatureKey::new(&ECDSA_P256_SHA256_FIXED, key.public_key())
        .verify(signing_input.as_bytes(), &from_b64url(signature).unwrap())
        .unwrap();

    let claims: serde_json::Value =
        serde_json::from_slice(&from_b64url(signing_input.split_once('.').unwrap().1).unwrap())
            .unwrap();
    assert_eq!(claims["aud"], "https://web.push.apple.com");
    assert!(claims["exp"].as_u64().unwrap() - 1_000 <= 24 * 60 * 60);
    assert!(claims["sub"].as_str().unwrap().starts_with("https://"));

    assert_eq!(
        origin("https://fcm.googleapis.com/fcm/send/abc").as_deref(),
        Some("https://fcm.googleapis.com")
    );
    assert_eq!(origin("ftp://example.com/x"), None);
    assert!(key.authorization("not a url", 0).is_none());
}

#[test]
fn the_key_is_kept_and_the_devices_are_capped_deduped_and_private() {
    let dir = scratch("store");
    let store = Store::new(dir.clone());
    let key = store.vapid_key().unwrap();
    assert_eq!(
        Store::new(dir.clone()).vapid_key().unwrap().public_key(),
        key.public_key(),
        "a second read made a new key, orphaning every subscription"
    );

    let browser = Browser::new();
    for i in 0..MAX_SUBSCRIPTIONS + 3 {
        store
            .add(browser.subscription(&format!("https://push.example/{i}")))
            .unwrap();
    }
    store
        .add(browser.subscription("https://push.example/40"))
        .unwrap();
    let all = store.subscriptions();
    assert_eq!(all.len(), MAX_SUBSCRIPTIONS);
    assert_eq!(all.last().unwrap().endpoint, "https://push.example/40");
    assert!(
        !all.iter().any(|s| s.endpoint == "https://push.example/0"),
        "the oldest stays"
    );

    assert!(store.remove("https://push.example/40").unwrap());
    assert!(!store.remove("https://push.example/40").unwrap());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in ["vapid-key", "subscriptions.json"] {
            let mode = std::fs::metadata(dir.join(file))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{file}");
        }
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A key file an older build wrote (the bare 32-byte scalar) does not read:
/// a new key is made, and the devices subscribed with the old one, which
/// could no longer verify a push, are forgotten so they subscribe again.
#[test]
fn a_key_that_no_longer_reads_is_replaced_with_its_devices() {
    let dir = scratch("old-key");
    let store = Store::new(dir.clone());
    store
        .add(Browser::new().subscription("https://push.example/kept"))
        .unwrap();
    std::fs::write(dir.join("vapid-key"), b64url(&[7u8; 32])).unwrap();
    let key = store.vapid_key().unwrap();
    assert_eq!(key.public_key().len(), 65);
    assert!(store.subscriptions().is_empty());
    assert_eq!(
        store.vapid_key().unwrap().public_key(),
        key.public_key(),
        "the new key is kept"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn only_a_push_service_subscription_is_taken() {
    let browser = Browser::new();
    assert!(browser
        .subscription("https://web.push.apple.com/abc")
        .checked()
        .is_ok());
    assert!(browser
        .subscription("http://127.0.0.1:8080/push")
        .checked()
        .is_ok());
    assert!(browser
        .subscription("http://example.com/push")
        .checked()
        .is_err());
    assert!(browser
        .subscription("file:///etc/passwd")
        .checked()
        .is_err());
    let mut short = browser.subscription("https://web.push.apple.com/abc");
    short.keys.auth = b64url(b"short");
    assert!(short.checked().is_err());
}

fn rows(states: &[(&str, &str)], notify: &str) -> Vec<PaneRow> {
    let reported: Vec<(&str, &str, &str)> = states
        .iter()
        .map(|(pane, state)| (*pane, *state, ""))
        .collect();
    rows_reporting(&reported, notify)
}

/// Rows with what a report said each state is about (`@tmuxy-pane-status`).
fn rows_reporting(states: &[(&str, &str, &str)], notify: &str) -> Vec<PaneRow> {
    parse_rows(
        &states
            .iter()
            .map(|(pane, state, status)| {
                format!("{pane}\twork\t{notify}\t{state}\t2.1.314\t\t\t100\t{status}\tmain")
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// A notification is news: a pane entering `needs-input` or `error`, once
/// per entry, and none for what was already so when the watch began, or
/// while `@tmuxy-notify` is off.
#[test]
fn a_pane_coming_to_need_the_user_is_one_notice() {
    let mut watch = Watch::default();
    assert!(watch
        .update(&rows(&[("%1", "needs-input"), ("%2", "")], "on"), "ab350m")
        .is_empty());

    let notices = watch.update(
        &rows(&[("%1", "needs-input"), ("%2", "error")], "on"),
        "ab350m",
    );
    assert_eq!(
        notices,
        vec![Notice {
            title: "claude stopped with an error".into(),
            body: "ab350m · work · main (%2)".into(),
            tag: "tmuxy-%2-error".into(),
            url: "/?session=work".into(),
            pane_id: "%2".into(),
        }]
    );
    assert!(watch
        .update(&rows(&[("%1", "needs-input"), ("%2", "error")], "on"), "")
        .is_empty());

    watch.update(&rows(&[("%1", "working")], "on"), "");
    let again = watch.update(&rows(&[("%1", "needs-input")], "on"), "");
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].title, "claude needs you");

    watch.update(&rows(&[("%1", "working")], "off"), "");
    assert!(watch
        .update(&rows(&[("%1", "needs-input")], "off"), "")
        .is_empty());
}

/// A result (`unread`) is cleared by the client that shows the pane, within
/// the moment it appears there. So it is news only once it has outlasted a
/// read, and then once.
#[test]
fn a_result_nobody_has_seen_by_the_next_read_is_one_notice() {
    const DONE: &str = "state=done:app=make";
    let mut watch = Watch::default();
    watch.update(&rows(&[("%1", "working"), ("%2", "working")], "on"), "");

    let both = [("%1", "unread", DONE), ("%2", "unread", DONE)];
    let entered = watch.update(&rows_reporting(&both, "on"), "");
    assert!(entered.is_empty(), "a client may be showing either pane");

    let one = [("%1", "unread", DONE), ("%2", "", DONE)];
    let waited = watch.update(&rows_reporting(&one, "on"), "host");
    assert_eq!(
        waited,
        vec![Notice {
            title: "claude finished".into(),
            body: "host · work · main (%1)".into(),
            tag: "tmuxy-%1-unread".into(),
            url: "/?session=work".into(),
            pane_id: "%1".into(),
        }],
        "%2 was seen and cleared in between"
    );
    assert!(watch
        .update(&rows_reporting(&[("%1", "unread", DONE)], "on"), "")
        .is_empty());

    watch.update(&rows(&[("%1", "working")], "off"), "");
    watch.update(&rows_reporting(&[("%1", "unread", DONE)], "off"), "");
    assert!(watch
        .update(&rows_reporting(&[("%1", "unread", DONE)], "off"), "")
        .is_empty());
}

/// After a shell's long command the pane's program is the shell again: the
/// notice does not say the shell finished.
#[test]
fn a_shells_finished_command_is_not_named_after_the_shell() {
    let ended = [(
        "%1",
        "unread",
        "state=done:id=tmuxy.command:msg=RmluaXNoZWQ=",
    )];
    let mut watch = Watch::default();
    watch.update(&rows(&[("%1", "")], "on"), "");
    watch.update(&rows_reporting(&ended, "on"), "");
    let notices = watch.update(&rows_reporting(&ended, "on"), "");
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].title, "A command finished");
}

/// `unread` is also what a send leaves on the pane it typed into, and what a
/// state outlived by its text looks like. Nothing finished there.
#[test]
fn an_unread_that_no_report_is_behind_is_no_notice() {
    for status in ["", "state=working:progress=40"] {
        let sent = [("%1", "unread", status)];
        let mut watch = Watch::default();
        watch.update(&rows(&[("%1", "")], "on"), "");
        assert!(watch.update(&rows_reporting(&sent, "on"), "").is_empty());
        assert!(
            watch.update(&rows_reporting(&sent, "on"), "").is_empty(),
            "with {status:?}"
        );
    }
}

/// What a push service receives: an encrypted body, the encoding, a TTL and
/// the VAPID token. A subscription it answers 410 for is forgotten.
#[tokio::test]
async fn a_notice_is_delivered_encrypted_and_a_gone_device_is_forgotten() {
    use axum::{extract::Path, http::HeaderMap, routing::post, Router};

    type Seen = Arc<Mutex<Vec<(String, HeaderMap, Vec<u8>)>>>;
    let seen: Seen = Arc::default();
    let record = Arc::clone(&seen);
    let app = Router::new().route(
        "/push/{id}",
        post(
            move |Path(id): Path<String>, headers: HeaderMap, body: axum::body::Bytes| {
                let record = Arc::clone(&record);
                async move {
                    record
                        .lock()
                        .unwrap()
                        .push((id.clone(), headers, body.to_vec()));
                    if id == "gone" {
                        axum::http::StatusCode::GONE
                    } else {
                        axum::http::StatusCode::CREATED
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let dir = scratch("send");
    let push = Push::with_store(Store::new(dir.clone()));
    let phone = Browser::new();
    let laptop = Browser::new();
    let at = |id: &str| format!("http://127.0.0.1:{port}/push/{id}");
    push.with(|s| s.add(phone.subscription(&at("phone"))))
        .unwrap()
        .unwrap();
    push.with(|s| s.add(laptop.subscription(&at("gone"))))
        .unwrap()
        .unwrap();

    let notice = Notice {
        title: "claude needs you".into(),
        body: "ab350m · tmuxy · main (%3)".into(),
        tag: "tmuxy-%3-needs-input".into(),
        url: "/?session=tmuxy".into(),
        pane_id: "%3".into(),
    };
    push.send(&notice).await;

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    let (_, headers, body) = seen.iter().find(|(id, ..)| id == "phone").unwrap();
    assert_eq!(headers["content-encoding"], "aes128gcm");
    assert_eq!(headers["ttl"], "3600");
    assert!(headers["authorization"]
        .to_str()
        .unwrap()
        .starts_with("vapid t="));
    let delivered: serde_json::Value =
        serde_json::from_slice(&phone.decrypt(body).unwrap()).unwrap();
    assert_eq!(delivered["title"], "claude needs you");
    assert_eq!(delivered["url"], "/?session=tmuxy");
    assert_eq!(delivered["paneId"], "%3");

    let left: Vec<String> = push
        .with(|s| s.subscriptions())
        .unwrap()
        .into_iter()
        .map(|s| s.endpoint)
        .collect();
    assert_eq!(left, vec![at("phone")], "the 410 device is still pushed to");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The routes: the key, and a subscription only when it is one.
#[tokio::test]
async fn a_device_subscribes_with_the_servers_key() {
    use crate::request_guard::HostPolicy;
    use crate::state::{api_routes, AppState};
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    let dir = scratch("routes");
    let state = AppState {
        push: Push::with_store(Store::new(dir.clone())),
        ..Default::default()
    };
    let app = api_routes(HostPolicy::Loopback { allowed: vec![] }).with_state(Arc::new(state));
    let request = |method: &str, path: &str, body: String| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("host", "127.0.0.1:9000")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap()
    };

    let response = app
        .clone()
        .oneshot(request("GET", "/api/push", String::new()))
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), 1 << 16)
        .await
        .unwrap();
    let key: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        from_b64url(key["publicKey"].as_str().unwrap())
            .unwrap()
            .len(),
        65
    );

    let browser = Browser::new();
    let good =
        serde_json::to_string(&browser.subscription("https://web.push.apple.com/a")).unwrap();
    let bad = serde_json::to_string(&browser.subscription("http://example.com/a")).unwrap();
    let status = |r: axum::response::Response| r.status().as_u16();
    assert_eq!(
        status(
            app.clone()
                .oneshot(request("POST", "/api/push/subscription", bad))
                .await
                .unwrap()
        ),
        400
    );
    assert_eq!(
        status(
            app.clone()
                .oneshot(request("POST", "/api/push/subscription", good))
                .await
                .unwrap()
        ),
        204
    );
    assert_eq!(Store::new(dir.clone()).subscriptions().len(), 1);
    let off = r#"{"endpoint":"https://web.push.apple.com/a"}"#.to_string();
    assert_eq!(
        status(
            app.oneshot(request("DELETE", "/api/push/subscription", off))
                .await
                .unwrap()
        ),
        204
    );
    assert!(Store::new(dir.clone()).subscriptions().is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}
