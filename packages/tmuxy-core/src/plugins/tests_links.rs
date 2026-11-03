use super::index::{self, Index, IndexEntry};
use super::invoke::Token;
use super::keys;
use super::links;
use super::lockfile::{Entry, Lockfile};
use super::manifest::sections::normalize_key;
use super::manifest::{self, LinkMatch, SettingType, SettingValue};
use super::registry::Registry;
use super::tests::{dirs_in, plugin_dir, scratch};
use super::{settings, themes};

const LINKS: &str = r#"
[plugin]
api = 1
name = "artifacts"
version = "1"

[[actions]]
id = "open"
title = "Open"
command = ["bin/open"]

[[link_handlers]]
id = "artifact"
match = "url"
hosts = ["claude.ai"]
path_regex = "/public/artifacts/[A-Za-z0-9-]+"
action = "open"

[[link_handlers]]
id = "dev"
match = "url"
hosts = ["localhost"]
schemes = ["http", "https"]
ports = [3000]
action = "open"

[[link_handlers]]
id = "file-line"
match = "text"
pattern = '(?P<path>[\w./-]+\.rs):(?P<line>\d+)'
action = "open"

[[keys]]
key = "M-a"
action = "open"

[[settings]]
key = "download_dir"
type = "string"
default = "~/Downloads"
description = "Where artifacts go"

[[settings]]
key = "token"
type = "string"
secret = true

[[settings]]
key = "mode"
type = "enum"
values = ["fast", "safe"]
default = "safe"

[[themes]]
id = "dark"
file = "themes/dark.css"
"#;

fn url_handler(m: &manifest::Manifest, id: &str) -> LinkMatch {
    m.link_handlers
        .iter()
        .find(|h| h.id == id)
        .unwrap()
        .matcher
        .clone()
}

fn takes(matcher: &LinkMatch, url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| links::url_matches(matcher, &u))
}

#[test]
fn a_url_handler_takes_only_the_exact_https_host_and_path() {
    let m = manifest::parse(LINKS).unwrap();
    let artifact = url_handler(&m, "artifact");
    assert!(takes(
        &artifact,
        "https://claude.ai/public/artifacts/abc-123"
    ));
    for bad in [
        "https://claude.ai@evil.com/public/artifacts/abc",
        "https://user:pw@claude.ai/public/artifacts/abc",
        "https://claude.ai:8443/public/artifacts/abc",
        "http://claude.ai/public/artifacts/abc",
        "https://claude.ai.evil.com/public/artifacts/abc",
        "https://evil.com/claude.ai/public/artifacts/abc",
        // A Cyrillic `с`: its punycode is another host.
        "https://\u{0441}laude.ai/public/artifacts/abc",
        "https://claude.ai/public/artifacts/abc/../../../admin",
        "https://claude.ai/public/artifacts/abc/extra",
        "https://claude.ai/x/public/artifacts/abc",
    ] {
        assert!(!takes(&artifact, bad), "{bad} should be refused");
    }
    let dev = url_handler(&m, "dev");
    assert!(takes(&dev, "http://localhost:3000/anything"));
    assert!(!takes(&dev, "http://localhost:3001/"));
}

#[test]
fn a_url_handler_for_http_or_a_port_must_be_on_localhost() {
    let errs = |text: &str| {
        manifest::parse(text)
            .unwrap_err()
            .iter()
            .map(|d| d.message.clone())
            .collect::<Vec<_>>()
    };
    let http = LINKS.replace(
        "hosts = [\"claude.ai\"]",
        "hosts = [\"claude.ai\"]\nschemes = [\"http\"]",
    );
    assert!(errs(&http).iter().any(|e| e.contains("http for localhost")));
    let ported = LINKS.replace(
        "hosts = [\"claude.ai\"]",
        "hosts = [\"claude.ai\"]\nports = [8443]",
    );
    assert!(errs(&ported)
        .iter()
        .any(|e| e.contains("localhost hosts only")));
    let unicode = LINKS.replace("hosts = [\"claude.ai\"]", "hosts = [\"cl\u{e1}ude.ai\"]");
    assert!(errs(&unicode).iter().any(|e| e.contains("punycode")));
    let missing = LINKS.replace(
        "action = \"open\"\n\n[[link_handlers]]\nid = \"dev\"",
        "action = \"nope\"\n\n[[link_handlers]]\nid = \"dev\"",
    );
    assert!(errs(&missing)
        .iter()
        .any(|e| e.contains("no [[actions]] entry")));
}

#[test]
fn a_text_pattern_matches_the_span_under_the_column_with_its_captures() {
    let pattern = r"(?P<path>[\w./-]+\.rs):(?P<line>\d+)";
    let line = "error at src/main.rs:42 and lib/x.rs:7";
    let at = |column| links::text_matches(pattern, line, column);
    let first = at(12).unwrap();
    assert_eq!(first.text.as_deref(), Some("src/main.rs:42"));
    assert_eq!(first.captures["path"], "src/main.rs");
    assert_eq!(first.captures["line"], "42");
    assert_eq!(at(36).unwrap().captures["path"], "lib/x.rs");
    assert!(at(2).is_none(), "the column is on no match");
    // Columns count characters, not bytes.
    let wide = "é→ src/a.rs:1";
    assert_eq!(
        links::text_matches(pattern, wide, 4).unwrap().captures["path"],
        "src/a.rs"
    );
}

