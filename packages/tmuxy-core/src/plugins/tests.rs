use std::path::{Path, PathBuf};

use super::lockfile::{Entry, Lockfile};
use super::manifest::{self, Dim, Menu, Size, Surface};
use super::registry::{self, resolve_command, Kind, Registry};
use super::source::{self, InstallSource};
use super::*;

pub(super) const GOOD: &str = r#"
[plugin]
api = 1
min_tmuxy = "0.1.0"
name = "claude-artifacts"
version = "0.1.0"
description = "Preview artifacts"
platforms = ["linux", "macos"]
requires = ["curl"]

[[actions]]
id = "open-url"
title = "Open in Claude Artifacts"
menu = "app"
surface = "popup"
size = { width = "80%", height = 30 }
command = ["bin/open-url", "--flag"]

[[actions]]
id = "plain"
title = "Plain"
command = ["bin/plain"]

[[cli]]
verb = "artifact"
command = ["bin/cli"]
"#;

pub(super) fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tmuxy-plugins-test-{tag}-{}-{}",
        std::process::id(),
        random_hex().unwrap()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(super) fn dirs_in(base: &Path) -> Layout {
    Layout {
        config: base.join("config"),
        data: base.join("data"),
        state: base.join("state"),
        home: base.to_path_buf(),
    }
}

pub(super) fn plugin_dir(base: &Path, manifest_text: &str, commands: &[&str]) -> PathBuf {
    let dir = base.join("plugin");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(MANIFEST_FILE), manifest_text).unwrap();
    for rel in commands {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    dir
}

#[test]
fn a_full_manifest_parses() {
    let m = manifest::parse(GOOD).unwrap();
    assert_eq!(m.name, "claude-artifacts");
    assert_eq!(m.requires, vec!["curl"]);
    assert_eq!(m.actions.len(), 2);
    let open = m.actions.iter().find(|a| a.id == "open-url").unwrap();
    assert_eq!(open.menu, Some(Menu::App));
    assert_eq!(open.surface, Surface::Popup);
    assert_eq!(
        open.size,
        Some(Size {
            width: Some(Dim::Percent(80)),
            height: Some(Dim::Cells(30)),
        })
    );
    assert_eq!(open.command, vec!["bin/open-url", "--flag"]);
    let plain = m.actions.iter().find(|a| a.id == "plain").unwrap();
    assert_eq!(plain.surface, Surface::Split);
    assert_eq!(plain.menu, None);
    assert_eq!(m.cli[0].verb, "artifact");
}

fn errors(text: &str) -> Vec<String> {
    manifest::parse(text)
        .unwrap_err()
        .iter()
        .map(|d| d.render("m.toml"))
        .collect()
}

#[test]
fn an_unknown_key_is_an_error_on_its_line() {
    let text = GOOD.replace("surface = \"popup\"", "surfce = \"popup\"");
    let errs = errors(&text);
    assert_eq!(errs.len(), 1);
    assert!(errs[0].starts_with("m.toml:15:1:"), "{errs:?}");
    assert!(errs[0].contains("surfce"), "{errs:?}");
}

#[test]
fn every_semantic_problem_is_reported_with_its_line() {
    let text = r#"[plugin]
api = 2
name = "Bad Name"
version = "1"

[[actions]]
id = "x"
title = "X"
size = { width = "120%" }
command = ["../escape"]

[[actions]]
id = "x"
title = "Again"
command = []

[[cli]]
verb = "-flag"
command = ["/abs"]
"#;
    let errs = errors(text);
    let has = |line: &str, needle: &str| {
        errs.iter()
            .any(|e| e.starts_with(&format!("m.toml:{line}:")) && e.contains(needle))
    };
    assert!(has("2", "api = 2"), "{errs:#?}");
    assert!(has("3", "name"), "{errs:#?}");
    assert!(has("9", "size applies to the float and popup"), "{errs:#?}");
    assert!(has("9", "120%"), "{errs:#?}");
    assert!(has("10", "stay inside the plugin"), "{errs:#?}");
    assert!(has("13", "declared twice"), "{errs:#?}");
    assert!(has("15", "command is empty"), "{errs:#?}");
    assert!(has("18", "verb"), "{errs:#?}");
    assert!(has("19", "not absolute"), "{errs:#?}");
}

#[test]
fn a_manifest_that_declares_nothing_is_refused() {
    let errs = errors("[plugin]\napi = 1\nname = \"x\"\nversion = \"1\"\n");
    assert!(errs[0].contains("declares nothing"), "{errs:?}");
}

#[test]
fn an_oversized_manifest_is_refused_before_parsing() {
    let text = format!("{GOOD}\n#{}", "x".repeat(manifest::MAX_MANIFEST_BYTES));
    assert!(errors(&text)[0].contains("the limit is"));
}

#[test]
fn a_title_with_a_newline_is_refused() {
    let text = GOOD.replace("title = \"Plain\"", "title = \"Pl\\nain\"");
    assert!(errors(&text).iter().any(|e| e.contains("title")));
}

