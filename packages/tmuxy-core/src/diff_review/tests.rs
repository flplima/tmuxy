use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;

/// git for setting a repository up, as the test's own: no global or system
/// config, a fixed author.
fn setup(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A repository of the test's own, on `main`, with one commit.
fn repository(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tmuxy-diff-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    setup(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(dir.join("sp ace.txt"), "x\n").unwrap();
    setup(&dir, &["add", "-A"]);
    setup(&dir, &["commit", "-qm", "init"]);
    dir
}

fn lines(file: &DiffFile) -> Vec<(LineKind, Option<u32>, Option<u32>, &str)> {
    file.hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .map(|line| (line.kind, line.old, line.new, line.text.as_str()))
        .collect()
}

#[test]
fn a_patch_is_read_into_files_hunks_and_numbered_lines() {
    let text = r#"diff --git a/a.txt b/a.txt
index 4cb29ea..6addb9b 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@ fn top
 one
-two
+TWO
 three
+four
\ No newline at end of file
diff --git a/b.bin b/b.bin
index 87ae6b6..22f6b3b 100644
Binary files a/b.bin and b/b.bin differ
diff --git a/sp ace.txt b/sp ace.txt
--- a/sp ace.txt<TAB>
+++ b/sp ace.txt<TAB>
@@ -1 +1 @@
--- not a header
+++ not one either
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/x.sh b/x.sh
old mode 100644
new mode 100755
diff --git a/old.txt b/moved.txt
similarity index 100%
rename from old.txt
rename to moved.txt
diff --git "a/tab\there.txt" "b/tab\there.txt"
--- "a/tab\there.txt"
+++ "b/tab\there.txt"
@@ -1 +1 @@
-\303\251
+<script>alert(1)</script>
"#
    .replace("<TAB>", "\t");
    let files = patch::parse(&text);
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "a.txt",
            "b.bin",
            "sp ace.txt",
            "new.txt",
            "gone.txt",
            "x.sh",
            "moved.txt",
            "tab\there.txt"
        ]
    );
    assert_eq!(files[0].hunks[0].header, "@@ -1,3 +1,4 @@ fn top");
    assert_eq!(
        lines(&files[0]),
        [
            (LineKind::Context, Some(1), Some(1), "one"),
            (LineKind::Removed, Some(2), None, "two"),
            (LineKind::Added, None, Some(2), "TWO"),
            (LineKind::Context, Some(3), Some(3), "three"),
            (LineKind::Added, None, Some(4), "four"),
            (LineKind::Note, None, None, "No newline at end of file"),
        ]
    );
    assert!(files[1].binary && files[1].hunks.is_empty());
    // A line inside a hunk is content, whatever it starts with.
    assert_eq!(
        lines(&files[2]),
        [
            (LineKind::Removed, Some(1), None, "-- not a header"),
            (LineKind::Added, None, Some(1), "++ not one either"),
        ]
    );
    assert_eq!(files[3].status, FileStatus::Added);
    assert_eq!(files[4].status, FileStatus::Deleted);
    assert_eq!(files[4].path, "gone.txt");
    assert_eq!(files[5].mode_change.as_deref(), Some("100644 → 100755"));
    assert_eq!(files[6].status, FileStatus::Renamed);
    assert_eq!(files[6].old_path.as_deref(), Some("old.txt"));
    // Text stays text: markup in a line is a string to draw.
    assert_eq!(lines(&files[7])[1].3, "<script>alert(1)</script>");
}

