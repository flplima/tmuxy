//! The client half: reaching a browser session from outside the server.
//!
//! The session lives in the running server, so the REPL in a pane and the CLI
//! both have to get a verb line across a process boundary. They do it over the
//! server's own `/commands` endpoint rather than a new socket, because every
//! property that endpoint already has is one this does not have to re-earn: the
//! host policy, the Basic-auth check, the read-only refusal, and the single
//! place where a client command is dispatched.
//!
//! Finding the server is the only new problem, and the answer is the pid file it
//! already writes (`server::pid_file_path`): it names the port, and the port is
//! all this needs.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use super::verbs;

/// What to do with a browser session, from the command line.
#[derive(clap::Args, Debug)]
pub struct BrowserArgs {
    /// The session to drive. One engine per name.
    #[arg(long, default_value = "default")]
    pub session: String,
    /// The port the tmuxy server is on. Defaults to the one the pid file names.
    #[arg(long)]
    pub port: Option<u16>,
    /// Read verb lines from stdin and print each result — the REPL the pane
    /// runs. Without it, the remaining arguments are one verb line.
    #[arg(long)]
    pub repl: bool,
    /// End the session and remove its throwaway profile.
    #[arg(long, conflicts_with = "repl")]
    pub close: bool,
    /// List the running sessions.
    #[arg(long, conflicts_with_all = ["repl", "close"])]
    pub list: bool,
    /// One verb line: `goto example.com`, `eval document.title`, …
    #[arg(trailing_var_arg = true)]
    pub line: Vec<String>,
}

/// Where the server writes the port it is on, for the default port.
///
/// Deliberately the same file `server::pid_file_path` writes; duplicating the
/// path rather than exporting it would be two things to keep in step.
fn default_pid_file() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".tmuxy")
        .join("tmuxy.pid")
}

