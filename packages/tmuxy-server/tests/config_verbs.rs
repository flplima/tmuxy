//! `tmuxy config check` and `tmuxy config reload` against a real tmux: what
//! they print and exit with is the CLI's contract, and neither needs a tmux
//! server of the user's, since a check asks one it starts itself.
//!
//! Needs a `tmux` binary. Every tmux these verbs run is on a socket inside
//! the test's own directory.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::{Command, Output};

#[path = "common/verb.rs"]
mod verb;
use verb::{stderr, stdout, verb_in};

/// A home of its own for the config verbs that need no tmux server of the
/// user's: `config check` and `config reload` ask a tmux they start.
struct ConfigHome {
    home: std::path::PathBuf,
}

impl ConfigHome {
    fn new(name: &str) -> Self {
        let home =
            std::env::temp_dir().join(format!("tmuxy-cli-verbs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("config/tmuxy")).unwrap();
        // As an install has them: the state dir, and tmuxy's essentials in
        // the data dir, which a check loads for the aliases a config may use.
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::create_dir_all(home.join("data/tmuxy")).unwrap();
        std::fs::write(
            home.join("data/tmuxy/tmuxy.essentials.conf"),
            include_str!("../../tmuxy-core/assets/tmuxy.essentials.conf"),
        )
        .unwrap();
        Self { home }
    }

    /// What a check left behind: its files in the state dir, and any tmux
    /// server still running on a socket under this home.
    fn left_by_a_check(&self) -> Vec<String> {
        let mut left: Vec<String> = std::fs::read_dir(self.home.join("state"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("tmuxy-check-"))
            .collect();
        let ps = Command::new("ps").args(["-eo", "args"]).output().unwrap();
        let home = self.home.display().to_string();
        left.extend(
            String::from_utf8_lossy(&ps.stdout)
                .lines()
                .filter(|line| line.contains(&home) && line.contains("tmuxy-check-"))
                .map(String::from),
        );
        left
    }

    fn conf(&self) -> std::path::PathBuf {
        self.home.join("config/tmuxy/tmuxy.conf")
    }

    fn write(&self, rel: &str, contents: &str) -> std::path::PathBuf {
        let path = self.home.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn verb(&self, args: &[&str]) -> Output {
        verb_in(&self.home, "tmuxy-cli-verbs-config-unused", None, args)
    }

    /// The marker `config reload` touches, when it has.
    fn reload_requested(&self) -> bool {
        self.home.join("state/config-reload").exists()
    }
}

impl Drop for ConfigHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

/// The promise of `config check`: a typo is reported with its file and line,
/// by tmux's own reading of the file, and nothing in the file runs.
#[test]
fn config_check_reports_each_problem_with_its_file_and_line_and_applies_nothing() {
    let h = ConfigHome::new("check");
    let ran = h.home.join("ran");
    let extra = h.write("extra.conf", "bind x display hi\nset -g staus-left hi\n");
    std::fs::write(
        h.conf(),
        format!(
            "set -g mouse on\n\
             set -g staus off\n\
             run-shell 'touch {ran}'\n\
             setw -g mode-k vi\n\
             source-file ~/extra.conf\n\
             source-file ~/gone.conf\n\
             set -g @anything goes\n\
             bindd y display hi\n",
            ran = ran.display()
        ),
    )
    .unwrap();

    let out = h.verb(&["config", "check"]);
    assert_eq!(out.status.code(), Some(1), "{}", stdout(&out));
    let conf = h.conf().display().to_string();
    let said = stderr(&out);
    let lines: Vec<&str> = said.lines().collect();
    assert_eq!(
        lines,
        [
            "Error: 4 problem(s) in the config".to_string(),
            format!("{conf}:2: invalid option: staus"),
            format!(
                "{conf}:6: source-file ~/gone.conf: {} does not exist",
                h.home.join("gone.conf").display()
            ),
            format!("{conf}:8: unknown command: bindd"),
            format!("{}:2: invalid option: staus-left", extra.display()),
        ],
        "{said}"
    );
    // Parsed, never run: the file's own command left no mark, and the tmux
    // that read it is gone, with its socket. The essentials it loaded turn
    // `exit-empty` off, which once left that server running for good.
    assert!(!ran.exists());
    assert_eq!(h.left_by_a_check(), Vec::<String>::new());

    let json = h.verb(&["config", "check", "--json"]);
    assert_eq!(json.status.code(), Some(1));
    let answer: serde_json::Value = serde_json::from_str(&stdout(&json)).unwrap();
    assert_eq!(answer["ok"], false);
    assert_eq!(
        answer["files"],
        serde_json::json!([conf, extra.display().to_string()])
    );
    assert_eq!(
        answer["problems"][0],
        serde_json::json!({
            "file": conf,
            "line": 2,
            "kind": "option",
            "message": "invalid option: staus"
        })
    );
    assert_eq!(answer["problems"].as_array().unwrap().len(), 4);
}

#[test]
fn config_check_passes_a_clean_config_a_named_file_and_no_config_at_all() {
    let h = ConfigHome::new("check-clean");
    let none = h.verb(&["config", "check"]);
    assert_eq!(none.status.code(), Some(0), "{}", stderr(&none));
    assert!(stdout(&none).contains("No config to check"));

    std::fs::write(
        h.conf(),
        "set -g mouse on\nsetw -g mode-keys vi\nset -g @tmuxy-theme nord\nbind x display hi\n%if #{==:a,a}\nset -g status off\n%endif\n",
    )
    .unwrap();
    let clean = h.verb(&["config", "check"]);
    assert_eq!(clean.status.code(), Some(0), "{}", stderr(&clean));
    assert!(stdout(&clean).contains("Nothing wrong in 1 file(s)"));

    // A branch that does not run on this machine is not this machine's
    // problem: an option only a newer tmux has behind a version guard, a
    // file sourced on another host. tmux's own parse still reads the block.
    std::fs::write(
        h.conf(),
        "set -g mouse on\n\
         %if #{==:#{host},some-other-machine}\n\
         set -g option-of-another-tmux on\n\
         source-file ~/only-over-there.conf\n\
         %endif\n",
    )
    .unwrap();
    let guarded = h.verb(&["config", "check"]);
    assert_eq!(guarded.status.code(), Some(0), "{}", stderr(&guarded));
    let reloaded = h.verb(&["config", "reload"]);
    assert_eq!(reloaded.status.code(), Some(0), "{}", stderr(&reloaded));
    assert_eq!(h.left_by_a_check(), Vec::<String>::new());

    // A file of the caller's choosing, wherever it is; the user's own
    // tmuxy.conf is not read then.
    std::fs::write(h.conf(), "bindd x display hi\n").unwrap();
    let other = h.write(
        "elsewhere/my.conf",
        "set -g mouse on\nset -g  history-limt 5\n",
    );
    let named = h.verb(&["config", "check", &other.display().to_string()]);
    assert_eq!(named.status.code(), Some(1));
    assert_eq!(
        stderr(&named).lines().collect::<Vec<_>>(),
        [
            "Error: 1 problem(s) in the config".to_string(),
            format!("{}:2: invalid option: history-limt", other.display()),
        ]
    );

    let missing = h.verb(&["config", "check", "/no/such/file.conf"]);
    assert_eq!(missing.status.code(), Some(1));
    assert!(stderr(&missing).contains("/no/such/file.conf is not a file"));
}

/// A reload starts by putting tmuxy's defaults back: with a file tmux then
/// cannot read, the user's own settings are gone from the session they are
/// in. So a broken file is not reloaded at all.
#[test]
fn config_reload_is_refused_while_tmux_cannot_parse_the_config() {
    let h = ConfigHome::new("reload");
    std::fs::write(h.conf(), "set -g prefix C-x\nbind y { display unclosed\n").unwrap();

    let refused = h.verb(&["config", "reload"]);
    assert_eq!(refused.status.code(), Some(1), "{}", stdout(&refused));
    let said = stderr(&refused);
    assert!(
        said.contains("not reloaded, the running config is kept"),
        "{said}"
    );
    assert!(said.contains(&format!("{}:", h.conf().display())), "{said}");
    assert!(!h.reload_requested());

    let json = h.verb(&["config", "reload", "--json"]);
    let answer: serde_json::Value = serde_json::from_str(&stdout(&json)).unwrap();
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["problems"].as_array().unwrap().len(), 1);
    assert!(!h.reload_requested());

    // An option tmux does not have, or a file that is not there, is what
    // `check` reports and tmux says again as it runs the file, carrying on
    // with the rest: not a reason to keep the whole file from loading.
    std::fs::write(
        h.conf(),
        "set -g prefix C-x\nset -g staus off\nsource-file ~/gone.conf\n",
    )
    .unwrap();
    let checked = h.verb(&["config", "check"]);
    assert_eq!(checked.status.code(), Some(1));
    let reloaded = h.verb(&["config", "reload"]);
    assert_eq!(reloaded.status.code(), Some(0), "{}", stderr(&reloaded));
    assert!(h.reload_requested());
    std::fs::remove_file(h.home.join("state/config-reload")).unwrap();

    std::fs::write(h.conf(), "set -g prefix C-x\nbind y display closed\n").unwrap();
    let reloaded = h.verb(&["config", "reload"]);
    assert_eq!(reloaded.status.code(), Some(0), "{}", stderr(&reloaded));
    assert!(h.reload_requested());
    assert_eq!(h.left_by_a_check(), Vec::<String>::new());
}
