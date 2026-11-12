//! Nothing is ever typed into a pane waiting at a prompt: `tmuxy pane send`
//! (the `send` verb) against a real tmux, into a fake agent that writes down
//! every byte it is sent. At an approval dialog on its screen, or when the
//! pane says it needs the user, the send is refused and the agent receives
//! nothing, the sender's own pane and an allowed sender included; anywhere
//! else the keys arrive exactly as given.
//!
//! Needs a `tmux` binary; the socket is unique per process, no control-mode
//! client is attached, and nothing here answers a question.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

#[path = "../../tmuxy-core/tests/common/scratch.rs"]
mod scratch;

const DIALOG: &str = "\
● Bash(rm -rf build)
╭──────────────────────────────────────────╮
│ Bash command                              │
│   rm -rf build                            │
│ Do you want to proceed?                   │
│ ❯ 1. Yes                                  │
│   2. No, and tell Claude what to do       │
╰──────────────────────────────────────────╯
";

/// A pane running a fake agent: it draws `screen`, then writes every line it
/// is sent to its log, which is what the test reads.
struct Agent {
    pane: String,
    log: PathBuf,
}

fn agent(s: &scratch::ScratchServer, name: &str, screen: &str) -> Agent {
    let log = s.home.join(format!("{name}.log"));
    let script = s.home.join(format!("{name}.sh"));
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s' '{}'\nexec cat >> '{}'\n",
            screen.replace('\'', "'\\''"),
            log.display()
        ),
    )
    .unwrap();
    std::fs::write(&log, "").unwrap();
    let pane = s.tmux(&[
        "split-window",
        "-d",
        "-t",
        "work:0",
        "-P",
        "-F",
        "#{pane_id}",
        "sh",
        script.to_str().unwrap(),
    ]);
    // Drawn before anything is sent to it.
    // (A capture drops a line's trailing spaces.)
    let first = screen.lines().next().unwrap_or("").trim_end();
    wait_for(|| s.tmux(&["capture-pane", "-p", "-t", &pane]).contains(first));
    Agent { pane, log }
}

fn wait_for(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn send(s: &scratch::ScratchServer, caller: &str, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_tmuxy-server"))
        .arg("send")
        .args(args)
        .env("TMUX_SOCKET", &s.socket)
        .env("TMUX_PANE", caller)
        .env("HOME", &s.home)
        .env("XDG_CONFIG_HOME", s.home.join("config"))
        .env("TMUXY_STATE_DIR", s.home.join("state"))
        .env_remove("TMUX")
        .env_remove("TMUX_BIN")
        .env_remove("TMUXY_DATA_DIR")
        .output()
        .expect("tmuxy-server runs")
}

/// What the agent was sent, once nothing more is coming.
fn received(log: &Path) -> String {
    std::thread::sleep(Duration::from_millis(400));
    std::fs::read_to_string(log).unwrap()
}

fn refused(out: &Output) -> bool {
    out.status.code() == Some(1)
        && String::from_utf8_lossy(&out.stderr).contains("waiting at a prompt")
}

#[test]
fn a_pane_at_a_prompt_is_sent_nothing_whoever_sends_and_however() {
    let s = scratch::ScratchServer::with_session(
        &format!("send-at-prompt-{}", std::process::id()),
        120,
        40,
    );
    let caller = s.tmux(&["display-message", "-p", "-t", "work:0.0", "#{pane_id}"]);
    // Asking off: without the refusal, every send below would type at once.
    s.tmux(&["set-option", "-g", "@tmuxy-send-ask", "off"]);

    // An approval dialog on its screen, and no state said: refused.
    let at_dialog = agent(&s, "dialog", DIALOG);
    for args in [
        vec![
            "--target",
            &at_dialog.pane,
            "--caller-pane",
            &caller,
            "--",
            "1",
            "Enter",
        ],
        // The sender claiming the pane as its own is refused all the same.
        vec![
            "--target",
            &at_dialog.pane,
            "--caller-pane",
            &at_dialog.pane,
            "--",
            "y",
            "Enter",
        ],
        vec![
            "--target",
            &at_dialog.pane,
            "--caller-pane",
            &caller,
            "--paste",
            "--",
            "1\n",
        ],
    ] {
        let out = send(&s, &caller, &args);
        assert!(refused(&out), "{args:?}: {:?}", out);
    }
    assert_eq!(
        received(&at_dialog.log),
        "",
        "the agent at a dialog was sent keys"
    );
    // The paste that was refused left no buffer behind.
    assert!(!s
        .tmux(&["list-buffers", "-F", "#{buffer_name}"])
        .contains("tmuxy"));

    // A plain screen, but the pane says it needs the user: refused.
    let marked = agent(&s, "marked", "> ");
    s.tmux(&[
        "set-option",
        "-p",
        "-t",
        &marked.pane,
        "@tmuxy-pane-state",
        "needs-input",
    ]);
    let out = send(
        &s,
        &caller,
        &[
            "--target",
            &marked.pane,
            "--caller-pane",
            &caller,
            "--",
            "go",
            "Enter",
        ],
    );
    assert!(refused(&out), "{out:?}");
    assert_eq!(received(&marked.log), "");

    // The state taken off, the same send goes in, exactly as given: text
    // tmux and a shell would both read something into.
    s.tmux(&["set-option", "-pu", "-t", &marked.pane, "@tmuxy-pane-state"]);
    let text = r##"it's #{pane_id} ; "$HOME" `x` \ #[fg=red] ~"##;
    let out = send(
        &s,
        &caller,
        &[
            "--target",
            &marked.pane,
            "--caller-pane",
            &caller,
            "--",
            text,
            "Enter",
        ],
    );
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(received(&marked.log), format!("{text}\n"));
    assert!(s
        .tmux(&[
            "show-options",
            "-p",
            "-t",
            &marked.pane,
            "-qv",
            "@tmuxy-send-held"
        ])
        .is_empty());
}
