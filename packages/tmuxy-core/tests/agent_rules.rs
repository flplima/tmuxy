//! An agent with no hooks gets its pane's state from its screen, against a
//! real tmux: working while it prints, idle once it holds still, and a state
//! a hook declared left alone.
//!
//! The "agent" is a shell script named `gemini`, never a real one. Needs a
//! `tmux` binary; the socket is the test's own.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use tmuxy_core::host::socket_watch::{agent_rules::Rules, read_panes};

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
    // tmux names a pane's command after its process, which for a script is
    // the interpreter: the "agent" is a copy of sh named gemini. It prints
    // while the flag file is there, then holds still.
    std::fs::copy("/bin/sh", &agent).unwrap();
    let script = format!(
        "i=0; while :; do if [ -e {flag} ]; then i=$((i+1)); echo \"thinking $i\"; fi; sleep 0.2; done",
        flag = flag.display()
    );
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
        &format!("{} -c '{script}'", agent.display()),
    ])
    .unwrap();
    let pane = common::tmux(&["display-message", "-p", "-t", "app", "#{pane_id}"])
        .unwrap()
        .trim()
        .to_string();
    common::wait_until(
        "the agent to be the pane's command",
        Duration::from_secs(10),
        || {
            let command = common::tmux(&[
                "display-message",
                "-p",
                "-t",
                &pane,
                "#{pane_current_command}",
            ])
            .unwrap_or_default();
            async move { command.trim() == "gemini" }
        },
    )
    .await;

    let mut rules = Rules::with_dir(dir.join("rules"));
    passes_until(&mut rules, &pane, "working", Duration::from_secs(20)).await;
    assert_eq!(option(&pane, "@tmuxy-rules-state"), "working");

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
    let agent = dir.join("my-helper");
    std::fs::copy("/bin/sh", &agent).unwrap();
    // Prints its question once, then holds still: without the rule it
    // would read as idle.
    let script = "echo working; echo Waiting for your reply; while :; do sleep 1; done";
    common::tmux(&[
        "new-session",
        "-d",
        "-s",
        "helper",
        "-x",
        "80",
        "-y",
        "24",
        &format!("{} -c '{script}'", agent.display()),
    ])
    .unwrap();
    let pane = common::tmux(&["display-message", "-p", "-t", "helper", "#{pane_id}"])
        .unwrap()
        .trim()
        .to_string();
    let mut rules = Rules::with_dir(rules_dir);
    passes_until(&mut rules, &pane, "needs-input", Duration::from_secs(20)).await;
    assert!(
        rules.user().problems.is_empty(),
        "{:?}",
        rules.user().problems
    );
    let _ = std::fs::remove_dir_all(&dir);
}
