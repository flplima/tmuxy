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

use std::io::{BufRead as _, Write as _};

/// Polls `holds` until it is true: a step of tmux's that has to have
/// happened. A slow machine waits longer; it never reads a half-done state.
fn until(what: &str, holds: impl Fn() -> bool) {
    let started = std::time::Instant::now();
    while !holds() {
        assert!(started.elapsed().as_secs() < 30, "{what} never happened");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Whether the tmux behind `version` (`#{version}`, `3.6a`, `next-3.9`)
/// escapes `%%` itself: 3.8 and later, and a build that names no number.
fn escapes_percent_itself(version: &str) -> bool {
    tmuxy_core::tmux_check::parse_version(&format!("tmux {version}")).is_none_or(|v| v >= (3, 8))
}

/// `choose-window` with `template` in a session named `session`, a window
/// picked as a person would (Down, Enter), through an attached control-mode
/// client (a tree mode runs its command as the client that pressed the
/// key). Returns the server, once the chooser has closed, and its version.
fn pick_a_window(label: &str, session: &str, template: &str) -> (common::ScratchServer, String) {
    let server = common::ScratchServer::new(label);
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
    let name = server.tmux(&["display-message", "-p", "#{session_name}"]);
    server.tmux(&["new-window", "-d", "-t", &format!("{name}:")]);
    let version = server.tmux(&["display-message", "-p", "#{version}"]);
    let mut client = tmuxy_core::session::local_tmux_on(&server.socket)
        .args(["-C", "attach", "-t", &name])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut replies = std::io::BufReader::new(client.stdout.take().unwrap()).lines();
    let input = client.stdin.as_mut().unwrap();
    until("the client attaching", || {
        !server.tmux(&["list-clients"]).is_empty()
    });
    let in_mode = || {
        server.tmux(&[
            "display-message",
            "-p",
            "-t",
            &format!("{name}:0.0"),
            "#{pane_in_mode}",
        ]) == "1"
    };
    let quoted = template.replace('\\', "\\\\").replace('"', "\\\"");
    writeln!(input, "choose-window -Z \"{quoted}\"").unwrap();
    until("the chooser opening", in_mode);
    writeln!(input, "send-keys Down").unwrap();
    writeln!(input, "send-keys Enter").unwrap();
    until("the chooser closing", || !in_mode());
    // The pick's command is queued on this client, so it has run by the
    // time a command written after it answers.
    writeln!(input, "display-message -p tmuxy-pick-done").unwrap();
    assert!(
        replies.any(|line| line.is_ok_and(|line| line == "tmuxy-pick-done")),
        "the client closed before the pick's commands ran"
    );
    let _ = writeln!(input, "detach");
    let _ = client.wait();
    (server, version)
}

fn joined(server: &common::ScratchServer) -> bool {
    let name = server.tmux(&["display-message", "-p", "#{session_name}"]);
    server
        .tmux(&["list-panes", "-t", &format!("{name}:0"), "-F", "x"])
        .lines()
        .count()
        == 2
}

/// The template as the defaults bind it, on a real tmux, in a session whose
/// name has a `'` in it: picking a window joins its pane here. Single-quoted
/// `'%%'` ends its quote at that `'` before tmux 3.8 (which escapes `%%`
/// itself) and joins nothing.
#[test]
fn a_window_picked_from_a_session_named_with_a_quote_is_joined() {
    let (server, version) = pick_a_window("conf-safe", "it's", r#"join-pane -h -s "%%%""#);
    assert!(joined(&server), "the shipped template on tmux {version}");
    let (server, version) = pick_a_window("conf-unsafe", "it's", "join-pane -h -s '%%'");
    assert_eq!(
        joined(&server),
        escapes_percent_itself(&version),
        "'%%' on tmux {version}"
    );
    let (server, version) = pick_a_window("conf-plain", "plain", "join-pane -h -s '%%'");
    assert!(joined(&server), "the harness itself on tmux {version}");
}

/// A session named to break out of the quote: with `'%%'`, before tmux
/// 3.8, picking one of its windows runs a shell command of the name's
/// choosing. The shipped template runs nothing on any version.
#[test]
fn a_session_name_crafted_to_break_out_runs_nothing() {
    for (label, template, safe) in [
        ("conf-crafted-safe", r#"join-pane -h -s "%%%""#, true),
        ("conf-crafted-unsafe", "join-pane -h -s '%%'", false),
    ] {
        let marker = std::env::temp_dir().join(format!("{label}-{}", std::process::id()));
        let path = marker.display().to_string();
        // tmux turns `.` and `:` in a session name into `_`: the command
        // would touch another path than the one checked.
        assert!(
            !path.contains(['.', ':']),
            "{path}: set TMPDIR to a directory without '.' or ':'"
        );
        let _ = std::fs::remove_file(&marker);
        let crafted = format!("' -s %1 ; run-shell 'touch {path}' ; display '");
        let (_server, version) = pick_a_window(label, &crafted, template);
        let ran = marker.exists();
        let _ = std::fs::remove_file(&marker);
        let runs = !safe && !escapes_percent_itself(&version);
        assert_eq!(ran, runs, "{template} on tmux {version}");
    }
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

/// The defaults on a tmux server that is already running: they load with no
/// error on every tmux the nightly matrix runs, turn extended keys on for
/// programs that ask, and pick the CSI u form where tmux has a choice (3.5
/// and later; older tmux has only that form). A line sourced after them, as
/// the user's `tmuxy.conf` is, turns it off.
#[test]
fn the_defaults_turn_extended_keys_on_and_a_later_file_turns_them_off() {
    let server = common::ScratchServer::new("conf-keys");
    server.tmux(&["-f", "/dev/null", "new-session", "-d", "-s", "keys"]);
    let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let load = || {
        for conf in ["tmuxy.essentials.conf", "tmuxy.defaults.conf"] {
            server.tmux(&["source-file", &assets.join(conf).display().to_string()]);
        }
    };
    let option = |name: &str| server.tmux(&["show-options", "-sqv", name]);
    assert_eq!(option("extended-keys"), "off", "a bare server");
    load();
    assert_eq!(option("extended-keys"), "on");
    let version = server.tmux(&["display-message", "-p", "#{version}"]);
    let has_format = tmuxy_core::tmux_check::parse_version(&format!("tmux {version}"))
        .is_none_or(|v| v >= (3, 5));
    assert_eq!(
        option("extended-keys-format"),
        if has_format { "csi-u" } else { "" },
        "tmux {version}"
    );
    let own = server.home.join("tmuxy.conf");
    std::fs::write(&own, "set -s extended-keys off\n").unwrap();
    server.tmux(&["source-file", &own.display().to_string()]);
    assert_eq!(option("extended-keys"), "off");
}

/// The client keys that give way to a binding (`YIELDING_CLIENT_KEYS` in
/// tmuxy-ui's `domain/keyTables.ts`: Go to, the command palette, the activity
/// inbox) are answered by the client only while tmux binds nothing on them.
/// tmux 3.8 binds `prefix g` itself, so the shipped defaults unbind it; on
/// every tmux the nightly matrix runs, none of those keys is bound once the
/// defaults are loaded.
#[test]
fn the_client_keys_that_yield_are_unbound_after_the_defaults() {
    let keys = yielding_prefix_keys();
    let server = common::ScratchServer::new("conf-yield");
    server.tmux(&["-f", "/dev/null", "new-session", "-d", "-s", "yield"]);
    // In the order tmuxy loads them: the essentials define the commands the
    // defaults bind.
    let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    for conf in ["tmuxy.essentials.conf", "tmuxy.defaults.conf"] {
        server.tmux(&["source-file", &assets.join(conf).display().to_string()]);
    }
    let version = server.tmux(&["display-message", "-p", "#{version}"]);
    let bound: Vec<String> = server
        .tmux(&["list-keys", "-T", "prefix"])
        .lines()
        .filter_map(|line| {
            let words: Vec<&str> = line.split_whitespace().collect();
            let table = words.iter().position(|word| *word == "-T")?;
            let key = words.get(table + 2)?;
            keys.iter().any(|k| k == key).then(|| line.to_string())
        })
        .collect();
    assert!(
        bound.is_empty(),
        "tmux {version} binds keys the client yields:\n{}",
        bound.join("\n")
    );
}

/// The prefix-table keys whose client key yields, read from where the client
/// defines them, so this test and the client never hold two lists.
fn yielding_prefix_keys() -> Vec<String> {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmuxy-ui/src/domain/keyTables.ts");
    let source = std::fs::read_to_string(&source).unwrap();
    let block = |start: &str, end: &str| -> String {
        let from = source
            .find(start)
            .unwrap_or_else(|| panic!("{start} in keyTables.ts"));
        let rest = &source[from + start.len()..];
        rest[..rest.find(end).unwrap()].to_string()
    };
    let quoted = |text: &str| -> Vec<String> {
        text.split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    };
    let yielding = quoted(&block("YIELDING_CLIENT_KEYS", "]);"));
    let keys: Vec<String> = block("prefix: {", "}")
        .lines()
        .filter_map(|line| {
            let (key, client) = line.trim().trim_end_matches(',').split_once(": ")?;
            let client = client.trim_matches('\'');
            yielding
                .iter()
                .any(|y| y == client)
                .then(|| key.trim_matches('\'').to_string())
        })
        .collect();
    assert!(
        !yielding.is_empty() && keys.len() == yielding.len(),
        "read {keys:?} for {yielding:?} from keyTables.ts: its layout changed"
    );
    keys
}
