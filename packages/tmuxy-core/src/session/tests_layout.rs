//! The config dir split by owner: what a launch writes where, the first-run
//! starter, the theme lookup, and the migration of an older install. Every
//! test works on a scratch [`Layout`], never the environment's directories.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::assets::{ensure_bin_scripts_in, ensure_themes_in, list_themes_in, resolve_user_css_in};
use super::config::ensure_config_in;
use super::migrate::{clean_user_conf, StaleBlock, OLD_BUILT_IN_THEME_HEADER};
use super::state::{read_managed_state_in, write_managed_state_in};
use super::*;

const V014_CONF: &str = include_str!("fixtures/v0.1.4/tmuxy.conf");
const V014_DEFAULTS: &str = include_str!("fixtures/v0.1.4/tmuxy.defaults.conf");
const V014_ESSENTIALS: &str = include_str!("fixtures/v0.1.4/tmuxy.essentials.conf");
const V014_README: &str = include_str!("fixtures/v0.1.4/README.md");
const V014_USER_CONF_BRIDGE: &str = include_str!("fixtures/v0.1.4/tmuxy.user.conf");

/// The Ctrl+Tab block the 0.0.x upgrade appended, verbatim.
const CTRL_TAB_BLOCK: &str = "\n# Tab navigation (Ctrl+Tab / Ctrl+Shift+Tab) — added by tmuxy upgrade\nbind -n C-Tab next-window\nbind -n C-S-Tab previous-window\n";

/// A Ctrl+hjkl restore, from while the defaults bound Alt+hjkl.
const CTRL_HJKL_BLOCK: &str = "\n# pane navigation on Ctrl again\nbind -n C-h tmuxy-nav-left\nbind -n C-j tmuxy-nav-down\nbind -n C-k tmuxy-nav-up\nbind -n C-l tmuxy-nav-right\n";

/// What a user set in their 0.1.4 `tmuxy.conf`, below the template.
const USER_SETTINGS: &str =
    "\nset -g @tmuxy-opacity 0.85\nunbind C-a\nset -g prefix C-Space\nbind C-Space send-prefix\n";