#[test]
fn versions_compare_by_number() {
    assert_eq!(parse_version("0.10.2"), Some((0, 10, 2)));
    assert_eq!(parse_version("v1.2"), Some((1, 2, 0)));
    assert_eq!(parse_version("1.2.3-beta"), Some((1, 2, 3)));
    assert_eq!(parse_version("x"), None);
    assert!(satisfies_min_tmuxy("0.0.1"));
    assert!(satisfies_min_tmuxy(TMUXY_VERSION));
    assert!(!satisfies_min_tmuxy("999.0.0"));
}

#[test]
fn a_percentage_resolves_against_the_tab() {
    assert_eq!(Dim::Percent(50).resolve(121), 60);
    assert_eq!(Dim::Percent(1).resolve(10), 1);
    assert_eq!(Dim::Cells(0).resolve(10), 1);
}

#[test]
fn a_repo_source_parses_with_subdir_and_ref() {
    let s = source::parse_repo("someone/tmuxy-tools/plugins/devtools@v1.2").unwrap();
    assert_eq!(s.owner, "someone");
    assert_eq!(s.repo, "tmuxy-tools");
    assert_eq!(s.subdir.as_deref(), Some("plugins/devtools"));
    assert_eq!(s.git_ref.as_deref(), Some("v1.2"));
    assert_eq!(s.slug(), "someone/tmuxy-tools/plugins/devtools");
    assert!(s.url().ends_with("/someone/tmuxy-tools.git"));
}

#[test]
fn a_source_that_could_reach_git_as_an_option_or_escape_is_refused() {
    for bad in [
        "-oops/repo",
        "owner/-repo",
        "owner/repo/../x",
        "owner/repo/./x",
        "owner/repo//x",
        "owner/repo@-ref",
        "owner/repo@a..b",
        "owner/repo@ref name",
        "owner",
        "owner/",
    ] {
        assert!(source::parse_repo(bad).is_err(), "{bad} should be refused");
    }
}

#[test]
fn an_install_argument_is_a_repo_a_name_or_neither() {
    assert!(matches!(
        source::parse_install("a/b").unwrap(),
        InstallSource::Repo(_)
    ));
    assert_eq!(
        source::parse_install("chrome-devtools").unwrap(),
        InstallSource::Name("chrome-devtools".into())
    );
    assert!(source::parse_install("Not A Name").is_err());
}

