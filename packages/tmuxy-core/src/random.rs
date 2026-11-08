//! Values nobody on the tmux socket can work out in advance: the control-mode
//! marker token, plugin invocation and job tokens, ask tokens, MCP client ids
//! and the trace salt.
//!
//! All come from the OS random source through `getrandom`; on
//! wasm32-unknown-unknown that is the browser's `crypto.getRandomValues`,
//! which tmuxy-wasm turns on with getrandom's `wasm_js` feature. std's
//! `RandomState` is not a substitute: on wasm32-unknown-unknown it has no OS
//! seed, so a token built on it is the same on every page load of a build.

/// `N` bytes from the OS random source.
pub fn bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    // Every value here guards against a program that can write to a pane or
    // read the socket; with no random source there is no secret to fall back
    // to, so the process stops rather than hand out a guessable one.
    #[allow(clippy::expect_used)]
    getrandom::fill(&mut buf).expect("no OS random source");
    buf
}

/// 128 random bits as 32 lowercase hex digits: safe in a file name, a tmux
/// command line and a `display-message` format alike.
pub fn token() -> String {
    bytes::<16>().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn u64() -> u64 {
    u64::from_le_bytes(bytes())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_token_is_32_hex_digits_and_never_repeats() {
        let a = super::token();
        let b = super::token();
        assert_eq!(a.len(), 32);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }

    /// Every unguessable value goes through this module. A `RandomState`
    /// standing in for randomness is what made the wasm marker token one
    /// fixed value per build: std seeds it from nothing on
    /// wasm32-unknown-unknown.
    #[test]
    fn no_other_source_of_randomness_in_the_crates() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut offenders = Vec::new();
        for krate in [
            "tmuxy-core",
            "tmuxy-server",
            "tmuxy-verbs",
            "tmuxy-wasm",
            "tmuxy-tauri-app",
        ] {
            let mut stack = vec![root.join(krate).join("src")];
            while let Some(dir) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if path.extension().is_some_and(|e| e == "rs")
                        && !path.ends_with("tmuxy-core/src/random.rs")
                    {
                        let text = std::fs::read_to_string(&path).unwrap_or_default();
                        if text.contains("RandomState::new()") || text.contains("/dev/urandom") {
                            offenders.push(path.display().to_string());
                        }
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "randomness outside crate::random: {offenders:?}"
        );
    }
}
