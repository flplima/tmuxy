use super::*;
use std::path::PathBuf;

/// git for setting a test repository up: nobody's config but its own.
fn setup(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn later() -> Instant {
    Instant::now() + Duration::from_secs(30)
}

/// What `args` print, run the safe way with the user's own config `global`.
fn said(dir: &Path, global: &Path, args: &[&str]) -> Said {
    said_with(dir, global, &filters_off(dir, later()).unwrap(), args)
}

fn said_with(dir: &Path, global: &Path, extra: &[(String, String)], args: &[&str]) -> Said {
    let mut git = command(dir, extra, args);
    git.env("GIT_CONFIG_GLOBAL", global)
        .env("GIT_CONFIG_SYSTEM", "/dev/null");
    run(git, later(), 1024 * 1024).unwrap_or_else(|| panic!("git {args:?} did not finish"))
}

#[test]
fn a_version_is_read_from_what_git_prints() {
    assert_eq!(version("git version 2.56.0\n"), Some((2, 56)));
    assert_eq!(version("git version 2.39.5 (Apple Git-154)"), Some((2, 39)));
    assert_eq!(version("git version 2.31.0.windows.1"), Some((2, 31)));
    assert_eq!(version("git version 2.30"), Some((2, 30)));
    assert_eq!(version("hub version 2.14"), None);
    assert_eq!(version(""), None);
    assert!(
        available(),
        "the machine running the tests has git 2.31 or later"
    );
}

/// Settings go whole in the environment, a key holding `=` included; what an
/// outer git passed down, and the caller's own pager and ssh, are dropped.
#[test]
fn settings_reach_git_whole_through_the_environment() {
    let git = command(
        Path::new("/x"),
        &[("filter.x=y.clean".into(), String::new())],
        &["status"],
    );
    let env: std::collections::HashMap<String, Option<String>> = git
        .get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    let n = SETTINGS.len();
    // The caller's setting, then the attribute source, after the fixed ones.
    assert_eq!(env["GIT_CONFIG_COUNT"], Some((n + 2).to_string()));
    assert_eq!(
        env[&format!("GIT_CONFIG_KEY_{}", n + 1)],
        Some("attr.tree".into())
    );
    assert_eq!(
        env[&format!("GIT_CONFIG_KEY_{n}")],
        Some("filter.x=y.clean".into())
    );
    assert_eq!(env[&format!("GIT_CONFIG_VALUE_{n}")], Some(String::new()));
    for name in [
        "GIT_CONFIG_PARAMETERS",
        "GIT_PAGER",
        "PAGER",
        "GIT_SSH_COMMAND",
        "GIT_DIR",
    ] {
        assert_eq!(env[name], None, "{name}");
    }
    // Outside any repository: SHA-1's empty tree.
    assert_eq!(env["GIT_ATTR_SOURCE"], Some(EMPTY_TREE_SHA1.into()));
    assert!(!git.get_args().any(|arg| arg == "-c"));
}

/// A repository whose config, attributes and hooks, and the user's own
/// config besides, point every program git can be told to run at one script
/// that leaves a mark. The commands tmuxy runs leave none, and write
/// nothing.
#[test]
fn nothing_a_repository_or_its_config_names_runs() {
    trap_repository("sha1");
}

/// The same in a SHA-256 repository, whose empty tree is another: named
/// with SHA-1's, every command that reads attributes would fail there.
#[test]
fn nothing_runs_in_a_sha256_repository_either() {
    trap_repository("sha256");
}

fn trap_repository(format: &str) {
    let dir: PathBuf =
        std::env::temp_dir().join(format!("tmuxy-safe-git-{format}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    setup(
        &dir,
        &[
            "init",
            "-q",
            "-b",
            "main",
            &format!("--object-format={format}"),
        ],
    );
    for (file, text) in [
        ("notes.txt", "one\n"),
        ("lfs.bin", "a\n"),
        ("eq.dat", "a\n"),
        ("info.txt", "a\n"),
    ] {
        std::fs::write(dir.join(file), text).unwrap();
    }
    setup(&dir, &["add", "-A"]);
    setup(&dir, &["commit", "-q", "-m", "first"]);
    let dir = std::fs::canonicalize(&dir).unwrap();

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
        "fsmonitor-watchman",
    ] {
        std::os::unix::fs::symlink(&trap, hooks.join(hook)).unwrap();
        std::os::unix::fs::symlink(&trap, dir.join(".git/hooks").join(hook)).unwrap();
    }
    let knobs: Vec<(&str, String)> = vec![
        ("core.fsmonitor", trap.clone()),
        ("core.hooksPath", hooks.display().to_string()),
        ("core.pager", trap.clone()),
        ("core.sshCommand", trap.clone()),
        ("core.askPass", trap.clone()),
        ("core.editor", trap.clone()),
        ("credential.helper", trap.clone()),
        ("diff.external", trap.clone()),
        ("diff.trap.command", trap.clone()),
        ("diff.trap.textconv", trap.clone()),
        ("filter.trap.clean", trap.clone()),
        ("filter.trap.smudge", trap.clone()),
        ("filter.trap.process", trap.clone()),
        ("filter.trap.required", "true".into()),
        ("filter.x=y.clean", trap.clone()),
        ("filter.x=y.process", trap.clone()),
        ("filter.x=y.required", "true".into()),
        ("pager.diff-index", trap.clone()),
        ("pager.log", trap.clone()),
        ("pager.status", trap.clone()),
        ("remote.origin.url", "ext::sh -c touch% /tmp/never".into()),
        ("remote.origin.promisor", "true".into()),
        ("extensions.partialClone", "origin".into()),
    ];
    for (key, value) in &knobs {
        setup(&dir, &["config", key, value]);
    }
    // The user's own config, and every attribute file there is.
    let global = dir.join("global.gitconfig");
    std::fs::write(
        &global,
        format!(
            "[core]\n\tfsmonitor = {trap}\n\tpager = {trap}\n\tattributesFile = {}\n[diff]\n\texternal = {trap}\n[filter \"user\"]\n\tclean = {trap}\n\tprocess = {trap}\n",
            dir.join("user.attributes").display()
        ),
    )
    .unwrap();
    std::fs::write(dir.join("user.attributes"), "notes.txt filter=user\n").unwrap();
    std::fs::write(
        dir.join(".gitattributes"),
        "* filter=trap diff=trap\neq.dat filter=x=y\n",
    )
    .unwrap();

    // A stat-only change, when a status or a plain `git diff` writes the
    // index back: a read must not.
    std::thread::sleep(Duration::from_millis(1100));
    std::fs::write(dir.join("notes.txt"), "one\n").unwrap();
    let index = dir.join(".git/index");
    let before = std::fs::read(&index).unwrap();
    let quiet = said(&dir, &global, &["diff-index", "--shortstat", "HEAD"]);
    assert!(quiet.success);
    assert!(quiet.stdout.is_empty(), "a stat-only change is no change");
    assert!(said(&dir, &global, &["status", "--porcelain=v2", "-z"]).success);
    assert_eq!(
        std::fs::read(&index).unwrap(),
        before,
        "the index was rewritten"
    );
    for file in ["notes.txt", "lfs.bin", "eq.dat", "info.txt"] {
        std::fs::write(dir.join(file), "changed\nlines\n").unwrap();
    }

    // The attributes on their own: with no filter switched off, the work
    // tree's `.gitattributes` and the user's attributes file name nothing
    // that runs, as neither is read.
    let alone = said_with(&dir, &global, &[], &["diff-index", "--shortstat", "HEAD"]);
    assert!(alone.success);
    let ran = std::fs::read_to_string(&marker).unwrap_or_default();
    assert!(
        ran.is_empty(),
        "an attribute file named a program that ran:\n{ran}"
    );

    // `info/attributes` is read whatever the source: there it is the
    // filters switched off that hold.
    std::fs::write(
        dir.join(".git/info/attributes"),
        "info.txt filter=trap diff=trap\n",
    )
    .unwrap();

    let diff = [
        "diff-index",
        "-p",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "HEAD",
    ];
    let stat = ["diff-index", "--shortstat", "HEAD"];
    for args in [
        &["rev-parse", "--git-common-dir"][..],
        &["worktree", "list", "--porcelain", "-z"],
        &["status", "--porcelain=v2", "-z", "--ignore-submodules=all"],
        &["log", "-1", "--format=%H"],
        &stat,
        &diff,
        // Asked for one without the flags: the settings alone hold it.
        &["diff-index", "-p", "HEAD"],
    ] {
        let out = said(&dir, &global, args);
        assert!(out.success, "git {args:?} failed");
    }
    let expected_tree = if format == "sha256" {
        EMPTY_TREE_SHA256
    } else {
        EMPTY_TREE_SHA1
    };
    assert_eq!(empty_tree(&dir), expected_tree);
    let shortstat = String::from_utf8(said(&dir, &global, &stat).stdout).unwrap();
    assert!(shortstat.contains("4 files changed"), "{shortstat}");
    assert!(!dir.join(".git/index.lock").exists());
    let ran = std::fs::read_to_string(&marker).unwrap_or_default();
    assert!(
        ran.is_empty(),
        "a program the repository or its config names ran:\n{ran}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A call past its deadline is ended; output past its cap is cut there.
#[test]
fn a_deadline_ends_git_and_a_cap_cuts_what_is_read() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(run(command(here, &[], &["version"]), Instant::now(), 1024).is_none());
    let said = run(command(here, &[], &["help", "-a"]), later(), 100).unwrap();
    assert!(said.cut);
    assert_eq!(said.stdout.len(), 100);
}
