//! An agent with no hooks gets its pane's state from its screen, against a
//! real tmux: working while it prints, idle once it holds still, and a state
//! a hook declared left alone.
//!
//! The "agent" is a Node script named `gemini`, never a real one, found as
//! a Node or Python agent is: by the script its interpreter runs. Needs a `tmux` binary; the socket is the test's own.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::host::socket_watch::{
    agent_rules::{program, Rules},
    read_panes,
};

mod common;

fn option(pane: &str, name: &str) -> String {
    common::tmux(&["show-options", "-pqv", "-t", pane, name])
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Passes until the pane's state is `want`, or fail after `within`.
async fn passes_until(rules: &mut Rules, pane: &str, want: &str, within: Duration) {
    common::wait_until(&format!("{pane} to read {want:?}"), within, || {
        if let Some(rows) = read_panes() {
            rules.pass(&rows);
        }
        let state = option(pane, "@tmuxy-pane-state");
        async move { state == want }
    })
    .await;
}

#[tokio::test]
async fn agents_without_hooks_get_their_state_from_the_screen() {
    let _server = common::ScratchServer::process_wide("agent-rules");
    let dir = std::env::temp_dir().join(format!("tmuxy-agent-rules-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let flag = dir.join("go");
    let agent = dir.join("gemini");
    // The "agent" is a script named gemini, run by node as an npm bin
    // script is: tmux names the pane's command `node`, and the rules find the
    // agent by the script node runs. It prints while the flag file is there,
    // then holds still.
    std::fs::write(
        &agent,
        format!(
            "const fs = require('fs');\nlet i = 0;\nsetInterval(() => {{ if (fs.existsSync({flag:?})) console.log('thinking ' + ++i); }}, 200);\n",
            flag = flag.display().to_string()
        ),
    )
    .unwrap();
    let node = which("node").expect("node on PATH, to host the fake agent");
    std::fs::write(&flag, "").unwrap();
    common::tmux(&[
        "new-session",
        "-d",
        "-s",
        "app",
        "-x",
        "80",
        "-y",
        "24",
        &format!("exec {} {}", node.display(), agent.display()),
    ])
    .unwrap();
    let pane = common::tmux(&["display-message", "-p", "-t", "app", "#{pane_id}"])
        .unwrap()
        .trim()
        .to_string();

    let mut rules = Rules::with_dir(dir.join("rules"));
    passes_until(&mut rules, &pane, "working", Duration::from_secs(20)).await;
    assert_eq!(option(&pane, "@tmuxy-rules-state"), "working");
    let command = common::tmux(&[
        "display-message",
        "-p",
        "-t",
        &pane,
        "#{pane_current_command}",
    ])
    .unwrap();
    assert_eq!(command.trim(), "node", "tmux names the interpreter");
    let pid: u32 = common::tmux(&["display-message", "-p", "-t", &pane, "#{pane_pid}"])
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(program::program(Some(pid), "node"), "gemini");
    let by_ps = program::foreground_argv_by_ps(pid).expect("ps reads the foreground");
    assert_eq!(
        program::script_name(&by_ps).as_deref(),
        Some("gemini"),
        "{by_ps:?}"
    );

    std::fs::remove_file(&flag).unwrap();
    passes_until(&mut rules, &pane, "idle", Duration::from_secs(20)).await;

    // A hook declares a state: the rules leave it, printing or not.
    common::tmux(&[
        "set-option",
        "-p",
        "-t",
        &pane,
        "@tmuxy-pane-state",
        "needs-input",
    ])
    .unwrap();
    std::fs::write(&flag, "").unwrap();
    for _ in 0..5 {
        rules.pass(&read_panes().unwrap());
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    assert_eq!(option(&pane, "@tmuxy-pane-state"), "needs-input");

    a_user_rule_names_an_agent_and_its_text_gives_the_state().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// A user's rules file names an agent the built-in rules do not know, and
/// its text on screen gives the state, ahead of the generic signs. Runs on
/// the caller's server: `process_wide` sets the socket for the whole process.
async fn a_user_rule_names_an_agent_and_its_text_gives_the_state() {
    let dir = std::env::temp_dir().join(format!("tmuxy-agent-rules-user-{}", std::process::id()));
    let rules_dir = dir.join("rules");
    std::fs::create_dir_all(&rules_dir).unwrap();
    std::fs::write(
        rules_dir.join("helper.toml"),
        "command = \"my-helper\"\n[[rule]]\nmatch = 'Waiting for your reply'\nstate = \"needs-input\"\n",
    )
    .unwrap();
    // A Node program, as Gemini CLI or Amp is: tmux names the pane `node`,
    // and the rules find it by its script. It prints its question once,
    // then holds still: without the rule it would read as idle.
    let agent = dir.join("my-helper.js");
    std::fs::write(
        &agent,
        "console.log('working');\nconsole.log('Waiting for your reply');\nsetInterval(() => {}, 1000);\n",
    )
    .unwrap();
    let node = which("node").expect("node on PATH, to host the fake agent");
    common::tmux(&[
        "new-session",
        "-d",
        "-s",
        "helper",
        "-x",
        "80",
        "-y",
        "24",
        &format!("exec {} {}", node.display(), agent.display()),
    ])
    .unwrap();
    let pane = common::tmux(&["display-message", "-p", "-t", "helper", "#{pane_id}"])
        .unwrap()
        .trim()
        .to_string();
    let mut rules = Rules::with_dir(rules_dir);
    passes_until(&mut rules, &pane, "needs-input", Duration::from_secs(20)).await;
    let command = common::tmux(&[
        "display-message",
        "-p",
        "-t",
        &pane,
        "#{pane_current_command}",
    ])
    .unwrap();
    assert_eq!(command.trim(), "node", "tmux names the interpreter");
    assert!(
        rules.user().problems.is_empty(),
        "{:?}",
        rules.user().problems
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A program on `PATH`, by name.
fn which(name: &str) -> Option<std::path::PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}
