use std::path::{Path, PathBuf};

use super::keymap::*;
use crate::paths::Layout;

struct Scratch {
    root: PathBuf,
    layout: Layout,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("tmuxy-keymap-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let layout = Layout {
            config: home.join(".config").join("tmuxy"),
            data: root.join("data"),
            state: root.join("state"),
            home,
        };
        std::fs::create_dir_all(&layout.config).unwrap();
        Self { root, layout }
    }

    fn write(&self, path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn defaults(&self) -> PathBuf {
        self.layout.path(&crate::paths::DEFAULTS_CONF)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn bound<'a>(map: &'a Keymap, table: &str, key: &str) -> &'a Binding {
    map.bindings
        .iter()
        .find(|binding| binding.table == table && binding.key == key)
        .unwrap_or_else(|| panic!("{table} {key} is not bound"))
}

/// The line of the shipped defaults a statement is on, so no test pins a
/// number an edit to that file would move.
fn defaults_line(statement: &str) -> usize {
    let text = include_str!("../../assets/tmuxy.defaults.conf");
    1 + text
        .lines()
        .position(|line| line == statement)
        .unwrap_or_else(|| panic!("the defaults have no line {statement:?}"))
}

/// The question the keymap is for: where does `prefix t` come from? With no
/// file of the user's, from tmuxy's defaults, at the line that binds it.
#[test]
fn the_shipped_chain_says_where_each_of_its_keys_comes_from() {
    let s = Scratch::new("shipped");
    let map = keymap(&s.layout);

    let tab = bound(&map, "prefix", "t");
    assert_eq!(tab.command, "switch-client -T tab");
    assert_eq!(
        tab.source,
        Source {
            layer: Layer::Defaults,
            file: Some(s.defaults()),
            line: Some(defaults_line("bind t switch-client -T tab")),
        }
    );
    assert_eq!(
        tab.source.to_string(),
        format!("{}:{}", s.defaults().display(), tab.source.line.unwrap())
    );

    // A named table, a key with no prefix, a repeating key, and keys that
    // are tmux syntax and come quoted or escaped.
    assert_eq!(bound(&map, "tab", "x").command, "kill-window");
    assert_eq!(bound(&map, "root", "C-h").command, "tmuxy-nav-left");
    assert!(bound(&map, "prefix", "H").repeat);
    assert!(bound(&map, "prefix", "\"")
        .command
        .starts_with("split-window -v"));
    assert!(bound(&map, "prefix", "\\")
        .command
        .starts_with("split-window -h"));
    assert!(bound(&map, "prefix", "-")
        .command
        .starts_with("split-window -v"));

    let prefix = map.prefix.as_ref().unwrap();
    assert_eq!(prefix.key, "C-a");
    assert_eq!(prefix.source.line, Some(defaults_line("set -g prefix C-a")));
    // Nothing of the user's is in play, so nothing is news.
    assert_eq!(map.notable_shadows().count(), 0);
    assert_eq!(map.warnings, Vec::<String>::new());
}