#[test]
fn a_pathological_pattern_over_a_long_line_stays_fast() {
    let line = "a".repeat(10_000);
    let started = std::time::Instant::now();
    assert!(links::text_matches("(a+)+$x", &line, 5_000).is_none());
    assert!(links::text_matches("(a|aa)*b", &line, 9_999).is_none());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert!(
        manifest::sections::compile(&"a".repeat(300)).is_err(),
        "too long"
    );
}

#[test]
fn a_link_prepares_a_token_with_the_link_and_the_url_after_double_dash() {
    let base = scratch("links");
    let dirs = dirs_in(&base);
    let dir = plugin_dir(&base, LINKS, &["bin/open"]);
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("artifacts", &dir));
    lock.save(&dirs).unwrap();
    let registry = Registry::load(&dirs).unwrap();

    let url = "https://claude.ai/public/artifacts/abc";
    let prepared = links::prepare(&dirs, links::match_url(&registry, url), "%3")
        .unwrap()
        .unwrap();
    assert_eq!(
        (prepared.plugin.as_str(), prepared.action.as_str()),
        ("artifacts", "open")
    );
    let token = Token::read(&dirs, &prepared.token).unwrap();
    // The argv `tmuxy plugin action artifacts:open -- <url>` gives the command.
    assert_eq!(token.args, vec![url.to_string()]);
    assert_eq!(token.link.unwrap().url.as_deref(), Some(url));
    assert!(links::match_url(&registry, "https://evil.com/").is_none());
    // Matched as parsed: the host case-folded, the path without its query or
    // fragment (a `/` in either cannot break the path regex).
    assert!(links::match_url(
        &registry,
        "https://Claude.AI/public/artifacts/abc?next=/x#/y"
    )
    .is_some());

    let text = links::match_text(&registry, "see src/main.rs:42", 6).unwrap();
    assert_eq!(text.link.captures["line"], "42");
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn keys_parse_tmux_syntax_and_ours_are_known_by_their_marker() {
    assert_eq!(normalize_key("M-a").as_deref(), Some("M-a"));
    assert_eq!(normalize_key("C-M-F5").as_deref(), Some("C-M-F5"));
    assert_eq!(normalize_key("PageUp").as_deref(), Some("PPage"));
    for bad in ["", "M-", "M-ab", "F13", "C-;", "x y", "Q-a"] {
        assert!(normalize_key(bad).is_none(), "{bad:?}");
    }
    let listing = format!(
        "bind-key    -T prefix       M-a                  run-shell -b \"{}\"\n\
         bind-key    -T prefix       x                    kill-pane\n",
        keys::binding_command("artifacts", "open")
    );
    assert_eq!(
        keys::ours_in(&listing),
        vec![("prefix".to_string(), "M-a".to_string())]
    );
    assert!(keys::binding_command("p", "a").contains("--pane #{pane_id} --trigger key"));
}

