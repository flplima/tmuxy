use std::path::{Path, PathBuf};

use super::doctor::{commented_out, dead_sources_in, fix, DeadSource, DOCTOR_HINT, FIX_MARK};
use crate::paths::Layout;

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("tmuxy-doctor-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn lines(dead: &[DeadSource]) -> Vec<(usize, &str, &Path)> {
    dead.iter()
        .map(|d| (d.line, d.written.as_str(), d.target.as_path()))
        .collect()
}

/// Every spelling of a missing target is reported with its line, as
/// written and as resolved; a target that is there, a `-q` source tmux
/// itself forgives, a comment and a path tmux works out at run time are not.
#[test]
fn the_scanner_reports_each_dead_source_by_line_and_nothing_else() {
    let home = scratch("scan");
    std::fs::create_dir_all(home.join(".config/tmuxy")).unwrap();
    std::fs::write(home.join(".config/tmuxy/present.conf"), "").unwrap();
    let conf = format!(
        "# source-file ~/.config/tmuxy/commented.conf\n\
         set -g prefix C-a\n\
         source-file ~/.config/tmuxy/tmuxy.defaults.conf\n\
         source-file -q ~/.config/tmuxy/quiet.conf\n\
         source '{home}/.config/tmuxy/present.conf'\n\
         source-file \"{home}/.config/tmuxy/gone two.conf\"\n\
         source-file $HOME/.config/tmuxy/env.conf\n\
         source-file ~/.config/tmuxy/*.conf\n\
         source-file $XDG_CONFIG_HOME/tmuxy/unknown.conf\n\
         source-file relative.conf\n\
         bind r source-file ~/.config/tmuxy/bound.conf\n\
         if-shell true {{ source-file ~/.config/tmuxy/in-block.conf }}\n\
         set -g status on ; source-file -v '~/.config/tmuxy/after.conf'\n",
        home = home.display()
    );
    let dead = dead_sources_in(&conf, Path::new("/c/tmuxy.conf"), &home);
    let defaults = home.join(".config/tmuxy/tmuxy.defaults.conf");
    let gone = home.join(".config/tmuxy/gone two.conf");
    let env = home.join(".config/tmuxy/env.conf");
    let after = home.join(".config/tmuxy/after.conf");
    assert_eq!(
        lines(&dead),
        [
            (3, "~/.config/tmuxy/tmuxy.defaults.conf", defaults.as_path()),
            (6, gone.to_str().unwrap(), gone.as_path()),
            (7, "$HOME/.config/tmuxy/env.conf", env.as_path()),
            (13, "~/.config/tmuxy/after.conf", after.as_path()),
        ]
    );
    assert!(dead.iter().all(|d| d.file == Path::new("/c/tmuxy.conf")));
    assert_eq!(
        dead[0].to_string(),
        format!(
            "/c/tmuxy.conf:3: source-file ~/.config/tmuxy/tmuxy.defaults.conf: {} does not exist",
            defaults.display()
        )
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// The fix comments a dead line out in place behind the doctor's mark, keeps
/// every other line and the line count, backs the file up beside itself
/// first, and a second pass finds nothing and writes nothing.
#[test]
fn the_fix_comments_dead_lines_out_with_a_backup_and_leaves_a_clean_file_alone() {
    let root = scratch("fix");
    let home = root.join("home");
    let layout = Layout {
        config: home.join(".config/tmuxy"),
        data: root.join("data"),
        state: root.join("state"),
        home: home.clone(),
    };
    std::fs::create_dir_all(&layout.config).unwrap();
    let conf =
        "set -g prefix C-a\nsource-file ~/.config/tmuxy/tmuxy.defaults.conf\nset -g mouse on\n";
    std::fs::write(layout.user_conf(), conf).unwrap();

    let fixed = fix(&layout).unwrap();
    assert_eq!(fixed.fixed.len(), 1);
    assert_eq!(fixed.fixed[0].line, 2);
    let backup = fixed.backup.clone().expect("a backup beside the file");
    assert!(backup
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("tmuxy.conf.bak-"));
    assert_eq!(backup.parent(), Some(layout.config.as_path()));
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), conf);
    let after = std::fs::read_to_string(layout.user_conf()).unwrap();
    assert_eq!(
        after,
        format!(
            "set -g prefix C-a\n{FIX_MARK}{} does not exist: source-file ~/.config/tmuxy/tmuxy.defaults.conf\nset -g mouse on\n",
            home.join(".config/tmuxy/tmuxy.defaults.conf").display()
        )
    );
    assert!(dead_sources_in(&after, &layout.user_conf(), &home).is_empty());

    let again = fix(&layout).unwrap();
    assert_eq!(again.backup, None);
    assert!(again.fixed.is_empty());
    assert_eq!(std::fs::read_to_string(layout.user_conf()).unwrap(), after);
    assert_eq!(
        std::fs::read_dir(&layout.config).unwrap().count(),
        2,
        "one conf, one backup"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Two dead targets on one line share its comment; a file with no final
/// newline keeps not having one.
#[test]
fn a_line_with_two_dead_targets_is_commented_once() {
    let dead = |line: usize, target: &str| DeadSource {
        file: PathBuf::from("/c/tmuxy.conf"),
        line,
        written: target.to_string(),
        target: PathBuf::from(target),
    };
    assert_eq!(
        commented_out(
            "source-file /a /b\nset -g x 1",
            &[dead(1, "/a"), dead(1, "/b")]
        ),
        format!("{FIX_MARK}/a, /b do not exist: source-file /a /b\nset -g x 1")
    );
    assert!(DOCTOR_HINT.contains("tmuxy config doctor --fix"));
}
