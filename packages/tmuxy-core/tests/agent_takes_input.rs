//! `agent_takes_input_format`, as tmux evaluates it: the guard the diff
//! review's send runs in the same command list as its keys. Programs are
//! copies of `bash` named as agents are, waiting on a builtin (a copied
//! multi-call `sleep` would not know its new name), on a scratch server read
//! from no config.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use tmuxy_core::host::socket_watch::agent_screen::agent_takes_input_format;

#[test]
fn only_an_agent_that_asks_nothing_takes_input() {
    let server = common::ScratchServer::new("agent-input");
    let program = |name: &str| {
        let path = server.home.join(name);
        std::fs::copy("/bin/bash", &path).unwrap();
        path.display().to_string()
    };
    let (claude, versioned) = (program("claude"), program("2.1.30"));
    let session = |name: &str, command: &str| {
        let first = if name == "agent" {
            vec!["-f", "/dev/null"]
        } else {
            vec![]
        };
        let mut args = first;
        args.extend(["new-session", "-d", "-s", name, command, "-c", "read -t 60"]);
        server.tmux(&args);
    };
    session("agent", &claude);
    session("versioned", &versioned);
    session("shell", "/bin/bash");
    let format = agent_takes_input_format();
    let takes = |target: &str| server.tmux(&["display-message", "-p", "-t", target, &format]);

    // tmux names a pane's program once it has started.
    for target in ["agent", "versioned", "shell"] {
        let started = std::time::Instant::now();
        while server
            .tmux(&[
                "display-message",
                "-p",
                "-t",
                target,
                "#{pane_current_command}",
            ])
            .is_empty()
        {
            assert!(
                started.elapsed().as_secs() < 10,
                "{target}'s program never started"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    assert_eq!(takes("agent"), "1");
    assert_eq!(
        takes("versioned"),
        "1",
        "Claude Code runs under its version"
    );
    assert_eq!(takes("shell"), "0", "a shell is no agent");

    server.tmux(&[
        "set-option",
        "-p",
        "-t",
        "agent",
        "@tmuxy-pane-state",
        "working",
    ]);
    assert_eq!(takes("agent"), "1");
    server.tmux(&[
        "set-option",
        "-p",
        "-t",
        "agent",
        "@tmuxy-pane-state",
        "needs-input",
    ]);
    assert_eq!(takes("agent"), "0", "the agent waits for an answer");
    server.tmux(&["set-option", "-p", "-t", "agent", "-u", "@tmuxy-pane-state"]);
    server.tmux(&["set-option", "-p", "-t", "agent", "@tmuxy-ask", "May I?"]);
    assert_eq!(takes("agent"), "0", "a pane send's question is up");
}