/// The port to talk to: the flag, then `TMUXY_PORT`, then the default.
///
/// `TMUXY_PORT` because that is the knob the dev server and the test suite
/// already use, so a REPL started inside either reaches the right server
/// without being told.
fn resolve_port(explicit: Option<u16>) -> u16 {
    if let Some(port) = explicit {
        return port;
    }
    if let Some(port) = std::env::var("TMUXY_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
    {
        return port;
    }
    // The pid file existing at all means a server on the default port, which is
    // the only port it is written for.
    if default_pid_file().exists() {
        return 9000;
    }
    9000
}

/// Send one `/commands` request and return the `result` string.
async fn post(port: u16, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/commands");
    let body = serde_json::json!({ "cmd": cmd, "args": args });

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&body)
        // No `sec-fetch-*` headers: this is not a browser, and the host policy
        // lets a non-browser client through precisely so the CLI can work
        // (`request_guard`). Saying so here because sending them would be the
        // obvious-looking thing to do and would be wrong.
        .send()
        .await
        .map_err(|error| {
            // The most likely failure by far, so it gets the useful message
            // rather than reqwest's.
            if error.is_connect() {
                format!(
                    "no tmuxy server on port {port}. Start one (`npm start`, or \
                     `tmuxy server`), or name the port with --port."
                )
            } else {
                format!("could not reach the tmuxy server: {error}")
            }
        })?;

    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("the server's reply was not JSON: {error}"))?;

    if let Some(error) = payload.get("error").and_then(serde_json::Value::as_str) {
        return Err(error.to_string());
    }
    if !status.is_success() {
        return Err(format!("the server answered {status}"));
    }
    Ok(payload
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// What a result should print, or `None` for nothing at all.
///
/// Separate from printing it so the classification is testable — and the
/// classification is the part worth testing: a verb with nothing to say that
/// prints `null` puts a word in the pane that a `capture-pane` reads as output
/// and a person reads as an error.
fn rendered(result: &serde_json::Value) -> Option<String> {
    match result {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) if text.is_empty() => None,
        serde_json::Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// Print a result the way the REPL and the CLI both should.
fn show(result: &serde_json::Value) {
    if let Some(text) = rendered(result) {
        println!("{text}");
    }
}

/// `tmuxy browser …`.
pub async fn run(args: BrowserArgs) {
    let port = resolve_port(args.port);

    if args.list {
        match post(port, "browser_list", serde_json::json!({})).await {
            Ok(names) => {
                for name in names.as_array().into_iter().flatten() {
                    if let Some(name) = name.as_str() {
                        println!("{name}");
                    }
                }
            }
            Err(message) => fail(&message),
        }
        return;
    }

    if args.close {
        match post(
            port,
            "browser_close",
            serde_json::json!({ "session": args.session }),
        )
        .await
        {
            Ok(closed) => {
                if closed.as_bool() != Some(true) {
                    eprintln!("tmuxy browser: no session called {:?}", args.session);
                }
            }
            Err(message) => fail(&message),
        }
        return;
    }

    if args.repl {
        repl(port, &args.session).await;
        return;
    }

    let line = args.line.join(" ");
    if line.trim().is_empty() {
        println!("{}", verbs::HELP);
        return;
    }
    match post(
        port,
        "browser_run",
        serde_json::json!({ "session": args.session, "line": line }),
    )
    .await
    {
        Ok(result) => show(&result),
        Err(message) => fail(&message),
    }
}

/// The loop the pane runs.
///
/// Line-based and unadorned on purpose. Its stdout IS the pane's terminal
/// output, which is what makes the whole thing driveable from outside: another
/// pane or an agent sends a line with `tmuxy pane send` and reads the answer
/// with `tmuxy pane capture`, needing no API of its own. Anything fancier —
/// readline, colour, a spinner — would put escape sequences in the middle of
/// the text those captures have to parse.
async fn repl(port: u16, session: &str) {
    // A banner, because a pane showing a bare cursor gives a person nothing to
    // go on. One line, so a `capture-pane` is not mostly banner.
    println!("tmuxy browser [{session}] — `help` for verbs, ctrl+c to leave");

    // Start the engine now, rather than on the first verb.
    //
    // A session is created lazily by whatever first asks something of it, which
    // is right for the one-shot CLI and wrong for a pane: the pane's widget
    // streams the page from a session that does not exist yet, gets a 404, and
    // shows nothing at all until the user happens to type a verb. Opening a
    // browser pane should give you a browser.
    //
    // `url` is the cheapest verb that forces the session into existence, and
    // its answer is worth printing: it says where the pane is pointed.
    match post(
        port,
        "browser_run",
        serde_json::json!({ "session": session, "line": "url" }),
    )
    .await
    {
        Ok(result) => show(&result),
        // Printed, not fatal. The REPL is still usable — `help` works with no
        // engine at all — and the message says what went wrong, which a pane
        // that merely stayed blank would not.
        Err(message) => println!("error: {message}"),
    }
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();

    loop {
        // The prompt has to be flushed explicitly: stdout to a pipe or a pty is
        // block-buffered, so without this the prompt appears only after the
        // answer to the line it was asking for.
        print!("> ");
        let _ = io::stdout().flush();

        let Some(line) = lines.next() else { break };
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }

        match post(
            port,
            "browser_run",
            serde_json::json!({ "session": session, "line": line }),
        )
        .await
        {
            Ok(result) => show(&result),
            // To stdout, not stderr: both land in the pane, but only stdout is
            // ordered with respect to the results around it, and a capture that
            // shows an error in the wrong place is worse than no error.
            Err(message) => println!("error: {message}"),
        }
    }
}

fn fail(message: &str) -> ! {
    eprintln!("tmuxy browser: {message}");
    std::process::exit(1);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// A verb with nothing to say must print nothing. `null` in a pane is a
    /// word a `capture-pane` reads as output and a person reads as an error.
    #[test]
    fn a_silent_result_renders_to_nothing() {
        assert_eq!(rendered(&serde_json::Value::Null), None);
        assert_eq!(rendered(&serde_json::json!("")), None);
    }

    /// A string renders as itself: at a prompt, `title` answering `My Page` is
    /// what is wanted, and quotes are noise a script has to strip.
    #[test]
    fn a_string_renders_without_quotes() {
        assert_eq!(
            rendered(&serde_json::json!("My Page")),
            Some("My Page".into())
        );
        assert_eq!(rendered(&serde_json::json!("0")), Some("0".into()));
    }

    /// Everything else renders as JSON, including the values that look falsy —
    /// `false` and `0` are answers, not silence.
    #[test]
    fn a_falsy_non_string_still_renders() {
        assert_eq!(rendered(&serde_json::json!(false)), Some("false".into()));
        assert_eq!(rendered(&serde_json::json!(0)), Some("0".into()));
        assert_eq!(rendered(&serde_json::json!([])), Some("[]".into()));
        assert_eq!(rendered(&serde_json::json!({})), Some("{}".into()));
    }

    /// The flag wins, then `TMUXY_PORT`, then the default — so a REPL started
    /// inside the dev server or the test suite reaches the right server without
    /// being told.
    #[test]
    fn an_explicit_port_wins() {
        assert_eq!(resolve_port(Some(9131)), 9131);
    }

    #[test]
    fn the_default_port_is_the_servers_default() {
        // Not read from the environment here: that is a global, and a test that
        // writes it breaks whichever other test runs beside it. The ladder's
        // env step is covered by the flag and default cases plus the code
        // being three lines.
        let resolved = resolve_port(None);
        assert!(
            resolved == 9000 || std::env::var("TMUXY_PORT").is_ok(),
            "with no TMUXY_PORT set the default must be 9000, got {resolved}"
        );
    }
}
