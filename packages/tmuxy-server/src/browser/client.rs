//! `tmuxy browser` — the command line onto a browser session.
//!
//! There is no client/server split here any more, and its absence is the point.
//! The engine used to live in the running tmuxy server, with verbs posted to
//! `/commands` and frames streamed out over HTTP, because the page was being
//! painted by a React widget in the viewer's browser. Once the page is drawn by
//! a PANE — an inline image written to a pty — none of that is load-bearing:
//! the pane program is the session's owner, and this is just the way to start
//! one or to ask a one-off question.
//!
//! What that removes: a route, a widget, five client commands, a session
//! registry, and the whole question of whether a viewer may drive a browser
//! that fetches from the SERVER's network (SEC-11). The engine now runs as the
//! person who typed the command, which is the only answer that needs no policy.
//!
//! Three shapes:
//!
//!   * `tmuxy browser goto example.com` — one verb, its own engine, gone after.
//!   * `tmuxy browser --repl` — the pane program (`pane`), which draws the page.
//!   * `tmuxy browser --attach <ws://…>` — the same, against a browser somebody
//!     else started. See `--attach`'s own help for why that is the escape hatch
//!     for a desktop build and for the user's real profile.
//!
//! To drive a session that is already open in a pane, send it a line: the pane
//! program's `:` command mode reads keys from the pty, so `tmuxy pane send -t
//! %7 ':goto example.com' Enter` works from any other pane or agent, and
//! `tmuxy pane capture` reads the answer back off the status row. That is the
//! whole agent protocol, and it needed no API.

use super::session::{Output, Session};
use super::{pane, verbs};

/// What to do with a browser session, from the command line.
#[derive(clap::Args, Debug)]
pub struct BrowserArgs {
    /// The session to drive. Names the throwaway profile, so one engine per
    /// name, and a name is something a script can say again later.
    #[arg(long, default_value = "default")]
    pub session: String,
    /// Draw the page in this pane and read input from it: the full-screen
    /// program. Without it, the remaining arguments are one verb line.
    #[arg(long)]
    pub repl: bool,
    /// Attach to a browser that is already running, by DevTools endpoint
    /// (`ws://…` from `/json/version`, or `http://127.0.0.1:PORT`).
    ///
    /// The escape hatch for the two cases a launch cannot serve: a desktop
    /// build where the browser is the app's own, and the user's REAL profile,
    /// with its logins — which Chrome will only expose after the consent prompt
    /// at `chrome://inspect/#remote-debugging`. An attached browser is left
    /// running and its profile untouched when the pane closes.
    #[arg(long)]
    pub attach: Option<String>,
    /// Open this page as the pane starts (`--repl` only). What a restored
    /// browser pane is handed: the pane writes `@tmuxy-pane-restore` with the
    /// page it is on, so a session snapshot brings it back here.
    #[arg(long, value_name = "URL")]
    pub goto: Option<String>,
    /// One verb line: `goto example.com`, `eval document.title`, `shot`, …
    #[arg(trailing_var_arg = true)]
    pub line: Vec<String>,
}

/// `tmuxy browser …`.
pub async fn run(args: BrowserArgs) {
    // A session's profile and screenshots live under the state dir: a profile
    // is a few hundred MB and must not land anywhere `/api/browse` serves,
    // which rules out the config dir, and `TMUXY_STATE_DIR` gives a test or a
    // second server somewhere of its own — two servers sharing a profile path
    // would fight over the lock.
    let state_dir = tmuxy_core::paths::state_dir();

    // The name becomes a directory name for the profile, so `../` or a slash in
    // it would place a profile somewhere nobody asked for.
    if !tmuxy_core::session::is_safe_session_name(&args.session) {
        fail(&format!("not a usable session name: {:?}", args.session));
    }

    if args.repl {
        let code = pane::run(&state_dir, &args.session, args.attach, args.goto).await;
        std::process::exit(code);
    }

    let line = args.line.join(" ");
    // Parsed before the engine is touched: a typo must not cost a browser
    // launch, and `help` has to work on a machine with no browser at all.
    let verb = match verbs::parse(&line) {
        Ok(verb) => verb,
        Err(verbs::ParseError::Empty) => {
            println!("{}", verbs::HELP);
            return;
        }
        Err(error) => fail(&error.to_string()),
    };
    if matches!(verb, verbs::Verb::Help) {
        println!("{}", verbs::HELP);
        return;
    }

    // A one-shot gets an engine of its own and gives it back. That is the honest
    // cost of asking a question with no pane to hold the answer's session:
    // about a second of Chromium start-up. Anything cheaper would mean a
    // background daemon, which is the thing this design just deleted.
    let mut session = match &args.attach {
        Some(endpoint) => Session::attach(&state_dir, &args.session, endpoint).await,
        None => Session::launch(&state_dir, &args.session).await,
    }
    .unwrap_or_else(|error| fail(&error.to_string()));

    let output = session.run(verb).await;
    session.close().await;

    match output {
        Ok(output) => show(&output),
        Err(error) => fail(&error.to_string()),
    }
}

/// Print what a verb said, or nothing when it had nothing to say.
///
/// The distinction is worth the function: a verb that answers with an empty
/// string printing a blank line, or `null`, puts a word in the pane that a
/// `capture-pane` reads as output and a person reads as an error.
fn show(output: &Output) {
    let text = output.to_string();
    if !text.is_empty() {
        println!("{text}");
    }
}

fn fail(message: &str) -> ! {
    eprintln!("tmuxy browser: {message}");
    std::process::exit(1);
}
