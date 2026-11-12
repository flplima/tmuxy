use super::*;
use std::path::PathBuf;

/// A pass deadline no test reaches.
fn later() -> Instant {
    Instant::now() + Duration::from_secs(60)
}

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
        of(&dir, later()),
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
    assert_eq!(of(&dir, later()), edited);
    // From a directory inside the checkout, the same.
    std::fs::create_dir(dir.join("sub")).unwrap();
    assert_eq!(of(&dir.join("sub"), later()), edited);

    git(&dir, &["add", "notes.txt"]);
    assert_eq!(
        of(&dir, later()),
        edited,
        "a staged change is still a change"
    );

    std::fs::write(dir.join("untracked.txt"), "a\nb\n").unwrap();
    assert_eq!(
        of(&dir, later()),
        edited,
        "an untracked file is not counted"
    );

    commit(&dir, "second");
    assert_eq!(
        of(&dir, later()),
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
    assert_eq!(of(&dir, later()), None);
    // Not a repository at all.
    assert_eq!(of(&dir.join(".git").join("objects"), later()), None);
    // And a diff that does not finish in time is stopped, not waited for.
    let slow = repository("slow");
    assert_eq!(of(&slow, Instant::now()), None);
    for dir in [dir, slow] {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Counting lines is a read. It must not take the index lock (the user's
/// own `git commit` in that moment would fail on it), and it must not run
/// any program the repository's own config or attributes name: a directory
/// that arrived with its own `.git` would otherwise run code because a pane
/// sits in it. Every such knob points at one script that leaves a mark.
#[test]
fn counting_writes_nothing_and_runs_nothing_the_repository_names() {
    let dir = repository("booby-trapped");
    // A second tracked file, for a driver whose name holds `=`: on
    // `-c filter.x=y.clean=` git would read the key as `filter.x`.
    std::fs::write(dir.join("other.dat"), "a\n").unwrap();
    commit(&dir, "second file");
    let marker = dir.join("RAN");
    let trap = dir.join("trap.sh");
    std::fs::write(
        &trap,
        format!("#!/bin/sh\necho \"$0 $*\" >> '{}'\ncat\n", marker.display()),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&trap, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let trap = trap.display().to_string();
    let hooks = dir.join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    for hook in [
        "post-index-change",
        "reference-transaction",
        "post-checkout",
    ] {
        std::os::unix::fs::symlink(&trap, hooks.join(hook)).unwrap();
        std::os::unix::fs::symlink(&trap, dir.join(".git/hooks").join(hook)).unwrap();
    }
    for (key, value) in [
        ("core.fsmonitor", trap.as_str()),
        ("core.hooksPath", &hooks.display().to_string()),
        ("core.pager", trap.as_str()),
        ("core.sshCommand", trap.as_str()),
        ("core.askPass", trap.as_str()),
        ("credential.helper", trap.as_str()),
        ("diff.external", trap.as_str()),
        ("diff.trap.command", trap.as_str()),
        ("diff.trap.textconv", trap.as_str()),
        ("filter.trap.clean", trap.as_str()),
        ("filter.trap.smudge", trap.as_str()),
        ("filter.trap.process", trap.as_str()),
        ("filter.trap.required", "true"),
        ("filter.x=y.clean", trap.as_str()),
        ("filter.x=y.smudge", trap.as_str()),
        ("filter.x=y.process", trap.as_str()),
        ("filter.x=y.required", "true"),
        ("pager.diff-index", trap.as_str()),
        ("pager.config", trap.as_str()),
        ("remote.origin.url", "ext::sh -c touch% /tmp/never"),
        ("remote.origin.promisor", "true"),
        ("extensions.partialClone", "origin"),
    ] {
        git(&dir, &["config", key, value]);
    }
    std::fs::write(
        dir.join(".gitattributes"),
        "* filter=trap diff=trap\nother.dat filter=x=y\n",
    )
    .unwrap();

    // The same content written again, a second later: the file's stat no
    // longer matches the index, which is when a plain `git diff` refreshes
    // the index and writes it back. Then a real edit, which a clean filter
    // would be run on.
    std::thread::sleep(Duration::from_millis(1100));
    std::fs::write(dir.join("notes.txt"), "one\ntwo\nthree\n").unwrap();
    let index = dir.join(".git").join("index");
    let before = std::fs::read(&index).unwrap();
    assert_eq!(
        of(&dir, later()),
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
    std::fs::write(dir.join("other.dat"), "a\nb\n").unwrap();
    assert_eq!(
        of(&dir, later()),
        Some(GitChanges {
            added: 2,
            removed: 0
        })
    );
    // The branch and layout discovery the row already ran, through the same
    // helper: as quiet.
    let repositories = super::super::list_git_worktrees(vec![dir.display().to_string()]).unwrap();
    assert_eq!(repositories[0].worktrees[0].branch.as_deref(), Some("main"));
    let ran = std::fs::read_to_string(&marker).unwrap_or_default();
    assert!(ran.is_empty(), "a program the repository names ran: {ran}");
    let _ = std::fs::remove_dir_all(&dir);
}
