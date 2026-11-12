//! The command templates in the tmux config tmuxy ships (`command-prompt`,
//! `choose-window`, `confirm-before`…) take what the user typed or picked as
//! `%%`. Before tmux 3.8, `%%` goes in unescaped: inside single quotes, a
//! name with a `'` in it ends the quote and the rest of it runs as tmux
//! commands. `"%%%"` is escaped by every tmux tmuxy supports (3.2 and later),
//! so a template takes its input only so.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::Path;

#[test]
fn no_shipped_template_takes_its_input_in_single_quotes() {
    let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let mut offending = Vec::new();
    for entry in std::fs::read_dir(&assets).unwrap().flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "conf") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for (number, line) in text.lines().enumerate() {
            let unescaped = ["'%%'", "'%1'", "'%2'", "'%%%'"]
                .iter()
                .any(|quoted| line.contains(quoted));
            if unescaped && !line.trim_start().starts_with('#') {
                offending.push(format!("{}:{}: {line}", path.display(), number + 1));
            }
        }
    }
    assert!(
        offending.is_empty(),
        "single-quoted %%:\n{}",
        offending.join("\n")
    );
}

mod common;

use std::io::Write as _;

/// `choose-window` with `template` in a session named `session`, a window
/// picked as a person would (Down, Enter): whether its pane was joined.
/// The keys come from an attached control-mode client, since a tree mode
/// runs its command as the client that pressed the key.
fn joined_by(session: &str, template: &str) -> (bool, String) {
    let server = common::ScratchServer::new("conf-template");
    server.tmux(&[
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "120",
        "-y",
        "40",
    ]);
    server.tmux(&["new-window", "-d", "-t", &format!("{session}:")]);
    let version = server.tmux(&["display-message", "-p", "#{version}"]);
    let mut client = tmuxy_core::session::local_tmux_on(&server.socket)
        .args(["-C", "attach", "-t", session])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pause = |ms| std::thread::sleep(std::time::Duration::from_millis(ms));
    let input = client.stdin.as_mut().unwrap();
    pause(300);
    let quoted = template.replace('\\', "\\\\").replace('"', "\\\"");
    writeln!(input, "choose-window -Z \"{quoted}\"").unwrap();
    pause(300);
    writeln!(input, "send-keys Down").unwrap();
    writeln!(input, "send-keys Enter").unwrap();
    // Until the join shows, or long enough that it never will.
    let panes = || {
        server
            .tmux(&["list-panes", "-t", &format!("{session}:0"), "-F", "x"])
            .lines()
            .count()
    };
    for _ in 0..40 {
        if panes() == 2 {
            break;
        }
        pause(50);
    }
    let joined = panes() == 2;
    let _ = writeln!(input, "detach");
    let _ = client.wait();
    (joined, version)
}

/// The template as the defaults bind it, on a real tmux, in a session whose
/// name has a `'` in it: picking a window joins its pane here. Single-quoted
/// `'%%'` ends its quote at that `'` before tmux 3.8 (which escapes `%%` too)
/// and joins nothing.
#[test]
fn a_window_picked_from_a_session_named_with_a_quote_is_joined() {
    let (joined, version) = joined_by("it's", r#"join-pane -h -s "%%%""#);
    assert!(joined, "the shipped template on tmux {version}");
    let (joined, version) = joined_by("it's", "join-pane -h -s '%%'");
    let escapes_too = version.starts_with("3.8") || version.starts_with("next-3.8");
    assert_eq!(joined, escapes_too, "single-quoted %% on tmux {version}");
    let (joined, version) = joined_by("plain", "join-pane -h -s '%%'");
    assert!(joined, "the harness itself on tmux {version}");
}

/// Every shipped config still parses on this tmux (`source-file -n` reads
/// without running).
#[test]
fn every_shipped_config_parses() {
    let server = common::ScratchServer::new("conf-parse");
    server.tmux(&["-f", "/dev/null", "new-session", "-d", "-s", "parse"]);
    let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    for entry in std::fs::read_dir(&assets).unwrap().flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "conf") {
            server.tmux(&["source-file", "-n", &path.display().to_string()]);
        }
    }
}
