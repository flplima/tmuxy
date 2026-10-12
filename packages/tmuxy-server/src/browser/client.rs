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
//! Two shapes, both a pane program (`pane`) that draws the page and reads input:
//!
//!   * `tmuxy browser [url]` — launches its own engine on a throwaway profile.
//!   * `tmuxy browser --attach <ws://…> [url]` — drives a browser somebody else
//!     started. See `--attach`'s own help for why that is the escape hatch for
//!     a desktop build and for the user's real profile.
//!
//! `tmuxy open <url>` lands here too for a website (`tmuxy-widget-browser`):
//! the app draws its address bar over the pane's top row, and the page below
//! is this program's picture.
//!
//! To drive a session that is already open in a pane, send it a line: the pane
//! program's `:` command mode reads keys from the pty, so `tmuxy pane send -t
//! %7 ':goto example.com' Enter` works from any other pane or agent, and
//! `tmuxy pane capture` reads the answer back off the status row. That is the
//! whole agent protocol, and it needed no API.

use super::pane;

/// A browser pane, from the command line.
#[derive(clap::Args, Debug)]
pub struct BrowserArgs {
    /// The session. Names the throwaway profile, so one engine per name. The
    /// default is per pane: two browser panes on one name would fight over the
    /// profile's lock, and the second would never start.
    #[arg(long)]
    pub session: Option<String>,
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
    /// Recolour the page into the theme's colours, as `tmuxy open
    /// --color-filter` does: the app applies it to the picture.
    #[arg(long)]
    pub color_filter: bool,
    /// The page to open (a bare host gets a scheme). What a restored browser
    /// pane is handed: the pane writes `@tmuxy-pane-restore` with the page it
    /// is on, so a session snapshot brings it back here.
    pub url: Option<String>,
}

/// `tmuxy browser …`.
pub async fn run(args: BrowserArgs) {
    // A session's profile and screenshots live under the state dir: a profile
    // is a few hundred MB and must not land anywhere `/api/browse` serves,
    // which rules out the config dir, and `TMUXY_STATE_DIR` gives a test or a
    // second server somewhere of its own — two servers sharing a profile path
    // would fight over the lock.
    let state_dir = tmuxy_core::paths::state_dir();

    let named = args.session.is_some();
    let session = args
        .session
        .unwrap_or_else(|| default_session(std::env::var("TMUX_PANE").ok().as_deref()));
    // The name becomes a directory name for the profile, so `../` or a slash in
    // it would place a profile somewhere nobody asked for.
    if !tmuxy_core::session::is_safe_session_name(&session) {
        fail(&format!("not a usable session name: {session:?}"));
    }

    let code = pane::run(
        &state_dir,
        &session,
        named,
        args.attach,
        args.url,
        args.color_filter,
    )
    .await;
    std::process::exit(code);
}

/// The session a pane gets when none is named: its own, from `$TMUX_PANE`.
fn default_session(tmux_pane: Option<&str>) -> String {
    match tmux_pane.map(|p| p.trim_start_matches('%')) {
        Some(id) if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) => {
            format!("pane-{id}")
        }
        _ => "default".to_string(),
    }
}

fn fail(message: &str) -> ! {
    eprintln!("tmuxy browser: {message}");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::default_session;

    #[test]
    fn each_pane_gets_a_session_of_its_own() {
        assert_eq!(default_session(Some("%12")), "pane-12");
        assert_eq!(default_session(None), "default");
        assert_eq!(default_session(Some("../x")), "default");
    }
}
