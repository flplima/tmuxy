#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;

/// A repository of the test's own in the temp dir, with a bare "origin" it
/// has pushed `main` to and one linked worktree on branch `feature`, also
/// pushed. Nothing here reads the developer's git config.
struct Scene {
    root: PathBuf,
    main: PathBuf,
    linked: PathBuf,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

impl Scene {
    fn new(name: &str) -> Scene {
        let root = scratch_root().join(format!("tmuxy-guard-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(root.starts_with(scratch_root()));
        let origin = root.join("origin.git");
        let main = root.join("repo");
        let linked = root.join("repo-feature");
        git(&root, &["init", "--bare", origin.to_str().unwrap()]);
        git(&root, &["init", main.to_str().unwrap()]);
        std::fs::write(main.join("README"), "hello\n").unwrap();
        std::fs::write(main.join(".gitignore"), "build/\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-m", "first"]);
        git(
            &main,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git(&main, &["push", "-q", "origin", "main"]);
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                linked.to_str().unwrap(),
            ],
        );
        git(&linked, &["push", "-q", "origin", "feature"]);
        Scene { root, main, linked }
    }

    fn branch_exists(&self, branch: &str) -> bool {
        !git(&self.main, &["branch", "--list", branch]).is_empty()
    }
}

impl Drop for Scene {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn a_clean_pushed_worktree_is_removed_and_its_branch_kept() {
    let scene = Scene::new("clean");
    // Ignored files are not work: they go with the worktree.
    std::fs::create_dir_all(scene.linked.join("build")).unwrap();
    std::fs::write(scene.linked.join("build/out.o"), "x").unwrap();

    let removed = remove(&scene.linked.join("build"), false).unwrap();
    assert_eq!(removed.branch.as_deref(), Some("feature"));
    assert!(removed.lost.is_empty());
    assert!(!scene.linked.exists());
    assert!(
        scene.branch_exists("feature"),
        "the branch is never deleted"
    );
    assert!(scene.main.join("README").is_file());
}

#[test]
fn uncommitted_untracked_or_unpushed_work_is_refused_and_left_in_place() {
    let scene = Scene::new("refused");
    std::fs::write(scene.linked.join("README"), "changed\n").unwrap();
    let refused = remove(&scene.linked, false).unwrap_err();
    assert_eq!(
        refused.to_string(),
        format!(
            "not removed: {} has uncommitted changes. --force removes it anyway; its branch stays",
            scene.linked.display()
        )
    );
    assert!(scene.linked.join("README").is_file());

    git(&scene.linked, &["commit", "-qam", "work"]);
    std::fs::write(scene.linked.join("notes.txt"), "draft").unwrap();
    assert_eq!(
        unsaved(&scene.linked).unwrap(),
        Unsaved {
            changed: false,
            untracked: true,
            unpushed: 1
        }
    );
    let said = remove(&scene.linked, false).unwrap_err().to_string();
    assert!(
        said.contains("untracked files, 1 commit on no remote"),
        "{said}"
    );

    std::fs::remove_file(scene.linked.join("notes.txt")).unwrap();
    git(
        &scene.linked,
        &["commit", "-q", "--allow-empty", "-m", "more"],
    );
    let said = remove(&scene.linked, false).unwrap_err().to_string();
    assert!(said.contains("2 commits on no remote"), "{said}");

    git(&scene.linked, &["push", "-q", "origin", "feature"]);
    assert!(unsaved(&scene.linked).unwrap().is_empty());
}

#[test]
fn a_forced_removal_says_what_it_lost_and_still_keeps_the_branch() {
    let scene = Scene::new("forced");
    git(
        &scene.linked,
        &["commit", "-q", "--allow-empty", "-m", "local"],
    );
    std::fs::write(scene.linked.join("README"), "changed\n").unwrap();
    std::fs::write(scene.linked.join("notes.txt"), "draft").unwrap();

    let removed = remove(&scene.linked, true).unwrap();
    assert_eq!(
        removed.lost,
        Unsaved {
            changed: true,
            untracked: true,
            unpushed: 1
        }
    );
    assert!(!scene.linked.exists());
    assert!(scene.branch_exists("feature"));
    assert_eq!(
        git(&scene.main, &["log", "-1", "--format=%s", "feature"]),
        "local",
        "the commit on no remote is still on its branch"
    );
}

#[test]
fn the_main_worktree_a_locked_one_and_a_plain_directory_are_not_removed() {
    let scene = Scene::new("never");
    assert_eq!(
        remove(&scene.main, true).unwrap_err(),
        GuardError::MainWorktree(scene.main.display().to_string())
    );
    git(
        &scene.main,
        &["worktree", "lock", scene.linked.to_str().unwrap()],
    );
    assert_eq!(
        remove(&scene.linked, true).unwrap_err(),
        GuardError::Locked(scene.linked.display().to_string())
    );
    assert!(scene.linked.is_dir());
    let plain = scene.root.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert!(matches!(
        remove(&plain, true).unwrap_err(),
        GuardError::NotAWorktree(_)
    ));
}

/// The repository's own config names programs: a filesystem monitor, an
/// external diff, a clean filter, hooks. Reading and removing runs none.
#[test]
fn nothing_the_repository_names_is_run() {
    let scene = Scene::new("quiet");
    let marker = scene.root.join("ran");
    let script = scene.root.join("tell.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho \"$0 $*\" >> {}\ncat\n", marker.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let hooks = scene.root.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for hook in [
        "post-checkout",
        "reference-transaction",
        "pre-auto-gc",
        "post-index-change",
    ] {
        std::fs::copy(&script, hooks.join(hook)).unwrap();
    }
    let script = script.to_str().unwrap();
    for (key, value) in [
        ("core.fsmonitor", script),
        ("diff.external", script),
        ("filter.tell.clean", script),
        ("filter.tell.smudge", script),
        ("core.pager", script),
        ("core.hooksPath", hooks.to_str().unwrap()),
    ] {
        git(&scene.main, &["config", key, value]);
    }
    std::fs::write(scene.linked.join(".gitattributes"), "* filter=tell\n").unwrap();
    // The repository's own attributes file, which no attribute source
    // setting covers, names the filter too.
    let info = scene.main.join(".git/info");
    std::fs::create_dir_all(&info).unwrap();
    std::fs::write(info.join("attributes"), "* filter=tell\n").unwrap();
    // Same text, newer time: git has to look inside the file to compare it.
    std::fs::write(scene.linked.join("README"), "hello\n").unwrap();

    let found = unsaved(&scene.linked).unwrap();
    assert!(
        found.untracked,
        "the .gitattributes it was handed is untracked"
    );
    remove(&scene.linked, true).unwrap();
    assert!(
        !marker.exists(),
        "ran: {}",
        std::fs::read_to_string(&marker).unwrap_or_default()
    );
}

#[test]
fn what_is_unsaved_is_said_in_words() {
    let all = Unsaved {
        changed: true,
        untracked: true,
        unpushed: 3,
    };
    assert_eq!(
        all.said(),
        "uncommitted changes, untracked files, 3 commits on no remote"
    );
    assert_eq!(Unsaved::default().said(), "");
}

#[test]
fn every_filter_driver_is_switched_off_by_name() {
    assert_eq!(
        filters_off(&["tell".to_string()]),
        [
            ("filter.tell.clean".to_string(), String::new()),
            ("filter.tell.smudge".to_string(), String::new()),
            ("filter.tell.process".to_string(), String::new()),
            ("filter.tell.required".to_string(), "false".to_string()),
        ]
    );
    assert!(filters_off(&[]).is_empty());
}