/// The commands that rebind the plugin keys come from the tables as read:
/// a user's binding keeps its key, every old plugin binding goes first.
#[test]
fn key_commands_keep_a_users_binding_and_drop_stale_plugin_ones() {
    let base = scratch("key-commands");
    let dirs = dirs_in(&base);
    let manifest = format!("{LINKS}\n[[keys]]\nkey = \"M-b\"\naction = \"open\"\n");
    let dir = plugin_dir(&base, &manifest, &["bin/open"]);
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("artifacts", &dir));
    lock.save(&dirs).unwrap();
    let registry = Registry::load(&dirs).unwrap();

    let prefix = format!(
        "bind-key    -T prefix       M-a                  kill-pane\n\
         bind-key -r -T prefix       M-z                  run-shell -b \"{}\"\n",
        keys::binding_command("gone", "x")
    );
    let (planned, cmds) = keys::commands(&registry, |table| match table {
        manifest::KeyTable::Prefix => prefix.clone(),
        manifest::KeyTable::Root => String::new(),
    });
    let taken: Vec<_> = planned
        .iter()
        .map(|p| (p.key.as_str(), p.taken_by.as_deref()))
        .collect();
    assert_eq!(
        taken,
        vec![
            ("M-a", Some("bind-key -T prefix M-a kill-pane")),
            ("M-b", None)
        ]
    );
    let words = |cmd: &Vec<String>| cmd[..4].join(" ");
    assert_eq!(
        cmds.iter().map(words).collect::<Vec<_>>(),
        vec!["unbind-key -T prefix M-z", "bind-key -T prefix M-b"]
    );
    assert_eq!(cmds[1][6], keys::binding_command("artifacts", "open"));
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn settings_are_typed_and_a_secret_never_reaches_the_context() {
    let base = scratch("settings");
    let dirs = dirs_in(&base);
    let dir = plugin_dir(&base, LINKS, &["bin/open"]);
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("artifacts", &dir));
    lock.save(&dirs).unwrap();
    let registry = Registry::load(&dirs).unwrap();
    let plugin = registry.get("artifacts").unwrap();

    assert!(settings::set(&dirs, plugin, "mode", "reckless").is_err());
    assert!(settings::set(&dirs, plugin, "nope", "x").is_err());
    settings::set(&dirs, plugin, "mode", "fast").unwrap();
    settings::set(&dirs, plugin, "token", "s3cret-value").unwrap();
    let context = settings::context_values(&dirs, plugin);
    assert_eq!(context["mode"], "fast");
    assert_eq!(context["download_dir"], "~/Downloads");
    assert!(context.get("token").is_none());
    assert!(!context.to_string().contains("s3cret"));
    let token = settings::current(&dirs, plugin)
        .into_iter()
        .find(|c| c.setting.key == "token")
        .unwrap();
    assert_eq!(settings::shown(&token), "set");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(settings::path(&dirs, "artifacts"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    settings::unset(&dirs, plugin, "mode").unwrap();
    assert_eq!(settings::context_values(&dirs, plugin)["mode"], "safe");
    assert_eq!(SettingType::Int.parse("12").unwrap(), SettingValue::Int(12));
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn a_secret_or_mistyped_default_and_a_bad_section_are_refused() {
    let errs = |text: &str| {
        manifest::parse(text)
            .unwrap_err()
            .iter()
            .map(|d| d.message.clone())
            .collect::<Vec<_>>()
    };
    let secret_default = LINKS.replace("secret = true", "secret = true\ndefault = \"x\"");
    assert!(errs(&secret_default)
        .iter()
        .any(|e| e.contains("a secret has no default")));
    let mistyped = LINKS.replace("default = \"safe\"", "default = 3");
    assert!(errs(&mistyped).iter().any(|e| e.contains("default is not")));
    let escaping = LINKS.replace("themes/dark.css", "../dark.css");
    assert!(errs(&escaping)
        .iter()
        .any(|e| e.contains("a .css file inside the plugin")));
    let bad_key = LINKS.replace("key = \"M-a\"", "key = \"M-;\"");
    assert!(errs(&bad_key).iter().any(|e| e.contains("key \"M-;\"")));
    let self_dep = LINKS.replace(
        "version = \"1\"",
        "version = \"1\"\ndepends = [{ name = \"artifacts\", source = \"o/r\" }]",
    );
    assert!(errs(&self_dep).iter().any(|e| e.contains("depends")));
    let themes_only = "[plugin]\napi = 1\nname = \"t\"\nversion = \"1\"\n[[themes]]\nid = \"a\"\nfile = \"a.css\"\n";
    assert!(
        manifest::parse(themes_only).is_ok(),
        "a theme alone is a plugin"
    );
}

#[test]
fn a_plugin_theme_is_listed_named_and_kept_inside_its_plugin() {
    let base = scratch("themes");
    let dirs = dirs_in(&base);
    let dir = plugin_dir(&base, LINKS, &["bin/open"]);
    std::fs::create_dir_all(dir.join("themes")).unwrap();
    std::fs::write(dir.join("themes/dark.css"), ":root { --x: 1; }").unwrap();
    let mut lock = Lockfile::default();
    lock.upsert(Entry::from_path("artifacts", &dir));
    lock.save(&dirs).unwrap();

    let listed = themes::list(&dirs);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].0, "artifacts__dark");
    assert_eq!(
        themes::css(&dirs, "artifacts__dark").unwrap(),
        b":root { --x: 1; }"
    );
    assert!(themes::css(&dirs, "artifacts__nope").is_none());
    #[cfg(unix)]
    {
        std::fs::remove_file(dir.join("themes/dark.css")).unwrap();
        std::os::unix::fs::symlink("/etc/hostname", dir.join("themes/dark.css")).unwrap();
        assert!(themes::list(&dirs).is_empty(), "a file outside the plugin");
    }
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn the_index_searches_words_and_refuses_an_ambiguous_name() {
    let entry = |name: &str, source: &str, description: &str| IndexEntry {
        name: name.into(),
        source: source.into(),
        description: description.into(),
        ..IndexEntry::default()
    };
    let idx = Index {
        generated: String::new(),
        plugins: vec![
            entry(
                "chrome-devtools",
                "someone/tmuxy-chrome-devtools",
                "DevTools in a pane",
            ),
            entry("notes", "a/notes", "Take notes"),
            entry("notes", "b/notes", "Other notes"),
        ],
    };
    assert_eq!(index::search(&idx, "chrome PANE").len(), 1);
    assert_eq!(index::search(&idx, "").len(), 3);
    assert_eq!(
        index::by_name(&idx, "chrome-devtools").unwrap().source,
        "someone/tmuxy-chrome-devtools"
    );
    assert!(index::by_name(&idx, "notes")
        .unwrap_err()
        .to_string()
        .contains("a/notes, b/notes"));
    assert_eq!(index::by_name(&idx, "absent").unwrap_err().exit_code(), 3);
}
