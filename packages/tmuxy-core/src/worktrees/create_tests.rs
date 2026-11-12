#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::process::Command;

use super::super::guard::scratch_root;
use super::*;

/// A repository of the test's own in the temp dir, with one commit; none of
/// the developer's git config is read to make it.
fn repository(name: &str) -> (PathBuf, PathBuf) {
    let root = scratch_root().join(format!("tmuxy-create-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let repo = root.join("app");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
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
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q"]);
    std::fs::write(repo.join("README"), "hello\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "first"]);
    (root, repo)
}

#[test]
fn a_task_becomes_a_short_branch_name() {
    assert_eq!(slug("Fix the login redirect!"), "fix-the-login-redirect");
    assert_eq!(slug("  --Ünïcode & ASCII 42 "), "ünïcode-ascii-42");
    assert_eq!(slug("Corrigir a navegação"), "corrigir-a-navegação");
    assert_eq!(
        slug("a very long task description that keeps going well past the limit"),
        "a-very-long-task-description-that-keeps"
    );
    assert_eq!(slug("!!!"), "");
}

#[test]
fn a_worktree_is_made_beside_the_main_one_on_a_new_branch() {
    let (root, repo) = repository("made");
    let created = create(&repo.join("."), "agent/fix-login", None).unwrap();
    let path = root.join("app-fix-login");
    assert_eq!(created.path, path.display().to_string());
    assert_eq!(created.branch, "agent/fix-login");
    assert_eq!(created.repository, repo.display().to_string());
    assert!(path.join("README").is_file());
    // Made from inside the new one, the next goes beside the main one too.
    let again = create(&path, "agent/second", None).unwrap();
    assert_eq!(again.path, root.join("app-second").display().to_string());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_existing_directory_branch_or_a_bad_name_is_refused() {
    let (root, repo) = repository("refused");
    create(&repo, "fix", None).unwrap();
    let again = create(&repo, "fix", None).unwrap_err().to_string();
    assert!(again.contains("is already there"), "{again}");
    std::fs::remove_dir_all(root.join("app-fix")).unwrap();
    let branch = create(&repo, "fix", None).unwrap_err().to_string();
    assert!(branch.contains("worktree add"), "{branch}");
    let bad = create(&repo, "a..b", None).unwrap_err().to_string();
    assert!(bad.contains("not a branch name git takes"), "{bad}");
    let outside = root.join("plain");
    std::fs::create_dir_all(&outside).unwrap();
    assert!(matches!(
        create(&outside, "x", None).unwrap_err(),
        GuardError::NotAWorktree(_)
    ));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_checkout_runs_no_hook_or_filter_the_repository_names() {
    let (root, repo) = repository("quiet");
    let marker = root.join("ran");
    let script = root.join("tell.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho \"$0\" >> {}\ncat\n", marker.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let hooks = root.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    std::fs::copy(&script, hooks.join("post-checkout")).unwrap();
    std::fs::write(repo.join(".gitattributes"), "* filter=tell\n").unwrap();
    let git = |args: &[&str]| {
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .status()
            .unwrap()
            .success());
    };
    git(&["-c", "core.hooksPath=/dev/null", "add", ".gitattributes"]);
    git(&[
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "attributes",
    ]);
    let script = script.to_str().unwrap();
    git(&["config", "filter.tell.smudge", script]);
    git(&["config", "filter.tell.clean", script]);
    git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);

    create(&repo, "quiet", None).unwrap();
    assert!(root.join("app-quiet/README").is_file());
    assert!(
        !marker.exists(),
        "ran: {}",
        std::fs::read_to_string(&marker).unwrap_or_default()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A base that looks like an option is a commit to start from, and one that
/// is not a commit is refused, never read as a flag.
#[test]
fn a_base_is_never_read_as_an_option() {
    let (root, repo) = repository("base");
    let refused = create(&repo, "x", Some("--orphan"))
        .unwrap_err()
        .to_string();
    assert!(refused.contains("worktree add"), "{refused}");
    assert!(!root.join("app-x").join("README").exists());
    create(&repo, "y", Some("HEAD")).unwrap();
    assert!(root.join("app-y/README").is_file());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_copy_carries_the_uncommitted_changes_and_untracked_files_only_when_asked() {
    let (root, repo) = repository("carry");
    std::fs::write(repo.join("README"), "hello, edited\n").unwrap();
    std::fs::write(repo.join("notes.txt"), "draft\n").unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/new.rs"), "fn main() {}\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/passwd", repo.join("link")).unwrap();
    let base = head(&repo).unwrap();
    assert_eq!(base.len(), 40, "{base}");

    let plain = create(&repo, "fork-a", Some(&base)).unwrap();
    let plain_path = PathBuf::from(&plain.path);
    let carried = carry(&repo, &plain_path, false).unwrap();
    assert_eq!(carried.changed, ["README"]);
    assert!(carried.untracked.is_empty());
    assert_eq!(
        std::fs::read_to_string(plain_path.join("README")).unwrap(),
        "hello, edited\n"
    );
    assert!(!plain_path.join("notes.txt").exists());

    let full = create(&repo, "fork-b", Some(&base)).unwrap();
    let full_path = PathBuf::from(&full.path);
    let mut carried = carry(&repo, &full_path, true).unwrap();
    carried.untracked.sort();
    assert_eq!(carried.untracked, ["notes.txt", "src/new.rs"]);
    #[cfg(unix)]
    assert_eq!(carried.skipped, ["link"], "a symlink is left behind");
    assert_eq!(
        std::fs::read_to_string(full_path.join("src/new.rs")).unwrap(),
        "fn main() {}\n"
    );
    // The original keeps its changes.
    assert_eq!(
        std::fs::read_to_string(repo.join("README")).unwrap(),
        "hello, edited\n"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_deleted_file_is_deleted_and_a_tracked_symlink_is_left_behind() {
    let (root, repo) = repository("carry-odd");
    std::fs::write(repo.join("gone.txt"), "x\n").unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["add", "gone.txt"]);
    git(&["commit", "-qm", "second"]);
    std::fs::remove_file(repo.join("gone.txt")).unwrap();
    std::fs::remove_file(repo.join("README")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/passwd", repo.join("README")).unwrap();
    let fork = create(&repo, "fork-e", Some(&head(&repo).unwrap())).unwrap();
    let fork_path = PathBuf::from(&fork.path);
    let carried = carry(&repo, &fork_path, false).unwrap();
    assert_eq!(carried.changed, ["gone.txt"]);
    assert!(!fork_path.join("gone.txt").exists());
    #[cfg(unix)]
    {
        assert_eq!(carried.skipped, ["README"], "a symlink is not followed");
        assert_eq!(
            std::fs::read_to_string(fork_path.join("README")).unwrap(),
            "hello\n"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn nothing_to_carry_is_nothing() {
    let (root, repo) = repository("clean");
    let fork = create(&repo, "fork-d", None).unwrap();
    assert_eq!(
        carry(&repo, &PathBuf::from(&fork.path), true).unwrap(),
        Carried::default()
    );
    let _ = std::fs::remove_dir_all(&root);
}
