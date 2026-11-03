//! The two halves of a web push request a push service and a browser read:
//! the VAPID `Authorization` that says which server sent it (RFC 8292), and
//! the body, encrypted for the one browser it is for (RFC 8291, `aes128gcm`).
//! The push service carries the ciphertext and cannot read it.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;

/// How long a VAPID token is good for: push services refuse one past 24 h.
const VAPID_LIFETIME_SECS: u64 = 12 * 60 * 60;

/// Who to tell if this server misbehaves, as RFC 8292 asks every sender to
/// say; Apple's push service refuses a token without one.
const VAPID_SUBJECT: &str = "https://github.com/flplima/tmuxy";

/// The record size the one record of a body is declared with.
const RECORD_SIZE: u32 = 4096;

pub(crate) fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn from_b64url(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).ok()
}

/// This server's VAPID key: the browser subscribes with its public half, and
/// every push is signed with it, so a push service delivers only this
/// server's pushes to the subscriptions it made.
pub(crate) struct VapidKey(SigningKey);

impl VapidKey {
    pub(crate) fn generate() -> Self {
        Self(SigningKey::random(&mut OsRng))
    }

    /// The 32-byte private scalar, as `to_bytes` writes it.
    pub(crate) fn from_bytes(bytes: &[u8]) -> Option<Self> {
        SigningKey::from_slice(bytes).ok().map(Self)
    }

    pub(crate) fn to_bytes(&self) -> Vec<u8> {
        self.0.to_bytes().to_vec()
    }

    /// The uncompressed public point: what `pushManager.subscribe` takes as
    /// its `applicationServerKey`.
    pub(crate) fn public_key(&self) -> Vec<u8> {
        self.0
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    }

    /// The `Authorization: vapid t=…, k=…` header for a push to `endpoint`
    /// at `now` (seconds since the epoch). `None` for an endpoint with no
    /// origin to address the token to.
    pub(crate) fn authorization(&self, endpoint: &str, now: u64) -> Option<String> {
        let audience = origin(endpoint)?;
        let header = b64url(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({
            "aud": audience,
            "exp": now + VAPID_LIFETIME_SECS,
            "sub": VAPID_SUBJECT,
        });
        let signing_input = format!("{header}.{}", b64url(claims.to_string().as_bytes()));
        let signature: Signature = self.0.sign(signing_input.as_bytes());
        Some(format!(
            "vapid t={signing_input}.{}, k={}",
            b64url(&signature.to_bytes()),
            b64url(&self.public_key())
        ))
    }
}

/// `scheme://host[:port]` of a URL: what a VAPID token is addressed to.
pub(crate) fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    (!authority.is_empty() && matches!(scheme, "https" | "http"))
        .then(|| format!("{scheme}://{authority}"))
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub(crate) enum EncryptError {
    #[error("the subscription's p256dh is not a P-256 public key")]
    BadKey,
    #[error("a key derivation failed")]
    Derive,
    #[error("the payload did not encrypt")]
    Encrypt,
}

/// `plaintext` encrypted for the browser whose subscription holds
/// `ua_public` (`p256dh`) and `auth`: one `aes128gcm` record behind the
/// header that names the salt and this message's own public key.
pub(crate) fn encrypt(
    ua_public: &[u8],
    auth: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, EncryptError> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt_with(
        ua_public,
        auth,
        plaintext,
        &SecretKey::random(&mut OsRng),
        salt,
    )
}

/// [`encrypt`] with this message's key pair and salt given — fresh ones for
/// every push in [`encrypt`], fixed ones for the RFC's own example in a test.
pub(crate) fn encrypt_with(
    ua_public: &[u8],
    auth: &[u8],
    plaintext: &[u8],
    secret: &SecretKey,
    salt: [u8; 16],
) -> Result<Vec<u8>, EncryptError> {
    let ua = PublicKey::from_sec1_bytes(ua_public).map_err(|_| EncryptError::BadKey)?;
    let as_public = secret.public_key().to_encoded_point(false);
    let as_public = as_public.as_bytes();
    let shared = diffie_hellman(secret.to_nonzero_scalar(), ua.as_affine());

    // RFC 8291 §3.3: the input keying material, from the shared secret and
    // the subscription's auth secret, bound to both public keys.
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes().as_slice())
        .expand(&key_info, &mut ikm)
        .map_err(|_| EncryptError::Derive)?;

    // RFC 8188 §2.2: the content key and the nonce, from the salt.
    let prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| EncryptError::Derive)?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| EncryptError::Derive)?;

    // One record, so the last one: the plaintext and the 0x02 delimiter.
    let mut record = plaintext.to_vec();
    record.push(2);
    let ciphertext = Aes128Gcm::new(&cek.into())
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| EncryptError::Encrypt)?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}