/// The user's files are applied after tmuxy's defaults: what they rebind or
/// unbind is theirs, the binding that lost is kept to be shown, and a file
/// they source counts as theirs under its own name.
#[test]
fn the_users_lines_win_and_what_they_replace_is_remembered() {
    let s = Scratch::new("users");
    let conf = s.layout.user_conf();
    let extra = s.layout.home.join("keys.conf");
    s.write(
        &conf,
        "# mine\n\
         bind c new-window -c ~\n\
         unbind %\n\
         source-file ~/keys.conf\n\
         bind -T tab q {\n\
           kill-window\n\
         }\n\
         bind-key -r -T prefix \\\n\
           M-x resize-pane -Z\n",
    );
    s.write(
        &extra,
        "bind -n F12 display-message hi\nbind t display-message mine\n",
    );

    let map = keymap(&s.layout);
    let mine = |line| Source {
        layer: Layer::UserConf,
        file: Some(conf.clone()),
        line: Some(line),
    };
    assert_eq!(bound(&map, "prefix", "c").source, mine(2));
    assert_eq!(bound(&map, "prefix", "c").command, "new-window -c ~");
    assert!(!map
        .bindings
        .iter()
        .any(|binding| binding.table == "prefix" && binding.key == "%"));
    // A block and a continued line are one binding each, at their first line.
    assert_eq!(bound(&map, "tab", "q").source, mine(5));
    let zoom = bound(&map, "prefix", "M-x");
    assert_eq!((zoom.source.clone(), zoom.repeat), (mine(8), true));
    // The sourced file's lines carry its own path, as the user's layer.
    let sourced = bound(&map, "prefix", "t");
    assert_eq!(sourced.source.file.as_deref(), Some(extra.as_path()));
    assert_eq!(sourced.source.layer, Layer::UserConf);
    assert_eq!(bound(&map, "root", "F12").source.line, Some(1));

    let news: Vec<String> = map
        .notable_shadows()
        .map(|shadow| {
            format!(
                "{} {} {} {}",
                shadow.lost.table,
                shadow.lost.key,
                if shadow.rebound { "rebound" } else { "unbound" },
                shadow.by.line.unwrap()
            )
        })
        .collect();
    assert_eq!(
        news,
        [
            "prefix c rebound 2",
            "prefix % unbound 3",
            "prefix t rebound 2"
        ]
    );
    let lost = map.notable_shadows().next().unwrap();
    assert_eq!(lost.lost.source.layer, Layer::Defaults);
    assert_eq!(
        lost.lost.source.line,
        Some(defaults_line(
            "bind c new-window -c \"#{pane_current_path}\""
        ))
    );
}

/// tmux looks for the prefix before the root table, so a key bound without
/// the prefix that IS the prefix never runs: said, with both lines.
#[test]
fn a_key_that_is_the_prefix_and_bound_without_it_is_warned_about() {
    let s = Scratch::new("prefix");
    let conf = s.layout.user_conf();
    s.write(
        &conf,
        "set -g prefix C-Space\nbind -n C-Space display-message never\n",
    );
    let map = keymap(&s.layout);
    assert_eq!(map.prefix.as_ref().unwrap().key, "C-Space");
    assert_eq!(
        map.warnings,
        [format!(
            "C-Space is the prefix ({conf}:1) and is also bound without it ({conf}:2): tmux reads the prefix first, so `display-message never` never runs",
            conf = conf.display()
        )]
    );
}

/// `~/.tmux.conf` is a layer only when the chain sources it.
#[test]
fn tmux_conf_counts_only_when_it_is_sourced() {
    let s = Scratch::new("tmuxconf");
    s.write(
        &s.layout.home.join(".tmux.conf"),
        "bind F7 display-message old\n",
    );
    let without = keymap(&s.layout);
    assert!(!without.bindings.iter().any(|binding| binding.key == "F7"));

    super::state::write_managed_state_in(
        &s.layout,
        super::ManagedState {
            use_tmux_conf: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let with = keymap(&s.layout);
    assert_eq!(bound(&with, "prefix", "F7").source.layer, Layer::TmuxConf);
}

/// What tmux binds by itself is in its listing and in no file: added as
/// tmux's, and never over a key a file accounts for.
#[test]
fn a_servers_own_bindings_are_added_as_tmuxs() {
    let s = Scratch::new("live");
    let mut map = keymap(&s.layout);
    let listed = |key: &str, command: &str| Binding {
        table: "prefix".to_string(),
        key: key.to_string(),
        command: command.to_string(),
        repeat: false,
        source: Source::tmux(),
    };
    map.add_unattributed([listed("d", "detach-client"), listed("t", "clock-mode")]);
    let detach = bound(&map, "prefix", "d");
    assert_eq!(detach.source.layer, Layer::Tmux);
    assert_eq!(detach.source.to_string(), "tmux");
    assert_eq!(bound(&map, "prefix", "t").source.layer, Layer::Defaults);

    map.only_table("tab");
    assert!(map.bindings.iter().all(|binding| binding.table == "tab"));
    assert!(!map.bindings.is_empty());
}