#[test]
fn the_lockfile_round_trips_sorted_and_owner_only() {
    let base = scratch("lock");
    let dirs = dirs_in(&base);
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_repo(
        "zeta",
        &source::parse_repo("o/r/sub@main").unwrap(),
        sha,
    ));
    lock.upsert(Entry::from_path("alpha", Path::new("/tmp/alpha")));
    lock.save(&dirs).unwrap();
    let back = Lockfile::load(&dirs).unwrap();
    assert_eq!(back.plugins[0].name, "alpha");
    assert_eq!(back.plugins[1].repo.as_deref(), Some("o/r/sub"));
    assert_eq!(back.plugins[1].git_ref.as_deref(), Some("main"));
    assert_eq!(back.plugins[1].sha.as_deref(), Some(sha));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dirs.lockfile())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn a_hand_broken_entry_is_refused() {
    let entry = |json: &str| serde_json::from_str::<Entry>(json).unwrap().source();
    assert!(entry(r#"{"name":"x","repo":"o/r"}"#).is_err(), "no sha");
    assert!(
        entry(r#"{"name":"x","repo":"o/r","sha":"abc"}"#).is_err(),
        "short sha"
    );
    assert!(
        entry(r#"{"name":"x","path":"relative"}"#).is_err(),
        "relative path"
    );
    assert!(entry(r#"{"name":"x"}"#).is_err(), "no source");
    assert!(serde_json::from_str::<Entry>(r#"{"name":"x","path":"/a","extra":1}"#).is_err());
}

#[test]
fn a_linked_plugin_and_the_users_own_load() {
    let base = scratch("registry");
    let dirs = dirs_in(&base);
    let dir = plugin_dir(&base, GOOD, &["bin/open-url", "bin/plain", "bin/cli"]);
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("claude-artifacts", &dir));
    lock.upsert(Entry::from_path("missing", &base.join("nowhere")));
    lock.save(&dirs).unwrap();
    std::fs::write(
        dirs.user_plugin_manifest(),
        "[plugin]\napi = 1\nname = \"user\"\nversion = \"0\"\n\
         [[actions]]\nid = \"a\"\ntitle = \"A\"\ncommand = [\"x\"]\n\
         [[cli]]\nverb = \"list\"\ncommand = [\"x\"]\n\
         [[cli]]\nverb = \"artifact\"\ncommand = [\"x\"]\n",
    )
    .unwrap();

    let registry = Registry::load(&dirs).unwrap();
    assert_eq!(registry.plugins[0].name, USER_PLUGIN);
    assert_eq!(registry.plugins[0].kind, Kind::User);
    assert_eq!(registry.plugins[1].kind, Kind::Linked);
    assert_eq!(registry.broken[0].name, "missing");
    assert!(registry.action("claude-artifacts", "open-url").is_ok());
    assert_eq!(
        registry
            .action("claude-artifacts", "nope")
            .unwrap_err()
            .exit_code(),
        3
    );
    // `list` is a `tmuxy plugin` command, which wins; the user's own plugin
    // comes first, so its `artifact` wins over the linked plugin's.
    assert!(registry.verb("list").is_none());
    assert_eq!(registry.verb("artifact").unwrap().0.name, USER_PLUGIN);
    let shadowed = |name: &str| registry.shadowed(registry.get(name).unwrap());
    assert_eq!(
        shadowed(USER_PLUGIN),
        vec![registry::Shadowed {
            verb: "list".into(),
            by: None
        }]
    );
    assert_eq!(
        shadowed("claude-artifacts"),
        vec![registry::Shadowed {
            verb: "artifact".into(),
            by: Some(USER_PLUGIN.into())
        }]
    );
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
#[cfg(unix)]
fn a_command_that_escapes_its_plugin_is_refused() {
    let base = scratch("escape");
    let dir = plugin_dir(&base, GOOD, &["bin/ok"]);
    std::fs::write(base.join("outside"), "#!/bin/sh\n").unwrap();
    std::os::unix::fs::symlink(base.join("outside"), dir.join("bin/link")).unwrap();
    std::fs::write(dir.join("bin/noexec"), "x").unwrap();
    assert!(resolve_command(&dir, &["bin/ok".into()]).is_ok());
    let err = resolve_command(&dir, &["bin/link".into()])
        .unwrap_err()
        .to_string();
    assert!(err.contains("outside the plugin"), "{err}");
    let err = resolve_command(&dir, &["bin/noexec".into()])
        .unwrap_err()
        .to_string();
    assert!(err.contains("not executable"), "{err}");
    let err = resolve_command(&dir, &["bin/absent".into()])
        .unwrap_err()
        .to_string();
    assert!(err.contains("missing"), "{err}");
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn the_inventory_is_compact_and_its_rev_follows_its_content() {
    let base = scratch("inventory");
    let dirs = dirs_in(&base);
    let dir = plugin_dir(&base, GOOD, &[]);
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("claude-artifacts", &dir));
    lock.save(&dirs).unwrap();

    let registry = Registry::load(&dirs).unwrap();
    let plugins = inventory::build(&registry);
    let json = serde_json::to_value(&plugins).unwrap();
    assert_eq!(
        json,
        serde_json::json!([{
            "name": "claude-artifacts",
            "actions": [
                {"id": "open-url", "title": "Open in Claude Artifacts", "menu": "app", "surface": "popup"},
                {"id": "plain", "title": "Plain", "surface": "split"},
            ],
        }])
    );
    let (b64, rev) = inventory::encode(&plugins);
    assert!(b64
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)));
    assert_eq!(
        inventory::encode(&plugins).1,
        rev,
        "same inventory, same rev"
    );
    assert_ne!(inventory::encode(&[]).1, rev);
    let cmds = inventory::commands(&dirs).unwrap();
    assert_eq!(cmds[0], format!("set-option -g @tmuxy-plugins {b64}"));
    assert_eq!(cmds[1], format!("set-option -g @tmuxy-plugins-rev {rev}"));
    // A lockfile that no longer loads publishes nothing, rather than an
    // inventory with no plugins in it.
    std::fs::write(dirs.lockfile(), "{ not json").unwrap();
    assert!(inventory::commands(&dirs).is_err());
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn a_plugin_that_needs_a_newer_tmuxy_does_not_load() {
    let base = scratch("min-tmuxy");
    let dirs = dirs_in(&base);
    let dir = plugin_dir(
        &base,
        &GOOD.replace("min_tmuxy = \"0.1.0\"", "min_tmuxy = \"99.0.0\""),
        &[],
    );
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("claude-artifacts", &dir));
    lock.save(&dirs).unwrap();
    let registry = Registry::load(&dirs).unwrap();
    assert!(registry.get("claude-artifacts").is_none());
    assert!(
        registry.broken[0].reason.contains("needs tmuxy 99.0.0"),
        "{:?}",
        registry.broken
    );
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn a_cli_verb_with_a_control_character_or_no_platform_is_refused() {
    let escape = GOOD.replace(
        "verb = \"artifact\"",
        "verb = \"artifact\"\ndescription = \"a\\u001b[2Jb\"",
    );
    assert!(
        errors(&escape).iter().any(|e| e.contains("description")),
        "{:?}",
        errors(&escape)
    );
    let nowhere = GOOD.replace("verb = \"artifact\"", "verb = \"artifact\"\nplatforms = []");
    assert!(errors(&nowhere)
        .iter()
        .any(|e| e.contains("platforms is empty")));
}
