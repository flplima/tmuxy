use super::*;

/// The tail of the argv is the part that decides what tmux does. The head
/// (tmux path, `ssh -tt …`, `-f <config>`) varies by machine, so the
/// assertions are on the suffix only.
fn tail(args: &[String], n: usize) -> Vec<&str> {
    args[args.len() - n..].iter().map(String::as_str).collect()
}

#[test]
fn creating_a_session_attaches_in_the_same_command() {
    // `new-session -A` attaches to an existing session or creates one, in
    // one step. A create followed by a separate attach leaves a moment
    // with no client, which macOS launchd's reaper kills the server in.
    let args = build_tmux_args("tmuxy", true, None, None);
    assert_eq!(
        tail(&args, 5),
        vec!["-CC", "new-session", "-A", "-s", "tmuxy"]
    );
}

#[test]
fn a_grouped_session_names_the_session_it_shares_windows_with() {
    // A second GUI window attaches to its own session in the base
    // session's group: same windows, its own current window.
    let args = build_tmux_args("tmuxy~2", true, Some("tmuxy"), None);
    assert_eq!(
        tail(&args, 7),
        vec!["-CC", "new-session", "-A", "-s", "tmuxy~2", "-t", "tmuxy"]
    );
}

#[test]
fn attaching_never_creates_a_session() {
    // The monitor reconnect path must not resurrect a session the user
    // killed — it would come back empty and look like lost work.
    let args = build_tmux_args("tmuxy", false, None, None);
    assert_eq!(tail(&args, 4), vec!["-CC", "attach-session", "-t", "tmuxy"]);
    assert!(!args.iter().any(|a| a == "new-session"));
}

#[test]
fn a_session_name_with_spaces_stays_one_argument() {
    // argv, not a shell string: a name is never re-split, so it cannot
    // smuggle a second command in.
    let args = build_tmux_args("my session; rm -rf ~", true, None, None);
    assert_eq!(
        args.last().map(String::as_str),
        Some("my session; rm -rf ~")
    );
}

/// `format_output` is what a failed tmux invocation shows the user. An
/// empty stream must not become a dangling `stdout=` with nothing after it.
#[test]
fn a_failed_command_reports_its_exit_code_and_whatever_it_printed() {
    use std::os::unix::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(256), // exit code 1
        stdout: b"  hello  \n".to_vec(),
        stderr: b"\nno server running\n".to_vec(),
    };
    assert_eq!(
        format_output(&output),
        "exit=1 stdout=hello stderr=no server running"
    );

    let quiet = std::process::Output {
        status: std::process::ExitStatus::from_raw(0),
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    assert_eq!(format_output(&quiet), "exit=0");
}

#[test]
fn a_killed_command_reports_a_signal_rather_than_a_missing_code() {
    use std::os::unix::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(9), // killed by SIGKILL
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    assert_eq!(format_output(&output), "exit=signal");
}

/// Invalid UTF-8 is what a pane's own bytes look like when tmux fails
/// mid-stream; the log line must still be produced.
#[test]
fn output_that_is_not_utf8_still_formats() {
    use std::os::unix::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(256),
        stdout: vec![0xff, 0xfe, b'o', b'k'],
        stderr: Vec::new(),
    };
    assert!(format_output(&output).starts_with("exit=1 stdout="));
}

/// A fake tmux: `sh -c script` on the connection's PTY, so the test decides
/// every byte tmux would have written.
async fn open_fake_tmux(script: &str) -> Result<ControlModeConnection, TmuxError> {
    let argv = ["/bin/sh", "-c", script].map(String::from);
    ControlModeConnection::open(&argv, None, "app", None).await
}

/// What `tmux -CC` writes before anything else: the DCS that opens control
/// mode, glued to the `%begin` of the block that answers its own command.
const OPENER: &str = r"printf '\033P1000p%%begin 1700000000 1 1\n'";

#[tokio::test]
async fn a_tmux_that_prints_an_error_and_exits_never_connects() {
    // [invariant: X7] tmux failing before control mode: a socket it cannot
    // reach, a terminal it refuses. A plain line, then exit 1.
    let script = "echo 'error connecting to /tmp/tmux-1000/app (Permission denied)'; exit 1";
    let error = open_fake_tmux(script).await.err().expect("no connection");
    let message = error.to_string();
    assert!(
        message.contains("error connecting to /tmp/tmux-1000/app (Permission denied)"),
        "tmux's own words reach the user: {message}"
    );
    assert!(message.contains("exit status: 1"), "{message}");
}

#[tokio::test]
async fn a_command_tmux_refuses_in_control_mode_never_connects() {
    // [invariant: X7] tmux in control mode whose own command failed: the
    // opening block closes with `%error`, then `%exit`. Neither is a
    // connection.
    let script = format!(
        r"{OPENER}; echo 'can'\''t find session: nosuch'; printf '%%error 1700000000 1 1\n%%exit\n\033\\'; exit 1"
    );
    let error = open_fake_tmux(&script).await.err().expect("no connection");
    let message = error.to_string();
    // The block's body, not its guards.
    assert!(
        message.contains("for session 'app': can't find session: nosuch (command:"),
        "tmux's own words reach the user: {message}"
    );
}

#[tokio::test]
async fn control_mode_connects_on_its_opening_block_and_hands_on_what_follows() {
    // [invariant: X7] The opening block is the handshake, not a reply to
    // anything tmuxy sent: the first event the monitor sees is tmux's first
    // notification. `read` waits for `detach-client`, as tmux would.
    let script =
        format!(r"{OPENER}; printf '%%end 1700000000 1 1\n%%session-changed $1 app\n'; read line");
    let mut connection = open_fake_tmux(&script).await.expect("connected");
    let first = tokio::time::timeout(Duration::from_secs(5), connection.recv())
        .await
        .expect("an event arrives");
    assert!(
        matches!(first, Some(ControlModeEvent::SessionChanged { ref session_name, .. }) if session_name == "app"),
        "{first:?}"
    );
    connection.graceful_close().await;
}
