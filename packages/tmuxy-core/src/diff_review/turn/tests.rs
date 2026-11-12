use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::*;
use crate::diff_review::tests::repository;
use crate::diff_review::{read_in, Scope};

/// The checkout's top folder, as the widget's script and a read name it.
pub(crate) fn top(dir: &Path) -> PathBuf {
    PathBuf::from(
        git::text(dir, &["rev-parse", "--show-toplevel"], git::deadline())
            .unwrap()
            .trim(),
    )
}

/// Every file under `dir` with its size and modification time: what a write
/// would change. An object's time is left out: git renews it when it meets
/// the object again (freshening), as any `git add` does.
fn fingerprint(dir: &Path) -> BTreeMap<PathBuf, (u64, Option<std::time::SystemTime>)> {
    let objects = dir.join("objects");
    let mut seen = BTreeMap::new();
    let mut folders = vec![dir.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).unwrap().flatten() {
            let meta = entry.metadata().unwrap();
            if meta.is_dir() {
                folders.push(entry.path());
            } else {
                let time = (!entry.path().starts_with(&objects)).then(|| meta.modified().unwrap());
                seen.insert(entry.path(), (meta.len(), time));
            }
        }
    }
    seen
}

fn paths(read: &crate::diff_review::DiffRead) -> Vec<&str> {
    let mut paths: Vec<&str> = read.files.iter().map(|f| f.path.as_str()).collect();
    paths.sort_unstable();
    paths
}

/// A turn holds what changed while the agent worked: not the user's edit
/// from before, nor the one after; untracked files too; and nothing is
/// written into the repository.
#[test]
fn a_turn_is_what_changed_between_its_start_and_its_end() {
    let stores = test_stores();
    let dir = repository("turn");
    let root = top(&dir);
    std::fs::write(dir.join("a.txt"), "one\nmine, before\nthree\n").unwrap();
    let repository_before = fingerprint(&dir.join(".git"));
    assert!(read_in(&dir, Scope::Turn).is_err(), "no turn seen yet");

    begin(&root, "%3");
    std::fs::write(dir.join("sp ace.txt"), "the agent's\n").unwrap();
    std::fs::write(dir.join("new.txt"), "made by the agent\n").unwrap();
    let so_far = read_in(&dir, Scope::Turn).unwrap();
    assert_eq!(paths(&so_far), ["new.txt", "sp ace.txt"]);
    assert_eq!(
        so_far.turn,
        Some(TurnInfo {
            agent: "%3".into(),
            ongoing: true,
            left_out: Vec::new(),
        })
    );

    finish(&root, "%3");
    std::fs::write(dir.join("a.txt"), "one\nmine, after\nthree\n").unwrap();
    std::fs::write(dir.join("later.txt"), "after the turn\n").unwrap();
    let ended = read_in(&dir, Scope::Turn).unwrap();
    assert_eq!(paths(&ended), ["new.txt", "sp ace.txt"]);
    assert!(!ended.turn.unwrap().ongoing);
    // Another pane's end does not end it; a new start replaces it.
    finish(&root, "%4");
    begin(&root, "%4");
    assert!(read_in(&dir, Scope::Turn).unwrap().files.is_empty());

    assert_eq!(
        fingerprint(&dir.join(".git")),
        repository_before,
        "a snapshot wrote into the repository"
    );
    let store = stores
        .join(std::process::id().to_string())
        .join(store_name(&root));
    assert!(store.join("index").exists());
    // The widget closed: every other checkout's turn is kept.
    let others: Vec<PathBuf> = turns().keys().filter(|k| **k != root).cloned().collect();
    keep_only(&others);
    assert!(
        read_in(&dir, Scope::Turn).is_err(),
        "forgotten with its widget"
    );
    assert!(!store.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The names a snapshot never copies, ignored by the repository or not.
#[test]
fn a_secret_is_known_by_its_name() {
    for name in [
        ".env",
        "app/.env.local",
        "prod.env",
        "certs/server.pem",
        "tls.key",
        "id_ed25519",
        "id_rsa.pub",
        ".netrc",
        "credentials.json",
    ] {
        assert!(snapshot::named_like_a_secret(name), "{name}");
    }
    for name in [
        "environment.rs",
        "keys.rs",
        "src/env.ts",
        "README.md",
        "monkey.txt",
    ] {
        assert!(!snapshot::named_like_a_secret(name), "{name}");
    }
}

/// An untracked file too large, or named like a secret, is not copied into
/// the store: it is left out of the turn and named, with why.
#[test]
fn a_large_file_and_a_secret_are_left_out_and_named() {
    let stores = test_stores();
    let dir = repository("turn-caps");
    let root = top(&dir);
    begin(&root, "%5");
    let secret = "API_TOKEN=do-not-copy-this-anywhere\n";
    std::fs::write(dir.join(".env"), secret).unwrap();
    std::fs::write(dir.join("big.bin"), vec![7u8; 2 * 1024 * 1024]).unwrap();
    std::fs::write(dir.join("notes.txt"), "small and plain\n").unwrap();
    finish(&root, "%5");

    let read = read_in(&dir, Scope::Turn).unwrap();
    assert_eq!(paths(&read), ["notes.txt"]);
    assert_eq!(
        read.turn.unwrap().left_out,
        [".env (named like a secret)", "big.bin (over 1 MB)"]
    );
    // Neither is anywhere in the store: no object holds the secret, and the
    // store is far smaller than the large file.
    let store = stores
        .join(std::process::id().to_string())
        .join(store_name(&root));
    let hash = std::process::Command::new("git")
        .args(["hash-object", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut git| {
            use std::io::Write as _;
            git.stdin.take().unwrap().write_all(secret.as_bytes())?;
            git.wait_with_output()
        })
        .unwrap();
    let hash = String::from_utf8(hash.stdout).unwrap();
    let (fan, rest) = hash.trim().split_at(2);
    assert!(!store.join("objects").join(fan).join(rest).exists());
    let stored: u64 = fingerprint(&store).values().map(|(len, _)| len).sum();
    assert!(stored < 1024 * 1024, "the store holds {stored} bytes");

    forget(&root);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A store goes only with its host: one whose process is gone is removed,
/// one whose host still runs is kept, however long since it was written.
#[test]
fn only_the_stores_of_hosts_that_are_gone_are_pruned() {
    let stores = test_stores();
    let gone = stores.join("999999999");
    let running = stores.join(std::process::id().to_string()).join("kept");
    std::fs::create_dir_all(&gone).unwrap();
    std::fs::create_dir_all(&running).unwrap();
    prune_stale_stores();
    assert!(!gone.exists());
    assert!(running.exists());
    std::fs::remove_dir_all(&running).unwrap();
}
