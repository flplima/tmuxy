use std::path::{Path, PathBuf};

use super::check::*;
use super::state::write_managed_state_in;
use super::ManagedState;
use crate::paths::Layout;

struct Scratch {
    root: PathBuf,
    layout: Layout,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("tmuxy-check-{name}-{}", std::process::id()));
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
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// With no file named, a check reads the user's part of the chain: their
/// `tmuxy.conf`, their `~/.tmux.conf` only when the chain sources it, and
/// what those source in turn. A file that sources itself ends the walk.
#[test]
fn a_check_reads_the_users_files_and_what_they_source() {
    let s = Scratch::new("files");
    let extra = s.layout.home.join("extra.conf");
    let keys = s.layout.home.join("keys.conf");
    let tmux_conf = s.layout.home.join(".tmux.conf");
    s.write(
        &s.layout.user_conf(),
        "set -g mouse on\nsource-file ~/extra.conf\nsource-file -q ~/missing.conf\nsource -F '#{d:x}/a.conf'\n",
    );
    s.write(
        &extra,
        "source-file $HOME/keys.conf\nsource-file ~/extra.conf\n",
    );
    s.write(&keys, "bind x display hi\n");
    s.write(&tmux_conf, "set -g prefix C-x\n");

    assert_eq!(
        checked_files(&s.layout, None),
        [s.layout.user_conf(), extra.clone(), keys.clone()]
    );

    write_managed_state_in(
        &s.layout,
        ManagedState {
            use_tmux_conf: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        checked_files(&s.layout, None),
        [tmux_conf, s.layout.user_conf(), extra.clone(), keys.clone()]
    );

    // A named file is checked with what it sources, and nothing else.
    assert_eq!(checked_files(&s.layout, Some(&extra)), [extra, keys]);
}

#[test]
fn no_config_is_nothing_to_check() {
    let s = Scratch::new("none");
    assert!(checked_files(&s.layout, None).is_empty());
}

#[test]
fn a_problem_reads_as_file_line_message() {
    let problem = ConfigProblem {
        file: PathBuf::from("/c/tmuxy.conf"),
        line: Some(7),
        kind: ProblemKind::Parse,
        message: "unknown command: bindd".to_string(),
    };
    assert_eq!(
        problem.to_string(),
        "/c/tmuxy.conf:7: unknown command: bindd"
    );
    let unplaced = ConfigProblem {
        line: None,
        ..problem.clone()
    };
    assert_eq!(
        unplaced.to_string(),
        "/c/tmuxy.conf: unknown command: bindd"
    );

    assert_eq!(refusal(&[]), None);
    assert_eq!(
        refusal(std::slice::from_ref(&problem)).unwrap(),
        "config not reloaded, the running one is kept: /c/tmuxy.conf:7: unknown command: bindd; run: tmuxy config check"
    );
    assert!(refusal(&[problem.clone(), unplaced])
        .unwrap()
        .contains("bindd (and 1 more); run:"));
}

/// A line-by-line reading cannot tell which branch of a `%if` runs on this
/// machine. A guard for a newer tmux's option, or a file sourced only on
/// another host, must not be called a problem here.
#[test]
fn lines_inside_a_conditional_are_left_to_tmuxs_own_parse() {
    let conf = "set -g mouse on\n\
                %if #{>=:#{version},9.9}\n\
                set -g option-of-a-newer-tmux on\n\
                %if #{==:#{host},elsewhere}\n\
                set -g another-one on\n\
                %endif\n\
                %else\n\
                set -g staus off\n\
                %endif\n\
                set -g staus-left x\n";
    assert_eq!(
        conditional_lines(conf).into_iter().collect::<Vec<_>>(),
        (2..=9).collect::<Vec<_>>()
    );
    assert_eq!(options_set(conf), [(1, "mouse"), (10, "staus-left")]);
}

#[test]
fn what_tmux_prints_about_a_file_is_read_as_its_parse_errors() {
    let file = Path::new("/c/tmuxy.conf");
    let said = "/c/tmuxy.conf:3: unknown command: bindd\n/other.conf:1: not this file\nnoise\n";
    assert_eq!(
        parse_errors(said, file),
        [ConfigProblem {
            file: file.to_path_buf(),
            line: Some(3),
            kind: ProblemKind::Parse,
            message: "unknown command: bindd".to_string(),
        }]
    );
}