/// The three scopes on a real checkout.
#[test]
fn each_scope_reads_what_it_names() {
    let dir = repository("scopes");
    std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
    std::fs::write(dir.join("staged.txt"), "staged\n").unwrap();
    setup(&dir, &["add", "staged.txt"]);
    std::fs::write(dir.join("loose.txt"), "untracked\n").unwrap();

    let unstaged = read_in(&dir, Scope::Unstaged).unwrap();
    assert_eq!(unstaged.name, dir.file_name().unwrap().to_string_lossy());
    assert_eq!(unstaged.branch.as_deref(), Some("main"));
    assert_eq!(
        unstaged
            .files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["a.txt"]
    );
    assert_eq!(unstaged.untracked, ["loose.txt"]);
    assert!(!unstaged.truncated);

    let staged = read_in(&dir, Scope::Staged).unwrap();
    assert_eq!(
        staged
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status))
            .collect::<Vec<_>>(),
        [("staged.txt", FileStatus::Added)]
    );
    assert!(staged.untracked.is_empty());

    // A branch: one commit of its own, and the uncommitted work on top.
    setup(&dir, &["checkout", "-q", "-b", "feature"]);
    setup(&dir, &["commit", "-qm", "staged on the branch"]);
    let branch = read_in(&dir, Scope::Branch).unwrap();
    assert_eq!(branch.base.as_deref(), Some("main"));
    assert_eq!(branch.branch.as_deref(), Some("feature"));
    let mut paths: Vec<&str> = branch.files.iter().map(|f| f.path.as_str()).collect();
    paths.sort_unstable();
    assert_eq!(paths, ["a.txt", "staged.txt"]);

    // Asked from a folder inside the checkout, the checkout is the same.
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    assert_eq!(
        read_in(&dir.join("sub"), Scope::Unstaged).unwrap().name,
        unstaged.name
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_checkout_with_no_commit_yet_and_a_folder_outside_any_read_as_they_are() {
    let dir = std::env::temp_dir().join(format!("tmuxy-diff-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    setup(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("first.txt"), "first\n").unwrap();
    setup(&dir, &["add", "first.txt"]);
    let staged = read_in(&dir, Scope::Staged).unwrap();
    assert_eq!(staged.files[0].path, "first.txt");
    assert!(read_in(&dir, Scope::Branch).is_err());
    std::fs::remove_dir_all(&dir).unwrap();

    let outside = std::env::temp_dir().join(format!("tmuxy-diff-outside-{}", std::process::id()));
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join(".git"), "gitdir: /nowhere\n").unwrap();
    assert!(read_in(&outside, Scope::Unstaged).is_err());
    std::fs::remove_dir_all(&outside).unwrap();
}

/// A checkout's config can name programs for git to run on a diff. None
/// runs: each would leave a file behind if it did.
#[test]
fn a_read_runs_nothing_the_repository_names() {
    let dir = repository("traps");
    let ran = dir.join("ran");
    let trap = format!("touch {}", ran.display());
    let hooks = dir.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for hook in [
        "post-index-change",
        "fsmonitor-watchman",
        "reference-transaction",
    ] {
        let script = hooks.join(hook);
        std::fs::write(&script, format!("#!/bin/sh\n{trap}\n")).unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
    }
    std::fs::write(dir.join(".gitattributes"), "*.txt diff=trap filter=trap\n").unwrap();
    std::fs::write(dir.join("a.txt"), "one\nchanged\nthree\n").unwrap();
    setup(&dir, &["add", ".gitattributes"]);
    setup(&dir, &["commit", "-qm", "attributes"]);
    std::fs::write(dir.join("a.txt"), "one\nstaged\nthree\n").unwrap();
    setup(&dir, &["add", "a.txt"]);
    std::fs::write(dir.join("a.txt"), "one\nchanged\nthree\n").unwrap();
    // The traps go in last: the test's own setup above must not run them.
    for (key, value) in [
        ("core.fsmonitor", trap.as_str()),
        ("core.hooksPath", &hooks.display().to_string()),
        ("core.pager", trap.as_str()),
        ("diff.external", trap.as_str()),
        ("diff.trap.command", trap.as_str()),
        ("diff.trap.textconv", trap.as_str()),
        ("filter.trap.clean", trap.as_str()),
        ("filter.trap.smudge", trap.as_str()),
        ("filter.trap.process", trap.as_str()),
        ("filter.trap.required", "true"),
    ] {
        setup(&dir, &["config", key, value]);
    }
    let _ = std::fs::remove_file(&ran);

    for scope in [Scope::Unstaged, Scope::Staged, Scope::Branch] {
        let read = read_in(&dir, scope).unwrap();
        assert!(
            !ran.exists(),
            "{scope:?} ran a program the repository names"
        );
        if scope == Scope::Unstaged {
            // Compared as the text it is, not as the filter would have it.
            assert!(lines(&read.files[0]).contains(&(LineKind::Added, None, Some(2), "changed")));
        }
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_pane_may_read_only_the_checkout_its_options_name() {
    assert_eq!(
        parse_authorisation("diff\n/src/app\n").unwrap(),
        PathBuf::from("/src/app")
    );
    for answer in ["preview\n/src/app\n", "diff\n\n", "diff\nsrc/app\n", ""] {
        assert!(parse_authorisation(answer).is_err(), "{answer:?}");
    }
}
