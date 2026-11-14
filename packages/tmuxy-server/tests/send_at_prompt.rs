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
use std::process::{Child, Command, Output, Stdio};
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

/// Poll until `ready`; the deadline only decides when a stuck wait fails,
/// and the panic names the line that waited.
#[track_caller]
fn wait_for(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn send(s: &scratch::ScratchServer, caller: &str, args: &[&str]) -> Output {
    verb(s, caller, "send")
        .args(args)
        .output()
        .expect("tmuxy-server runs")
}

/// The server binary's `verb`, on this server, from `caller`'s pane.
fn verb(s: &scratch::ScratchServer, caller: &str, verb: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tmuxy-server"));
    command
        .arg(verb)
        .env("TMUX_SOCKET", &s.socket)
        .env("TMUX_PANE", caller)
        .env("HOME", &s.home)
        .env("XDG_CONFIG_HOME", s.home.join("config"))
        .env("TMUXY_STATE_DIR", s.home.join("state"))
        .env_remove("TMUX")
        .env_remove("TMUX_BIN")
        .env_remove("TMUXY_DATA_DIR");
    command
}

/// `text` and Enter from `caller`'s pane into `pane`.
fn send_into(s: &scratch::ScratchServer, caller: &str, pane: &str, text: &str) -> Output {
    send(
        s,
        caller,
        &[
            "--target",
            pane,
            "--caller-pane",
            caller,
            "--",
            text,
            "Enter",
        ],
    )
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
    let out = send_into(&s, &caller, &marked.pane, "go");
    assert!(refused(&out), "{out:?}");
    assert_eq!(received(&marked.log), "");

    // The state taken off, the same send goes in, exactly as given: text
    // tmux and a shell would both read something into.
    s.tmux(&["set-option", "-pu", "-t", &marked.pane, "@tmuxy-pane-state"]);
    let text = r##"it's #{pane_id} ; "$HOME" `x` \ #[fg=red] ~"##;
    let out = send_into(&s, &caller, &marked.pane, text);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(received(&marked.log), format!("{text}\n"));
    // No send left a held mark of its own on either pane.
    for pane in [&at_dialog.pane, &marked.pane] {
        let options = s.tmux(&["show-options", "-p", "-t", pane]);
        assert!(!options.contains("@tmuxy-send-held"), "{options}");
    }
}

/// `send --queue` into `pane`, left running: it waits in line, and holds
/// its place for up to `stall` seconds after its keys go in.
fn queue_send(
    s: &scratch::ScratchServer,
    caller: &str,
    pane: &str,
    text: &str,
    stall: &str,
) -> Child {
    verb(s, caller, "send")
        .args(["--target", pane, "--caller-pane", caller, "--queue"])
        .args(["--stall-after", stall, "--", text, "Enter"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("tmuxy-server runs")
}

/// The ids in `pane`'s line, first first.
fn line(s: &scratch::ScratchServer, caller: &str, pane: &str) -> Vec<String> {
    let out = verb(s, caller, "send-queue")
        .args(["--target", pane, "--json"])
        .output()
        .expect("tmuxy-server runs");
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    rows.as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect()
}

/// A sender's end, within a bounded time: a send stuck in line fails the
/// test rather than hanging it.
#[track_caller]
fn finished(mut sender: Child) -> Output {
    wait_for(|| sender.try_wait().unwrap().is_some());
    sender.wait_with_output().unwrap()
}

fn set_state(s: &scratch::ScratchServer, pane: &str, state: &str) {
    s.tmux(&["set-option", "-p", "-t", pane, "@tmuxy-pane-state", state]);
}

/// Queued sends wait while the agent works and while it is at a prompt, go
/// in one at a time once it is free, first come first served; one taken
/// back, or whose sender died, is never sent.
#[test]
fn a_queued_send_waits_out_work_and_prompts_and_can_be_taken_back() {
    let s = scratch::ScratchServer::with_session(
        &format!("send-queue-{}", std::process::id()),
        120,
        40,
    );
    let caller = s.tmux(&["display-message", "-p", "-t", "work:0.0", "#{pane_id}"]);
    s.tmux(&["set-option", "-g", "@tmuxy-send-ask", "off"]);
    let busy = agent(&s, "busy", "> ");
    set_state(&s, &busy.pane, "working");

    // First in line: a sender that died and whose pid another process took
    // over (a sleep here), so the pid is alive but is not the sender.
    let mut squatter = Command::new("sleep").arg("60").spawn().unwrap();
    let dead_payload =
        r#"{"caller":"x","keys":["never: pid reused"],"started":"not this process"}"#;
    s.tmux(&[
        "set-option",
        "-p",
        "-t",
        &busy.pane,
        &format!("@tmuxy-send-queued-0000000000001-{:010}", squatter.id()),
        &base64_of(dead_payload),
    ]);

    let mut first = queue_send(&s, &caller, &busy.pane, "first", "20");
    // The first sender drops the squatter's entry: its pid lives, but it
    // is not the process that joined.
    wait_for(|| {
        let ids = line(&s, &caller, &busy.pane);
        ids.len() == 1 && !ids[0].starts_with("0000000000001-")
    });
    let mut dies = queue_send(&s, &caller, &busy.pane, "never: its sender dies", "1");
    wait_for(|| line(&s, &caller, &busy.pane).len() == 2);
    let taken_back = queue_send(&s, &caller, &busy.pane, "never: taken back", "1");
    wait_for(|| line(&s, &caller, &busy.pane).len() == 3);
    let last = queue_send(&s, &caller, &busy.pane, "last", "1");
    wait_for(|| line(&s, &caller, &busy.pane).len() == 4);
    let ids = line(&s, &caller, &busy.pane);

    // Taken back: its sender ends with exit 1 and says so.
    let retract = verb(&s, &caller, "send-queue")
        .args(["--target", &busy.pane, "--retract", &ids[2]])
        .output()
        .unwrap();
    assert_eq!(retract.status.code(), Some(0), "{retract:?}");
    let out = finished(taken_back);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("taken out of"));
    dies.kill().unwrap();
    dies.wait().unwrap();

    // Working, then at a prompt: nothing goes in.
    assert_eq!(received(&busy.log), "");
    set_state(&s, &busy.pane, "needs-input");
    assert_eq!(received(&busy.log), "");
    assert!(
        first.try_wait().unwrap().is_none(),
        "the first send gave up"
    );

    // Free, but another sender's question is on screen: nothing goes in.
    // The question goes up before the pane is idle: the other way round, the
    // queued send, polling, could find it idle with nothing up in between.
    s.tmux(&["set-option", "-p", "-t", &busy.pane, "@tmuxy-ask", "e30="]);
    set_state(&s, &busy.pane, "idle");
    assert_eq!(received(&busy.log), "");

    // Free: the first goes in, alone, and the agent takes it up.
    s.tmux(&["set-option", "-pu", "-t", &busy.pane, "@tmuxy-ask"]);
    wait_for(|| !std::fs::read_to_string(&busy.log).unwrap().is_empty());
    set_state(&s, &busy.pane, "working");
    assert_eq!(finished(first).status.code(), Some(0));
    assert_eq!(received(&busy.log), "first\n");

    // Its turn over, the last goes in past the dead sender's entry.
    set_state(&s, &busy.pane, "idle");
    assert_eq!(finished(last).status.code(), Some(0));
    assert_eq!(received(&busy.log), "first\nlast\n");
    assert!(line(&s, &caller, &busy.pane).is_empty());
    squatter.kill().unwrap();
    squatter.wait().unwrap();
}

fn base64_of(text: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(text)
}
