//! Plugins that bring more than actions: dependencies, settings, the index
//! and themes, end to end with the real binary against local repositories
//! (`plugin_common`). Keys and link handlers need a tmux server and a page:
//! the E2E suite's (`tests/17-plugins.test.js`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod plugin_common;

use plugin_common::{repo, stderr, stdout, Scratch};

fn manifest(name: &str, extra: &str) -> String {
    format!(
        "[plugin]\napi = 1\nname = \"{name}\"\nversion = \"1.0.0\"\n{extra}\n\n\
         [[actions]]\nid = \"run\"\ntitle = \"Run {name}\"\ncommand = [\"bin/run\"]\n"
    )
}

const RUN: (&str, &str, bool) = ("bin/run", "#!/bin/sh\necho ran\n", true);

#[test]
fn a_dependency_comes_through_one_gate_pinned_and_is_kept_while_needed() {
    let s = Scratch::new("deps");
    std::fs::create_dir_all(s.path("home/.config/tmuxy")).unwrap();
    let lib_sha = repo(
        &s,
        "someone",
        "tmuxy-lib",
        &[("tmuxy-plugin.toml", &manifest("lib", ""), false), RUN],
    );
    let app_manifest = manifest(
        "app",
        "depends = [{ name = \"lib\", source = \"someone/tmuxy-lib\" }]",
    );
    let app_sha = repo(
        &s,
        "someone",
        "tmuxy-app",
        &[("tmuxy-plugin.toml", &app_manifest, false), RUN],
    );

    // A --yes names every commit it reviewed: the plugin's alone leaves the
    // dependency's unreviewed, and installs nothing.
    let partial = s.tmuxy(&["install", "someone/tmuxy-app", "--yes", "--sha", &app_sha]);
    assert_eq!(partial.status.code(), Some(1), "{}", stderr(&partial));
    assert!(stderr(&partial).contains(&lib_sha), "{}", stderr(&partial));
    assert!(!s.path("home/.config/tmuxy/plugins.json").exists());

    let out = s.tmuxy(&[
        "install",
        "someone/tmuxy-app",
        "--yes",
        "--sha",
        &app_sha,
        "--sha",
        &lib_sha,
    ]);
    assert!(out.status.success(), "{}", stderr(&out));
    let gate = stderr(&out);
    assert!(
        gate.contains("Install plugin app") && gate.contains("Install plugin lib"),
        "{gate}"
    );
    assert!(
        gate.contains(&app_sha) && gate.contains(&lib_sha),
        "both commits shown: {gate}"
    );
    assert!(stdout(&out).contains("installed lib (a dependency of app)"));
    let lock = s.lockfile();
    let pinned: Vec<(String, String)> = lock["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["name"].as_str().unwrap().into(),
                e["sha"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        pinned,
        vec![
            ("app".into(), app_sha.clone()),
            ("lib".into(), lib_sha.clone())
        ]
    );

    let path = s.tmuxy(&["path", "lib"]);
    assert!(
        stdout(&path).trim().ends_with(&format!("lib@{lib_sha}")),
        "{}",
        stdout(&path)
    );

    let refused = s.tmuxy(&["remove", "lib"]);
    assert_eq!(refused.status.code(), Some(1));
    assert!(
        stderr(&refused).contains("app depend on \"lib\""),
        "{}",
        stderr(&refused)
    );
    let forced = s.tmuxy(&["remove", "lib", "--force"]);
    assert!(forced.status.success(), "{}", stderr(&forced));
    assert!(stdout(&forced).contains("removed app") && stdout(&forced).contains("removed lib"));
    assert_eq!(s.lockfile()["plugins"], serde_json::json!([]));
}

#[test]
fn a_dependency_cycle_installs_nothing() {
    let s = Scratch::new("cycle");
    std::fs::create_dir_all(s.path("home/.config/tmuxy")).unwrap();
    repo(
        &s,
        "o",
        "b",
        &[
            (
                "tmuxy-plugin.toml",
                &manifest("b", "depends = [{ name = \"a\", source = \"o/a\" }]"),
                false,
            ),
            RUN,
        ],
    );
    let a_sha = repo(
        &s,
        "o",
        "a",
        &[
            (
                "tmuxy-plugin.toml",
                &manifest("a", "depends = [{ name = \"b\", source = \"o/b\" }]"),
                false,
            ),
            RUN,
        ],
    );
    let out = s.tmuxy(&["install", "o/a", "--yes", "--sha", &a_sha]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stderr(&out).contains("dependency cycle: a -> b -> a"),
        "{}",
        stderr(&out)
    );
    assert!(!s.path("home/.config/tmuxy/plugins.json").exists());
}

#[test]
fn a_secret_setting_is_never_printed() {
    let s = Scratch::new("settings");
    std::fs::create_dir_all(s.path("home/.config/tmuxy")).unwrap();
    let dir = s.path("home/conf");
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(
        dir.join("tmuxy-plugin.toml"),
        manifest("conf", "")
            + "\n[[settings]]\nkey = \"token\"\ntype = \"string\"\nsecret = true\n\n\
              [[settings]]\nkey = \"count\"\ntype = \"int\"\ndefault = 3\n",
    )
    .unwrap();
    std::fs::write(dir.join("bin/run"), "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("bin/run"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }
    assert!(s
        .tmuxy(&["install", "--path", dir.to_str().unwrap(), "--yes"])
        .status
        .success());

    let set = s.tmuxy(&["config", "conf", "token", "hunter2-secret"]);
    assert!(set.status.success(), "{}", stderr(&set));
    assert!(!stdout(&set).contains("hunter2"));
    let bad = s.tmuxy(&["config", "conf", "count", "many"]);
    assert_eq!(bad.status.code(), Some(1));
    assert!(stderr(&bad).contains("not a whole number"));
    assert!(s.tmuxy(&["config", "conf", "count", "7"]).status.success());

    for listing in [
        s.tmuxy(&["config", "conf"]),
        s.tmuxy(&["config", "conf", "--json"]),
        s.tmuxy(&["config", "conf", "token"]),
        s.tmuxy(&["list", "--json"]),
    ] {
        let all = format!("{}{}", stdout(&listing), stderr(&listing));
        assert!(!all.contains("hunter2"), "a secret was printed: {all}");
    }
    let listed = stdout(&s.tmuxy(&["config", "conf"]));
    assert!(
        listed.contains("token") && listed.contains("set"),
        "{listed}"
    );
    assert!(listed.contains("count") && listed.contains('7'), "{listed}");
    let log = std::fs::read_to_string(s.path("state/plugins/conf.state/log")).unwrap_or_default();
    assert!(!log.contains("hunter2"));
}

#[test]
fn the_index_finds_a_plugin_and_installs_it_by_name_at_its_current_commit() {
    let s = Scratch::new("index");
    std::fs::create_dir_all(s.path("home/.config/tmuxy")).unwrap();
    let sha = repo(
        &s,
        "someone",
        "tmuxy-chrome-devtools",
        &[
            (
                "tmuxy-plugin.toml",
                &manifest("chrome-devtools", "description = \"DevTools in a pane\""),
                false,
            ),
            RUN,
        ],
    );
    std::fs::write(
        s.path("index.json"),
        serde_json::json!({
            "generated": "now",
            "plugins": [
                { "name": "chrome-devtools", "source": "someone/tmuxy-chrome-devtools",
                  "description": "DevTools in a pane", "sha": "0".repeat(40) },
                { "name": "notes", "source": "a/notes" },
                { "name": "notes", "source": "b/notes", "duplicate": true },
            ]
        })
        .to_string(),
    )
    .unwrap();

    let found = s.tmuxy(&["search", "chrome"]);
    assert!(
        stdout(&found).contains("tmuxy plugin install chrome-devtools"),
        "{}",
        stdout(&found)
    );
    let as_json: serde_json::Value =
        serde_json::from_slice(&s.tmuxy(&["search", "--json"]).stdout).unwrap();
    assert_eq!(as_json["plugins"].as_array().unwrap().len(), 3);

    let ambiguous = s.tmuxy(&["install", "notes", "--yes"]);
    assert_eq!(ambiguous.status.code(), Some(1));
    assert!(stderr(&ambiguous).contains("a/notes, b/notes"));

    // The index lists a stale commit; the gate pins the current one.
    let out = s.tmuxy(&["install", "chrome-devtools", "--yes", "--sha", &sha]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(s.lockfile()["plugins"][0]["sha"], sha.as_str());
    assert_eq!(
        s.lockfile()["plugins"][0]["repo"],
        "someone/tmuxy-chrome-devtools"
    );
}

#[test]
fn a_themes_only_plugin_goes_through_the_gate_and_lists_its_theme() {
    let s = Scratch::new("themes");
    std::fs::create_dir_all(s.path("home/.config/tmuxy")).unwrap();
    let sha = repo(
        &s,
        "someone",
        "tmuxy-dusk",
        &[
            (
                "tmuxy-plugin.toml",
                "[plugin]\napi = 1\nname = \"dusk\"\nversion = \"1\"\n\n[[themes]]\nid = \"night\"\nfile = \"night.css\"\n",
                false,
            ),
            ("night.css", ":root.theme-dark { --term-background: #010203; }", false),
        ],
    );
    let refused = s.tmuxy(&["install", "someone/tmuxy-dusk"]);
    assert_eq!(refused.status.code(), Some(1), "no terminal, no --yes");
    let out = s.tmuxy(&["install", "someone/tmuxy-dusk", "--yes", "--sha", &sha]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(
        stderr(&out).contains("themes    night: night.css"),
        "{}",
        stderr(&out)
    );
    assert!(stderr(&out).contains("can restyle or hide any of the app"));
    let listed = stdout(&s.tmuxy(&["list"]));
    assert!(listed.contains("theme   dusk__night"), "{listed}");
}
