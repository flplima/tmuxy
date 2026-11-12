//! An agent with no hooks gets its pane's state from its screen, against a
//! real tmux: working while it prints, idle once it holds still, and a state
//! a hook declared left alone.
//!
//! The "agent" is a shell script named `gemini`, never a real one. Needs a
//! `tmux` binary; the socket is the test's own.

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
async fn an_agent_without_hooks_is_working_then_idle_and_a_declared_state_wins() {
    let _server = common::ScratchServer::process_wide("agent-rules");
    let dir = std::env::temp_dir().join(format!("tmuxy-agent-rules-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let flag = dir.join("go");
    let agent = dir.join("gemini");
    // The "agent" is a script named gemini, run by sh as an npm bin script
    // is run by node: tmux names the pane's command `sh`, and the rules find
    // the agent by the script sh runs. It prints while the flag file is
    // there, then holds still.
    std::fs::write(
        &agent,
        format!(
            "i=0; while :; do if [ -e {flag} ]; then i=$((i+1)); echo \"thinking $i\"; fi; sleep 0.2; done\n",
            flag = flag.display()
        ),
    )
    .unwrap();
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
        &format!("exec sh {}", agent.display()),
    ])
    .unwrap();
    let pane = common::tmux(&["display-message", "-p", "-t", "app", "#{pane_id}"])
        .unwrap()
        .trim()
        .to_string();

    let mut rules = Rules::default();
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
    assert_eq!(command.trim(), "sh", "tmux names the interpreter");
    assert_eq!(program::program(&pane, "sh"), "gemini");

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

    let _ = std::fs::remove_dir_all(&dir);
}
