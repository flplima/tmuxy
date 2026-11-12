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
            ongoing: true
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
