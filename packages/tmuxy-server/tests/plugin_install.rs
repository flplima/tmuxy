//! `tmuxy plugin install` end to end, against local git repositories: the
//! real binary, the real git, a scratch home.
//!
//! What these hold is the install's one promise — nothing a plugin ships,
//! and nothing the user's or the system's git config adds, runs before the
//! user said yes — plus the lockfile reproducing an install on a fresh
//! machine. The surface an action opens needs a tmux server and is the E2E
//! suite's (`tests/17-plugins.test.js`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod plugin_common;

use std::path::PathBuf;

use plugin_common::{git, stderr, Scratch};

const MANIFEST: &str = r#"[plugin]
api = 1
name = "hostile"
version = "0.1.0"

[[actions]]
id = "hello"
title = "Hello"
menu = "pane"
surface = "popup"
command = ["bin/hello"]

[[cli]]
verb = "hostile"
command = ["bin/hello"]
"#;

/// A repository `owner/name` under `remote/` with every trap a checkout can
/// spring: an LFS filter on every file, a symlink out of the tree, and a
/// submodule. Returns its head commit.
fn hostile_repo(s: &Scratch, owner: &str, name: &str, manifest: &str) -> String {
    let repo = s.path(&format!("remote/{owner}/{name}.git"));
    std::fs::create_dir_all(repo.join("bin")).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "uploadpack.allowAnySHA1InWant", "true"]);
    std::fs::write(repo.join("tmuxy-plugin.toml"), manifest).unwrap();
    std::fs::write(repo.join("bin/hello"), "#!/bin/sh\necho hello\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            repo.join("bin/hello"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::os::unix::fs::symlink("/etc/passwd", repo.join("escape")).unwrap();
    }
    std::fs::write(
        repo.join(".gitattributes"),
        "* filter=lfs diff=lfs merge=lfs\n",
    )
    .unwrap();
    std::fs::write(
        repo.join(".gitmodules"),
        "[submodule \"sub\"]\n\tpath = sub\n\turl = https://example.invalid/sub.git\n",
    )
    .unwrap();
    git(&repo, &["add", "-A"]);
    git(
        &repo,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000,0123456789abcdef0123456789abcdef01234567,sub",
        ],
    );
    git(&repo, &["commit", "-q", "-m", "plugin"]);
    git(&repo, &["rev-parse", "HEAD"])
}

