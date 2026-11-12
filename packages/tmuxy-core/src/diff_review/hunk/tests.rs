use std::path::PathBuf;

use super::*;
use crate::diff_review::tests::{repository, setup};
use crate::diff_review::DiffRead;

/// Twenty numbered lines, committed; then lines 2 and 18 changed, so the
/// file's unstaged patch has two hunks.
fn two_hunks(name: &str) -> (PathBuf, PathBuf) {
    let dir = repository(name);
    let file = dir.join("list.txt");
    let lines: Vec<String> = (1..=20).map(|n| format!("line {n}")).collect();
    std::fs::write(&file, lines.join("\n") + "\n").unwrap();
    setup(&dir, &["add", "list.txt"]);
    setup(&dir, &["commit", "-qm", "list"]);
    let mut changed = lines;
    changed[1] = "line 2, changed".into();
    changed[17] = "line 18, changed".into();
    std::fs::write(&file, changed.join("\n") + "\n").unwrap();
    (dir, file)
}

fn file<'a>(read: &'a DiffRead, path: &str) -> Option<&'a DiffFile> {
    read.files.iter().find(|f| f.path == path)
}

fn request(read: &DiffRead, path: &str, hunk: usize, action: HunkAction) -> HunkRequest {
    HunkRequest {
        scope: read.scope,
        path: path.into(),
        hunk,
        token: file(read, path).unwrap().token.clone(),
        action,
    }
}

fn hunk_texts(read: &DiffRead, path: &str) -> Vec<String> {
    file(read, path).map_or_else(Vec::new, |f| {
        f.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind == crate::diff_review::LineKind::Added)
            .map(|l| l.text.clone())
            .collect()
    })
}

#[test]
fn one_hunk_is_staged_and_unstaged_alone() {
    test_reverts();
    let (dir, _) = two_hunks("hunk-stage");
    let unstaged = read_in(&dir, Scope::Unstaged).unwrap();
    assert_eq!(file(&unstaged, "list.txt").unwrap().hunks.len(), 2);

    change_in(&dir, &request(&unstaged, "list.txt", 0, HunkAction::Stage)).unwrap();
    let staged = read_in(&dir, Scope::Staged).unwrap();
    assert_eq!(hunk_texts(&staged, "list.txt"), ["line 2, changed"]);
    let unstaged = read_in(&dir, Scope::Unstaged).unwrap();
    assert_eq!(hunk_texts(&unstaged, "list.txt"), ["line 18, changed"]);

    change_in(&dir, &request(&staged, "list.txt", 0, HunkAction::Unstage)).unwrap();
    assert!(read_in(&dir, Scope::Staged).unwrap().files.is_empty());
    let unstaged = read_in(&dir, Scope::Unstaged).unwrap();
    assert_eq!(file(&unstaged, "list.txt").unwrap().hunks.len(), 2);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_revert_throws_one_hunk_away_and_its_undo_puts_it_back() {
    let reverts = test_reverts();
    let (dir, path) = two_hunks("hunk-revert");
    let before = std::fs::read_to_string(&path).unwrap();
    let unstaged = read_in(&dir, Scope::Unstaged).unwrap();

    let done = change_in(&dir, &request(&unstaged, "list.txt", 1, HunkAction::Revert)).unwrap();
    let id = done.revert.expect("a revert has an id");
    let after = std::fs::read_to_string(&path).unwrap();
    assert!(after.contains("line 2, changed\n"));
    assert!(after.contains("line 18\n") && !after.contains("line 18, changed"));
    assert_eq!(
        std::fs::read_to_string(reverts.join(&id).join("before")).unwrap(),
        before
    );

    undo_in(&dir, &id).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    assert!(!reverts.join(&id).exists());
    assert!(undo_in(&dir, &id).is_err(), "an undo is done once");
    for id in ["", "../x", "1/2"] {
        assert!(undo_in(&dir, id).is_err(), "{id:?}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The diff was drawn, then the file changed: the hunk drawn is no longer
/// what git would act on, so nothing is done and nothing is kept.
#[test]
fn a_file_edited_since_the_diff_was_drawn_is_not_reverted() {
    let reverts = test_reverts();
    let (dir, path) = two_hunks("hunk-stale");
    let drawn = read_in(&dir, Scope::Unstaged).unwrap();
    let edited = std::fs::read_to_string(&path)
        .unwrap()
        .replace("line 10\n", "line 10, edited after the diff was drawn\n");
    std::fs::write(&path, &edited).unwrap();

    let refused = change_in(&dir, &request(&drawn, "list.txt", 0, HunkAction::Revert)).unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("changed since the diff was drawn"),
        "{refused}"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
    // No copy names this file: other tests keep theirs in the same folder.
    let ours = path.display().to_string();
    let copies = std::fs::read_dir(&reverts).map_or(0, |dir| {
        dir.flatten()
            .filter(|entry| {
                std::fs::read_to_string(entry.path().join("file")).ok() == Some(ours.clone())
            })
            .count()
    });
    assert_eq!(copies, 0, "a refused revert keeps no copy");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_undo_after_the_file_changed_again_does_nothing() {
    test_reverts();
    let (dir, path) = two_hunks("hunk-undo-late");
    let unstaged = read_in(&dir, Scope::Unstaged).unwrap();
    let id = change_in(&dir, &request(&unstaged, "list.txt", 0, HunkAction::Revert))
        .unwrap()
        .revert
        .unwrap();
    std::fs::write(&path, "rewritten since\n").unwrap();
    assert!(undo_in(&dir, &id).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "rewritten since\n");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_action_is_asked_of_the_scope_it_belongs_to() {
    test_reverts();
    let (dir, _) = two_hunks("hunk-scope");
    let unstaged = read_in(&dir, Scope::Unstaged).unwrap();
    for (scope, action) in [
        (Scope::Staged, HunkAction::Revert),
        (Scope::Staged, HunkAction::Stage),
        (Scope::Unstaged, HunkAction::Unstage),
        (Scope::Branch, HunkAction::Revert),
        (Scope::Turn, HunkAction::Stage),
    ] {
        let mut asked = request(&unstaged, "list.txt", 0, action);
        asked.scope = scope;
        assert!(change_in(&dir, &asked).is_err(), "{scope:?} {action:?}");
    }
    assert_eq!(
        file(&read_in(&dir, Scope::Unstaged).unwrap(), "list.txt")
            .unwrap()
            .hunks
            .len(),
        2
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The file became a link after the revert: the undo writes nothing through it.
#[cfg(unix)]
#[test]
fn an_undo_never_writes_through_a_link() {
    test_reverts();
    let (dir, path) = two_hunks("hunk-undo-link");
    let unstaged = read_in(&dir, Scope::Unstaged).unwrap();
    let id = change_in(&dir, &request(&unstaged, "list.txt", 0, HunkAction::Revert))
        .unwrap()
        .revert
        .unwrap();
    let after = std::fs::read(&path).unwrap();
    let outside = std::env::temp_dir().join(format!("tmuxy-undo-target-{}", std::process::id()));
    std::fs::write(&outside, &after).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(undo_in(&dir, &id).is_err());
    assert_eq!(
        std::fs::read(&outside).unwrap(),
        after,
        "written through the link"
    );
    std::fs::remove_file(&outside).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
}
