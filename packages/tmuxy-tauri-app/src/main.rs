#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod commands;
#[cfg(target_os = "linux")]
mod desktop;
mod gui;
mod monitor;
mod titlebar;
mod window_style;
mod windows;

fn main() {
    // Register with the applications menu before dispatching, so a user who
    // only ever runs `tmuxy server` still gets a launcher. No-ops in a few
    // microseconds once the entry is current.
    #[cfg(target_os = "linux")]
    desktop::ensure_entry();

    let args: Vec<String> = std::env::args().skip(1).collect();

    use std::io::IsTerminal;

    match args.first().map(|s| s.as_str()) {
        // No args: in terminal or inside tmux session, run CLI info; otherwise GUI
        None => {
            if std::env::var("TMUX").is_ok() || std::io::stdout().is_terminal() {
                cli::run_cli(vec!["info".to_string()]);
            } else {
                gui::run();
            }
        }
        Some(_) => match app_command(&args) {
            Some(AppCommand::Gui) => gui::run(),
            Some(AppCommand::Server) => cli::run_server(args),
            Some(AppCommand::Trace) => cli::run_trace(args),
            Some(AppCommand::ConnectForm) => cli::run_connect_form(),
            Some(AppCommand::Help) => cli::print_help(),
            Some(AppCommand::Version) => cli::print_version(),
            // Every other noun — and an unknown one, which it reports — is the
            // shell dispatcher's, so a noun added there needs nothing here.
            None => cli::run_cli(args),
        },
    }
}

/// What this binary runs itself rather than handing to the shell dispatcher.
#[derive(Debug, PartialEq, Eq)]
enum AppCommand {
    /// The desktop window.
    Gui,
    /// The web server (delegates to tmuxy-server).
    Server,
    /// Inspect/export a local action-trace file (docs/TELEMETRY.md).
    Trace,
    /// `connect` with no socket: the add-a-server form, run in-process because
    /// this binary links it (via tmuxy-server), so the packaged app needs no
    /// separate binary on PATH. With a socket, `connect` is the dispatcher's
    /// live-reconnect request.
    ConnectForm,
    Help,
    Version,
}

fn app_command(args: &[String]) -> Option<AppCommand> {
    Some(match args.first()?.as_str() {
        "gui" => AppCommand::Gui,
        "server" => AppCommand::Server,
        "trace" => AppCommand::Trace,
        "connect" if args.len() == 1 => AppCommand::ConnectForm,
        "--help" | "-h" | "help" => AppCommand::Help,
        "--version" | "-V" | "version" => AppCommand::Version,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    /// The dispatcher's nouns used to be listed here as well, and the copy
    /// went stale: `open`, `ask`, `tree`, `browser`, `cleanup` and `config`
    /// were "unknown command" from the desktop binary.
    #[test]
    fn every_dispatcher_noun_is_forwarded() {
        for noun in [
            "pane", "tab", "session", "widget", "nav", "queue", "q", "run", "info", "skill",
            "open", "ask", "tree", "browser", "cleanup", "config", "--json", "-j",
        ] {
            assert_eq!(app_command(&args(&[noun, "x"])), None, "{noun}");
        }
        assert_eq!(app_command(&args(&["connect", "other-socket"])), None);
        assert_eq!(app_command(&args(&["no-such-noun"])), None);
    }

    #[test]
    fn the_apps_own_commands_stay_in_the_app() {
        assert_eq!(app_command(&args(&["gui"])), Some(AppCommand::Gui));
        assert_eq!(
            app_command(&args(&["server", "--port", "1"])),
            Some(AppCommand::Server)
        );
        assert_eq!(app_command(&args(&["trace"])), Some(AppCommand::Trace));
        assert_eq!(
            app_command(&args(&["connect"])),
            Some(AppCommand::ConnectForm)
        );
        assert_eq!(app_command(&args(&["help"])), Some(AppCommand::Help));
        assert_eq!(app_command(&args(&["-V"])), Some(AppCommand::Version));
    }
}
