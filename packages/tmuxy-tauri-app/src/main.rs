#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod commands;
#[cfg(target_os = "linux")]
mod desktop;
mod gui;
mod monitor;

fn main() {
    // Register with the applications menu before dispatching, so a user who
    // only ever runs `tmuxy server` still gets a launcher. No-ops in a few
    // microseconds once the entry is current.
    #[cfg(target_os = "linux")]
    desktop::ensure_entry();

    let args: Vec<String> = std::env::args().skip(1).collect();

    match args.first().map(|s| s.as_str()) {
        // No args or explicit "gui" → Tauri window
        None | Some("gui") => gui::run(),

        // "server" → web server mode (delegates to tmuxy-server)
        Some("server") => cli::run_server(args),

        // "trace" → inspect/export a local action-trace file (docs/TELEMETRY.md)
        Some("trace") => cli::run_trace(args),

        // "connect" with no socket → run the add-a-server form TUI in-process
        // (this binary links it via tmuxy-server); with a socket it's the shell
        // dispatcher's live-reconnect request. Handling the form here means the
        // packaged .app needs no separate `tmuxy-connect` binary on PATH.
        Some("connect") if args.len() == 1 => cli::run_connect_form(),

        // Known CLI nouns → exec the shell dispatcher
        Some("pane" | "tab" | "session" | "widget" | "nav" | "event" | "run" | "connect") => {
            cli::run_cli(args);
        }

        // Help and version
        Some("--help" | "-h" | "help") => cli::print_help(),
        Some("--version" | "-V" | "version") => cli::print_version(),

        // Unknown command
        Some(unknown) => {
            eprintln!("tmuxy: unknown command '{}'\n", unknown);
            cli::print_help();
            std::process::exit(1);
        }
    }
}