struct Scratch {
    root: PathBuf,
    layout: Layout,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("tmuxy-layout-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let layout = Layout {
            config: home.join(".config").join("tmuxy"),
            // Relocated, as TMUXY_DATA_DIR does it, so the rewrite of the
            // shipped `$HOME/.local/share/tmuxy` paths is exercised too.
            data: root.join("data"),
            state: root.join("state"),
            home,
        };
        Self { root, layout }
    }

    /// What both hosts do at startup.
    fn launch(&self) {
        ensure_config_in(&self.layout);
        ensure_themes_in(&self.layout.builtin_themes());
        ensure_bin_scripts_in(&self.layout);
    }

    fn write(&self, rel: &str, contents: &str) -> PathBuf {
        let path = self.layout.config.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// Every file under `dir`, by relative path, with its bytes and mtime: two
/// equal trees had nothing written into them.
fn tree(dir: &Path) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
    fn walk(
        base: &Path,
        dir: &Path,
        out: &mut BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)>,
    ) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                walk(base, &path, out);
            } else {
                let bytes = std::fs::read(&path).unwrap_or_default();
                out.insert(
                    path.strip_prefix(base).unwrap().to_path_buf(),
                    (bytes, meta.modified().unwrap()),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn names(dir: &Path) -> Vec<String> {
    tree(dir)
        .keys()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

fn settings(conf: &str) -> Vec<&str> {
    conf.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

/// `~/.config/tmuxy` symlinked into a dotfiles checkout: a full launch, a
/// theme change from the menu and a restart write nothing into it — not the
/// defaults, the README, `bin/`, the built-in themes, the state or the
/// launcher, and not even into the files an older build left there.
#[cfg(unix)]
#[test]
fn a_symlinked_config_dir_is_never_written() {
    let s = Scratch::new("linked");
    let dotfiles = s.root.join("dotfiles").join("tmuxy");
    std::fs::create_dir_all(dotfiles.join("themes")).unwrap();
    std::fs::write(
        dotfiles.join("tmuxy.conf"),
        "set -g @tmuxy-theme-mode light\nset -g @tmuxy-opacity 0.8\n",
    )
    .unwrap();
    std::fs::write(dotfiles.join("custom.css"), ":root { --x: 1 }\n").unwrap();
    std::fs::write(
        dotfiles.join("themes/mine.css"),
        ":root.theme-dark { --a: 1 }\n",
    )
    .unwrap();
    // Left by an older build before the dir went into the repo.
    std::fs::write(
        dotfiles.join("tmuxy.state.json"),
        "{\n  \"theme\": \"nord\"\n}\n",
    )
    .unwrap();
    std::fs::write(dotfiles.join("tmuxy.defaults.conf"), V014_DEFAULTS).unwrap();
    symlink(&dotfiles, &s.layout.config);
    let before = tree(&dotfiles);

    s.launch();
    // The menu's theme change, as `theme::set_theme` remembers it.
    write_managed_state_in(
        &s.layout,
        ManagedState {
            theme: Some("dracula".into()),
            ..Default::default()
        },
    )
    .unwrap();
    s.launch();

    assert_eq!(tree(&dotfiles), before, "the linked config dir was written");
    assert!(std::fs::symlink_metadata(&s.layout.config)
        .unwrap()
        .file_type()
        .is_symlink());
    // The state went to the state dir: the older build's choice was read
    // through the link, and the menu's change landed beside it.
    assert_eq!(
        read_managed_state_in(&s.layout).theme.as_deref(),
        Some("dracula")
    );
    // The chain reads the user's file through the link.
    let entry = read(&s.layout.entry_conf());
    assert!(entry.contains(&format!(
        "source-file -q '{}'",
        s.layout.user_conf().display()
    )));
    assert!(s.layout.builtin_themes().join("nord.css").exists());
    assert!(s.layout.bin().join("tmuxy-cli").exists());
}

/// A user theme named like a built-in shadows it, is listed once, and is
/// never overwritten — the built-ins are mirrored to the data dir, not the
/// user's `themes/`.
#[test]
fn a_user_theme_named_like_a_built_in_is_never_overwritten() {
    let s = Scratch::new("shadow");
    std::fs::create_dir_all(&s.layout.config).unwrap();
    let mine = ":root.theme-dark { --term-background: #010203; }\n";
    let path = s.write("themes/nord.css", mine);

    s.launch();
    s.launch();

    assert_eq!(read(&path), mine);
    assert_eq!(
        resolve_user_css_in(&s.layout.config, "themes/nord.css").as_deref(),
        Some(mine.as_bytes())
    );
    let listed = list_themes_in(&s.layout.user_themes());
    assert_eq!(listed.iter().filter(|n| *n == "nord").count(), 1);
    assert_eq!(listed.first().map(String::as_str), Some("default"));
    assert!(listed.contains(&"dracula".to_string()));
    let built_in = read(&s.layout.builtin_themes().join("nord.css"));
    assert!(built_in.starts_with(BUILT_IN_THEME_HEADER));
    assert_ne!(built_in, mine);
}

/// An install made by 0.1.4 — its shipped files, a `tmuxy.conf` from its
/// template with the user's settings and the stale blocks older upgrades left,
/// a menu state — migrates on the first launch: every setting survives, the
/// stale blocks are gone, the original is kept as `tmuxy.conf.bak`, the state
/// moves to the state dir, the app's files leave the config dir, and a second
/// launch changes nothing.
#[test]
fn an_install_from_0_1_4_migrates_with_no_lost_settings() {
    let s = Scratch::new("migrate");
    let original = format!("{V014_CONF}{USER_SETTINGS}{CTRL_TAB_BLOCK}{CTRL_HJKL_BLOCK}");
    s.write("tmuxy.conf", &original);
    s.write("tmuxy.defaults.conf", V014_DEFAULTS);
    s.write("tmuxy.essentials.conf", V014_ESSENTIALS);
    s.write("tmuxy.user.conf", V014_USER_CONF_BRIDGE);
    s.write("README.md", V014_README);
    let nord = BUNDLED_THEMES
        .iter()
        .find(|(n, _)| *n == "nord.css")
        .unwrap()
        .1;
    s.write(
        "themes/nord.css",
        &format!("{OLD_BUILT_IN_THEME_HEADER}{nord}"),
    );
    s.write("themes/mine.css", ":root.theme-dark { --a: 1 }\n");
    s.write("custom.css", ":root { --x: 1 }\n");
    s.write("bin/tmuxy-cli", "#!/usr/bin/env bash\n");
    s.write("bin/tmuxy/nav", "#!/usr/bin/env bash\n");
    s.write("bin/tmuxy/queue-push", "#!/usr/bin/env bash\n");
    let state = "{\n  \"theme\": \"dracula\",\n  \"theme_mode\": \"light\",\n  \"cursor_blink\": false,\n  \"use_tmux_conf\": true\n}\n";
    s.write("tmuxy.state.json", state);
    s.write("launcher", "/opt/tmuxy/tmuxy\n");
    s.write(
        "trace.json",
        "{\n  \"enabled\": true,\n  \"level\": \"shape\"\n}\n",
    );
    s.write("servers.json", "[]\n");

    s.launch();

    assert_eq!(
        names(&s.layout.config),
        [
            "custom.css",
            "themes/mine.css",
            "tmuxy.conf",
            "tmuxy.conf.bak"
        ]
    );
    assert_eq!(read(&s.layout.config.join("tmuxy.conf.bak")), original);

    let migrated = read(&s.layout.user_conf());
    assert!(migrated.starts_with(DEFAULT_USER_CONF));
    for stale in [
        "# Tmuxy User Configuration",
        "tmuxy.defaults.conf",
        "added by tmuxy upgrade",
        "Your customizations below",
        "bind -n C-",
    ] {
        assert!(!migrated.contains(stale), "{stale:?} survived:\n{migrated}");
    }
    // Every setting the user wrote is there, in order; what went is what the
    // defaults ship word for word.
    assert_eq!(
        settings(&migrated),
        settings(USER_SETTINGS),
        "the settings changed:\n{migrated}"
    );
    let defaults = read(&s.layout.data.join("tmuxy.defaults.conf"));
    for dropped in settings(CTRL_TAB_BLOCK)
        .into_iter()
        .chain(settings(CTRL_HJKL_BLOCK))
    {
        assert!(defaults.lines().any(|l| l.trim() == dropped), "{dropped}");
    }

    assert_eq!(read(&s.layout.state_file()), state);
    let managed = read_managed_state_in(&s.layout);
    assert_eq!(managed.theme.as_deref(), Some("dracula"));
    assert_eq!(managed.theme_mode.as_deref(), Some("light"));
    assert_eq!(managed.cursor_blink, Some(false));
    for name in ["launcher", "trace.json", "servers.json"] {
        assert!(s.layout.state.join(name).exists(), "{name}");
    }
    assert_eq!(read(&s.layout.state.join("launcher")), "/opt/tmuxy/tmuxy\n");

    // `use_tmux_conf` came across, so the chain reads ~/.tmux.conf, between
    // the defaults and the user's file.
    let entry = read(&s.layout.entry_conf());
    let at = |needle: &str| {
        entry
            .find(needle)
            .unwrap_or_else(|| panic!("{needle}:\n{entry}"))
    };
    assert!(at("tmuxy.essentials.conf") < at("tmuxy.defaults.conf"));
    assert!(at("tmuxy.defaults.conf") < at(".tmux.conf'"));
    assert!(at(".tmux.conf'") < at("tmuxy.conf'"));
    assert!(at("tmuxy.conf'") < entry.rfind("tmuxy.essentials.conf").unwrap());

    let config_after = tree(&s.layout.config);
    let state_after = tree(&s.layout.state);
    s.launch();
    assert_eq!(
        tree(&s.layout.config),
        config_after,
        "a second launch migrated again"
    );
    assert_eq!(tree(&s.layout.state), state_after);
}

/// A `tmuxy.conf` symlinked from a dotfiles repo that still sources the old
/// defaults keeps working: tmuxy does not rewrite it, it sources a copy with
/// that line commented out, and the copy goes once the user drops the line.
#[cfg(unix)]
#[test]
fn a_linked_tmuxy_conf_with_the_old_source_line_keeps_working() {
    let s = Scratch::new("compat");
    let dotfile = s.root.join("dotfiles").join("tmuxy.conf");
    std::fs::create_dir_all(dotfile.parent().unwrap()).unwrap();
    let text = format!("{V014_CONF}\nset -g @tmuxy-theme nord\n");
    std::fs::write(&dotfile, &text).unwrap();
    symlink(&dotfile, &s.layout.user_conf());
    s.write("tmuxy.defaults.conf", V014_DEFAULTS);

    s.launch();

    assert_eq!(read(&dotfile), text);
    assert!(!s.layout.config.join("tmuxy.conf.bak").exists());
    let compat = s.layout.data.join("tmuxy.compat.conf");
    let entry = read(&s.layout.entry_conf());
    assert!(entry.contains(&format!("source-file -q '{}'", compat.display())));
    let copy = read(&compat);
    assert!(copy.contains(
        "# tmuxy sources its defaults itself now: source-file ~/.config/tmuxy/tmuxy.defaults.conf"
    ));
    assert!(copy.contains("\nset -g @tmuxy-theme nord\n"));
    assert_eq!(pinned_options_in(&read(&dotfile)), ["@tmuxy-theme"]);

    std::fs::write(&dotfile, "set -g @tmuxy-theme nord\n").unwrap();
    s.launch();
    assert!(!compat.exists());
    assert!(read(&s.layout.entry_conf()).contains(&format!(
        "source-file -q '{}'",
        s.layout.user_conf().display()
    )));
}

/// The starter `tmuxy.conf` is written on the very first run only: not once
/// the user deleted it, and never through a link, dangling or not.
#[cfg(unix)]
#[test]
fn the_starter_conf_is_written_on_the_first_run_only() {
    let s = Scratch::new("starter");
    s.launch();
    assert_eq!(read(&s.layout.user_conf()), DEFAULT_USER_CONF);
    assert!(pinned_options_in(DEFAULT_USER_CONF).is_empty());
    std::fs::remove_file(s.layout.user_conf()).unwrap();
    s.launch();
    assert!(!s.layout.user_conf().exists());

    // Dotfiles not cloned yet: the config dir is a dangling link.
    let linked = Scratch::new("starter-dangling-dir");
    let missing = linked.root.join("dotfiles-not-cloned");
    symlink(&missing, &linked.layout.config);
    linked.launch();
    assert!(!missing.exists());

    // A real config dir whose tmuxy.conf is a dangling link.
    let file = Scratch::new("starter-dangling-file");
    let target = file.root.join("dotfiles").join("tmuxy.conf");
    symlink(&target, &file.layout.user_conf());
    file.launch();
    assert!(!target.exists());
    assert!(std::fs::symlink_metadata(file.layout.user_conf()).is_ok());
}

/// The data dir's files are generated: headed so, read-only (scripts
/// executable), pointed at where the data dir really is, and never written
/// through a link — the devcontainer links them to the repo's copies.
#[cfg(unix)]
#[test]
fn the_mirror_is_marked_generated_and_skips_a_link() {
    use std::os::unix::fs::PermissionsExt;
    let s = Scratch::new("mirror");
    let repo_copy = s.root.join("repo").join("tmuxy.defaults.conf");
    std::fs::create_dir_all(repo_copy.parent().unwrap()).unwrap();
    std::fs::write(&repo_copy, "# the repo's\n").unwrap();
    symlink(&repo_copy, &s.layout.data.join("tmuxy.defaults.conf"));

    s.launch();

    assert_eq!(read(&repo_copy), "# the repo's\n");
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let essentials = s.layout.data.join("tmuxy.essentials.conf");
    assert!(read(&essentials).starts_with("# Generated by tmuxy"));
    assert_eq!(mode(&essentials), 0o444);
    let nav = s.layout.bin().join("tmuxy").join("nav");
    assert_eq!(mode(&nav), 0o555);
    assert!(read(&nav)
        .lines()
        .nth(1)
        .unwrap()
        .starts_with("# Generated by tmuxy"));
    let relocated = format!("bash {}/bin/tmuxy/nav left", s.layout.data.display());
    assert!(read(&essentials).contains(&relocated));
    assert!(!read(&essentials).contains("$HOME/.local/share/tmuxy"));
    // A second launch replaces nothing it has no reason to.
    let before = tree(&s.layout.data);
    s.launch();
    assert_eq!(tree(&s.layout.data), before);
}

/// The old header goes line for line; a comment the user wrote right under
/// it, or one in a file that has nothing but comments past the template, is
/// theirs and stays.
#[test]
fn the_old_header_goes_and_the_users_comments_under_it_stay() {
    let notes = "# C-Space is for tmux, C-a for the shell\n# set -g @tmuxy-theme nord\n";
    let conf = V014_CONF.replacen("via the UI).\n", &format!("via the UI).\n{notes}"), 1);
    assert_ne!(conf, V014_CONF);
    let (cleaned, blocks) = clean_user_conf(&conf);
    assert_eq!(
        blocks,
        [
            StaleBlock::OldHeader,
            StaleBlock::DefaultsSourceLine,
            StaleBlock::ExamplesBlock
        ]
    );
    assert_eq!(cleaned, format!("{DEFAULT_USER_CONF}\n{notes}"));
    assert!(!cleaned.contains("Tmuxy User Configuration"));

    let header = V014_CONF.split("\n\n").next().unwrap();
    let (cleaned, blocks) = clean_user_conf(&format!("{header}\n\n{notes}"));
    assert_eq!(blocks, [StaleBlock::OldHeader]);
    assert_eq!(cleaned, format!("{DEFAULT_USER_CONF}\n{notes}"));

    let edited = conf.replacen("# Tmuxy never overwrites", "# I overwrite", 1);
    let (cleaned, blocks) = clean_user_conf(&edited);
    assert!(
        !blocks.contains(&StaleBlock::OldHeader),
        "an edited header is the user's"
    );
    assert!(cleaned.contains("# I overwrite") && cleaned.contains(notes));
}

#[test]
fn a_conf_with_nothing_stale_is_left_as_it_is() {
    let conf = "set -g prefix C-Space\nbind -n C-Tab next-window\n";
    assert_eq!(clean_user_conf(conf), (conf.to_string(), Vec::new()));
    assert_eq!(clean_user_conf(DEFAULT_USER_CONF).1, Vec::new());
}

/// A binding the defaults ship goes only when nothing else in the file binds
/// or unbinds the same key: after an `unbind -n C-h`, the restore is what
/// makes Ctrl+H navigate, and dropping it would change the key.
#[test]
fn a_restored_binding_stays_when_the_file_also_unbinds_the_key() {
    let conf = format!("unbind -n C-h{CTRL_HJKL_BLOCK}");
    let (cleaned, blocks) = clean_user_conf(&conf);
    assert!(!blocks.contains(&StaleBlock::CtrlHjklRestore));
    assert_eq!(cleaned, conf);

    let (cleaned, blocks) = clean_user_conf(&format!("{V014_CONF}{CTRL_TAB_BLOCK}"));
    assert_eq!(
        blocks,
        [
            StaleBlock::OldHeader,
            StaleBlock::DefaultsSourceLine,
            StaleBlock::ExamplesBlock,
            StaleBlock::CtrlTabUpgrade
        ]
    );
    assert_eq!(cleaned, DEFAULT_USER_CONF);
}