/// A `~/.gitconfig` that, if any of it were read, would leave a marker: a
/// hooks dir, an fsmonitor, an LFS smudge filter, and an `insteadOf` that
/// sends the fetch somewhere else entirely.
fn hostile_home(s: &Scratch) -> PathBuf {
    let home = s.path("home");
    let hooks = s.path("evil-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    std::fs::create_dir_all(home.join(".config/tmuxy")).unwrap();
    let marker = s.path("PWNED");
    let script = format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display());
    for hook in ["post-checkout", "post-merge", "reference-transaction"] {
        std::fs::write(hooks.join(hook), &script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(hooks.join(hook), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
    }
    let config = format!(
        "[core]\n\thooksPath = {hooks}\n\tfsmonitor = {hooks}/post-checkout\n\
         [filter \"lfs\"]\n\tsmudge = {hooks}/post-checkout\n\tprocess = {hooks}/post-checkout\n\trequired = true\n\
         [url \"file:///nonexistent/\"]\n\tinsteadOf = file://{remote}/\n",
        hooks = hooks.display(),
        remote = s.path("remote").display(),
    );
    std::fs::write(home.join(".gitconfig"), &config).unwrap();
    std::fs::create_dir_all(home.join(".config/git")).unwrap();
    std::fs::write(home.join(".config/git/config"), &config).unwrap();
    marker
}

#[test]
fn a_hostile_repo_and_gitconfig_run_nothing_and_check_out_no_symlink() {
    let s = Scratch::new("hostile");
    let sha = hostile_repo(&s, "someone", "tmuxy-hostile", MANIFEST);
    let marker = hostile_home(&s);

    // No terminal and no --yes: fails closed, installs nothing.
    let refused = s.tmuxy(&["install", "someone/tmuxy-hostile"]);
    assert_eq!(refused.status.code(), Some(1), "{}", stderr(&refused));
    assert!(
        stderr(&refused).contains(&format!("--yes --sha {sha}")),
        "{}",
        stderr(&refused)
    );
    // ...after showing what it would have asked about: the review a later
    // --yes stands for.
    assert!(
        stderr(&refused).contains("Install plugin hostile")
            && stderr(&refused).contains(&format!("commit  {sha}")),
        "{}",
        stderr(&refused)
    );
    assert!(!s.path("home/.config/tmuxy/plugins.json").exists());

    // --yes names the commit reviewed.
    let installed = s.tmuxy(&["install", "someone/tmuxy-hostile", "--yes", "--sha", &sha]);
    assert!(installed.status.success(), "{}", stderr(&installed));
    assert!(
        stderr(&installed).contains("run unsandboxed"),
        "the gate is shown even with --yes"
    );

    assert!(!marker.exists(), "a hook, filter or fsmonitor ran");
    let checkout = s.path(&format!("state/plugins/hostile@{sha}"));
    let escape = std::fs::symlink_metadata(checkout.join("escape")).unwrap();
    assert!(escape.is_file(), "a symlink was checked out as a symlink");
    assert_eq!(
        std::fs::read_to_string(checkout.join("escape")).unwrap(),
        "/etc/passwd"
    );
    assert!(!checkout.join(".git").exists());
    assert_eq!(
        std::fs::read_dir(checkout.join("sub"))
            .map(|d| d.count())
            .unwrap_or(0),
        0,
        "a submodule was fetched"
    );

    let lock = s.lockfile();
    assert_eq!(lock["plugins"][0]["name"], "hostile");
    assert_eq!(lock["plugins"][0]["repo"], "someone/tmuxy-hostile");
    assert_eq!(lock["plugins"][0]["sha"], sha.as_str());

    // The same name again is refused.
    let again = s.tmuxy(&["install", "someone/tmuxy-hostile", "--yes", "--sha", &sha]);
    assert_eq!(again.status.code(), Some(1));
    assert!(
        stderr(&again).contains("already installed"),
        "{}",
        stderr(&again)
    );

    // The verb resolves, and runs the plugin's command.
    // `tmuxy plugin hostile` runs the plugin's command; a word nobody has
    // is a bad command line.
    let ran = s.tmuxy(&["hostile"]);
    assert_eq!(String::from_utf8_lossy(&ran.stdout).trim(), "hello");
    let unknown = s.tmuxy(&["nobody-has-this"]);
    assert_eq!(unknown.status.code(), Some(2), "{}", stderr(&unknown));
    // `--json` before the command is the binary's: the failure is JSON too.
    let as_json = s.tmuxy(&["--json", "nobody-has-this"]);
    assert_eq!(as_json.status.code(), Some(2));
    let answer: serde_json::Value = serde_json::from_slice(&as_json.stdout).unwrap();
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["code"], 2);
}

#[test]
fn a_synced_lockfile_reproduces_the_same_commits() {
    let s = Scratch::new("lock");
    let sha = hostile_repo(&s, "someone", "tmuxy-hostile", MANIFEST);
    std::fs::create_dir_all(s.path("home/.config/tmuxy")).unwrap();
    assert!(s
        .tmuxy(&["install", "someone/tmuxy-hostile", "--yes", "--sha", &sha])
        .status
        .success());

    // The repository moves on; a fresh machine has only the lockfile.
    let repo = s.path("remote/someone/tmuxy-hostile.git");
    std::fs::write(repo.join("NEW"), "x").unwrap();
    git(&repo, &["add", "NEW"]);
    git(&repo, &["commit", "-q", "-m", "later"]);
    std::fs::remove_dir_all(s.path("state")).unwrap();

    let refused = s.tmuxy(&["install"]);
    assert_eq!(refused.status.code(), Some(1), "no terminal, no --yes");
    let out = s.tmuxy(&["install", "--yes"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let checkout = s.path(&format!("state/plugins/hostile@{sha}"));

    // A checkout tampered with on disk is not trusted: fetched again.
    #[cfg(unix)]
    {
        std::fs::remove_file(checkout.join("bin/hello")).unwrap();
        std::os::unix::fs::symlink("/bin/sh", checkout.join("bin/hello")).unwrap();
        let again = s.tmuxy(&["install", "--yes"]);
        assert!(again.status.success(), "{}", stderr(&again));
        assert!(
            String::from_utf8_lossy(&again.stdout).contains("fetching it again"),
            "{}",
            String::from_utf8_lossy(&again.stdout)
        );
        assert!(std::fs::symlink_metadata(checkout.join("bin/hello"))
            .unwrap()
            .is_file());
    }
    assert!(checkout.join("tmuxy-plugin.toml").is_file());
    assert!(
        !checkout.join("NEW").exists(),
        "the pinned commit, not the latest"
    );

    // `update` moves it on, and the old checkout goes (nothing runs from it).
    let new_sha = git(&repo, &["rev-parse", "HEAD"]);
    let updated = s.tmuxy(&["update", "hostile", "--yes", "--sha", &new_sha]);
    assert!(updated.status.success(), "{}", stderr(&updated));
    assert!(stderr(&updated).contains("Update plugin hostile"));
    assert_eq!(s.lockfile()["plugins"][0]["sha"], new_sha.as_str());
    assert!(s
        .path(&format!("state/plugins/hostile@{new_sha}/NEW"))
        .is_file());
    assert!(!checkout.exists());

    let removed = s.tmuxy(&["remove", "hostile"]);
    assert!(removed.status.success(), "{}", stderr(&removed));
    assert_eq!(s.lockfile()["plugins"], serde_json::json!([]));
    assert!(!s.path(&format!("state/plugins/hostile@{new_sha}")).exists());
}

#[test]
fn a_subdir_plugin_installs_and_a_bad_manifest_names_its_line() {
    let s = Scratch::new("subdir");
    let repo = s.path("remote/someone/tmuxy-tools.git");
    std::fs::create_dir_all(repo.join("plugins/one/bin")).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "uploadpack.allowAnySHA1InWant", "true"]);
    std::fs::write(
        repo.join("plugins/one/tmuxy-plugin.toml"),
        MANIFEST.replace("\"hostile\"", "\"one\""),
    )
    .unwrap();
    std::fs::write(repo.join("plugins/one/bin/hello"), "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            repo.join("plugins/one/bin/hello"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "tools"]);
    git(&repo, &["tag", "v1"]);
    let sha = git(&repo, &["rev-parse", "HEAD"]);
    std::fs::create_dir_all(s.path("home/.config/tmuxy")).unwrap();

    let out = s.tmuxy(&[
        "install",
        "someone/tmuxy-tools/plugins/one@v1",
        "--yes",
        "--sha",
        &sha,
    ]);
    assert!(out.status.success(), "{}", stderr(&out));
    let lock = s.lockfile();
    assert_eq!(
        lock["plugins"][0]["repo"],
        "someone/tmuxy-tools/plugins/one"
    );
    assert_eq!(lock["plugins"][0]["ref"], "v1");

    let listed = s.tmuxy(&["list", "--json"]);
    let json: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(json["ok"], true);
    assert_eq!(json["plugins"][0]["name"], "one");
    assert_eq!(json["plugins"][0]["actions"][0], "one:hello");

    let missing = s.tmuxy(&["install", "someone/tmuxy-tools/plugins/absent", "--yes"]);
    assert_eq!(missing.status.code(), Some(3), "{}", stderr(&missing));

    // `check` reports a broken manifest by file and line.
    let bad = s.path("bad");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(
        bad.join("tmuxy-plugin.toml"),
        "[plugin]\napi = 1\nname = \"bad\"\nversion = \"1\"\n\n[[actions]]\nid = \"x\"\ntitle = \"X\"\nsurfce = \"tab\"\ncommand = [\"bin/x\"]\n",
    )
    .unwrap();
    let checked = s.tmuxy(&["check", bad.to_str().unwrap()]);
    assert_eq!(checked.status.code(), Some(1));
    assert!(
        stderr(&checked).contains("tmuxy-plugin.toml:9:1: unknown field `surfce`"),
        "{}",
        stderr(&checked)
    );
}

#[test]
fn a_new_plugin_links_checks_and_lists() {
    let s = Scratch::new("new");
    std::fs::create_dir_all(s.path("home/.config/tmuxy")).unwrap();
    let created = s.tmuxy(&["new", "hello"]);
    assert!(created.status.success(), "{}", stderr(&created));
    let dir = s.path("home/tmuxy-hello");
    assert!(s.tmuxy(&["check", dir.to_str().unwrap()]).status.success());

    // A linked directory needs no commit; without a terminal it still asks.
    let refused = s.tmuxy(&["install", "--path", dir.to_str().unwrap()]);
    assert_eq!(refused.status.code(), Some(1));
    let linked = s.tmuxy(&["install", "--path", dir.to_str().unwrap(), "--yes"]);
    assert!(linked.status.success(), "{}", stderr(&linked));
    let list = String::from_utf8_lossy(&s.tmuxy(&["list"]).stdout).into_owned();
    assert!(list.contains("hello") && list.contains("dev"), "{list}");
    assert!(list.contains("action  hello:hello"), "{list}");

    // Running an action needs a pane, and a tmux server to open it in.
    let no_pane = s.tmuxy(&["action", "hello:hello"]);
    assert_eq!(no_pane.status.code(), Some(2), "{}", stderr(&no_pane));
    let unknown = s.tmuxy(&["action", "hello:nope", "--pane", "%1"]);
    assert_eq!(unknown.status.code(), Some(3), "{}", stderr(&unknown));
}
