#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod commands;
mod gui;
mod monitor;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    match args.first().map(|s| s.as_str()) {
        // No args or explicit "gui" → Tauri window
        None | Some("gui") => gui::run(),

        // "server" → web server mode (delegates to tmuxy-server)
        Some("server") => cli::run_server(args),

        // Known CLI nouns → exec the shell dispatcher
        Some("pane" | "tab" | "session" | "widget" | "nav" | "event" | "run") => {
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
