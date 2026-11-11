use super::*;
use std::path::PathBuf;

/// Run git in `dir` with nobody's config but the repository's own.
fn git(dir: &Path, args: &[&str]) {
    let output = super::super::git(dir, args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

const AS_SOMEONE: &[&str] = &["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

fn commit(dir: &Path, message: &str) {
    git(dir, &["add", "-A"]);
    let mut args = AS_SOMEONE.to_vec();
    args.extend(["commit", "-q", "-m", message]);
    git(dir, &args);
}

/// A repository with one commit: `notes.txt`, three lines.
pub(in crate::worktrees) fn repository(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tmuxy-changes-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("notes.txt"), "one\ntwo\nthree\n").unwrap();
    commit(&dir, "first");
    std::fs::canonicalize(&dir).unwrap()
}

#[test]
fn the_summary_line_is_read_whichever_counts_it_holds() {
    for (stat, added, removed) in [
        ("", 0, 0),
        (
            " 3 files changed, 12 insertions(+), 3 deletions(-)\n",
            12,
            3,
        ),
        (" 1 file changed, 1 insertion(+)\n", 1, 0),
        (" 1 file changed, 1 deletion(-)\n", 0, 1),
        (" 2 files changed, 40 deletions(-)\n", 0, 40),
        // A rename or a mode change alone: files, and no lines.
        (" 1 file changed, 0 insertions(+), 0 deletions(-)\n", 0, 0),
        ("not a summary at all", 0, 0),
    ] {
        assert_eq!(
            parse_shortstat(stat),
            GitChanges { added, removed },
            "{stat:?}"
        );
    }
}

/// Against `HEAD`, staged or not, and never a file git does not track.
#[test]
fn a_checkout_reports_its_lines_changed_against_head() {
    let dir = repository("counts");
    assert_eq!(
        of(&dir),
        Some(GitChanges {
            added: 0,
            removed: 0
        })
    );

    std::fs::write(dir.join("notes.txt"), "one\nTWO\nthree\nfour\nfive\n").unwrap();
    let edited = Some(GitChanges {
        added: 3,
        removed: 1,
    });
    assert_eq!(of(&dir), edited);
    // From a directory inside the checkout, the same.
    std::fs::create_dir(dir.join("sub")).unwrap();
    assert_eq!(of(&dir.join("sub")), edited);

    git(&dir, &["add", "notes.txt"]);
    assert_eq!(of(&dir), edited, "a staged change is still a change");

    std::fs::write(dir.join("untracked.txt"), "a\nb\n").unwrap();
    assert_eq!(of(&dir), edited, "an untracked file is not counted");

    commit(&dir, "second");
    assert_eq!(
        of(&dir),
        Some(GitChanges {
            added: 0,
            removed: 0
        })
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn where_git_cannot_say_there_are_no_numbers() {
    // No commit yet: there is no HEAD to compare with.
    let dir = std::env::temp_dir().join(format!("tmuxy-changes-{}-unborn", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    assert_eq!(of(&dir), None);
    // Not a repository at all.
    assert_eq!(of(&dir.join(".git").join("objects")), None);
    // And a diff that does not finish in time is stopped, not waited for.
    let slow = repository("slow");
    assert_eq!(of_within(&slow, Duration::ZERO), None);
    for dir in [dir, slow] {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Counting lines is a read. It must not take the index lock (the user's
/// own `git commit` in that moment would fail on it) and must not run a
/// program the repository's config names.
#[test]
fn counting_writes_nothing_and_runs_nothing_of_the_repositorys() {
    let dir = repository("readonly");
    let marker = dir.join("hook-ran");
    let hook = dir.join("monitor.sh");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &dir,
        &["config", "core.fsmonitor", &hook.display().to_string()],
    );
    git(
        &dir,
        &["config", "diff.external", &hook.display().to_string()],
    );

    // The same content written again, a second later: the file's stat no
    // longer matches the index, which is when a plain `git diff` refreshes
    // the index and writes it back.
    std::thread::sleep(Duration::from_millis(1100));
    std::fs::write(dir.join("notes.txt"), "one\ntwo\nthree\n").unwrap();
    let index = dir.join(".git").join("index");
    let before = std::fs::read(&index).unwrap();

    assert_eq!(
        of(&dir),
        Some(GitChanges {
            added: 0,
            removed: 0
        })
    );
    assert_eq!(
        std::fs::read(&index).unwrap(),
        before,
        "the index was rewritten"
    );
    assert!(!dir.join(".git").join("index.lock").exists());

    std::fs::write(dir.join("notes.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    assert_eq!(
        of(&dir),
        Some(GitChanges {
            added: 1,
            removed: 0
        })
    );
    assert!(
        !marker.exists(),
        "a program from the repository's config ran"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
