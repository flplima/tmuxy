use std::path::PathBuf;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Find the tmuxy-cli shell script.
///
/// Search order:
/// 1. $TMUXY_SCRIPTS env var
/// 2. ~/.config/tmuxy/bin/tmuxy-cli (materialized by ensure_bin_scripts;
///    the canonical location whenever the .app has been launched at least
///    once on this machine)
/// 3. Relative to binary: ../../../bin/tmuxy-cli (dev layout)
/// 4. Relative to binary: ../share/tmuxy/bin/tmuxy-cli (Linux installed layout)
/// 5. Same directory as binary (flat fallback)
fn find_cli_script() -> Option<PathBuf> {
    // Env override
    if let Ok(dir) = std::env::var("TMUXY_SCRIPTS") {
        let p = PathBuf::from(dir).join("tmuxy-cli");
        if p.exists() {
            return Some(p);
        }
    }

    // Materialized location (~/.config/tmuxy/bin/tmuxy-cli). Materialize
    // first if the GUI has never run — gives `tmuxy pane list` from a fresh
    // shell something to dispatch into.
    let user_bin = tmuxy_core::session::ensure_bin_scripts().join("tmuxy-cli");
    if user_bin.exists() {
        return Some(user_bin);
    }

    // Relative to binary
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            // Dev layout: target/debug/tmuxy → repo/bin/tmuxy-cli
            let dev = bin_dir
                .join("..")
                .join("..")
                .join("..")
                .join("bin")
                .join("tmuxy-cli");
            if dev.exists() {
                return Some(dev);
            }

            // Installed layout: bin/tmuxy → share/tmuxy/bin/tmuxy-cli
            let installed = bin_dir
                .join("..")
                .join("share")
                .join("tmuxy")
                .join("bin")
                .join("tmuxy-cli");
            if installed.exists() {
                return Some(installed);
            }

            // Flat layout: same directory as binary
            let flat = bin_dir.join("tmuxy-cli");
            if flat.exists() {
                return Some(flat);
            }
        }
    }

    None
}

/// Execute a CLI command by exec-ing the shell dispatcher.
/// On Unix, this replaces the current process (no overhead).
/// On non-Unix, falls back to spawning a child process.
pub fn run_cli(args: Vec<String>) {
    let script = match find_cli_script() {
        Some(s) => s,
        None => {
            eprintln!("Error: tmuxy-cli script not found.");
            eprintln!("Set TMUXY_SCRIPTS to the directory containing tmuxy-cli.");
            std::process::exit(1);
        }
    };

    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let script_c = CString::new(script.as_os_str().as_bytes()).unwrap();
        let mut argv: Vec<CString> = vec![CString::new("tmuxy").unwrap()];
        for arg in &args {
            argv.push(CString::new(arg.as_str()).unwrap());
        }
        // exec replaces the process — only returns on error
        let Err(e) = nix::unistd::execvp(&script_c, &argv);
        eprintln!("Failed to exec tmuxy-cli: {}", e);
        std::process::exit(1);
    }

    #[cfg(not(unix))]
    {
        let status = std::process::Command::new(&script)
            .args(&args)
            .status()
            .unwrap_or_else(|e| {
                eprintln!("Failed to run tmuxy-cli: {}", e);
                std::process::exit(1);
            });
        std::process::exit(status.code().unwrap_or(1));
    }
}

/// Run the `tmuxy connect` add-a-server form (a ratatui TUI) in-process. The
/// desktop app opens this in a float; running it from this binary — which links
/// the form via `tmuxy-server` — avoids shipping a separate `tmuxy-connect`
/// executable in the bundle. On success the new server's id is printed.
pub fn run_connect_form() {
    match tmuxy_server::connect::run_connect_tui() {
        Ok(Some(id)) => println!("{id}"),
        Ok(None) => {}
        Err(e) => {
            eprintln!("tmuxy connect: {e}");
            std::process::exit(1);
        }
    }
}

/// Run the web server mode (delegates to tmuxy-server).
pub fn run_server(args: Vec<String>) {
    use clap::Parser;
    use tmuxy_server::server;

    /// Wrapper to parse ServerArgs from the command line.
    #[derive(Parser)]
    #[command(name = "tmuxy server", about = "Tmuxy web server")]
    struct ServerCli {
        #[command(flatten)]
        server: server::ServerArgs,
    }

    // Match the standalone `tmuxy-server` binary: without a subscriber, every
    // server log — including the fatal dev-mode port-collision message — is
    // silently dropped, so `tmuxy server` would exit with no diagnostic output.
    tmuxy_server::init_logging();

    // Build synthetic argv: "tmuxy-server" + everything after "server"
    let mut argv = vec!["tmuxy-server".to_string()];
    argv.extend(args.into_iter().skip(1)); // skip "server"

    let cli = match ServerCli::try_parse_from(&argv) {
        Ok(a) => a,
        Err(e) => e.exit(),
    };

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(server::run(cli.server));
}

pub fn print_help() {
    println!(
        "tmuxy {VERSION} — AI-first terminal multiplexer

Usage: tmuxy [command] [args...]

Commands:
  (no args)     Open the desktop GUI application
  gui           Open the desktop GUI application
  server        Start the web server (--port, --host, --dev)
  connect       Add a tmux server (form), or reconnect to one: connect [socket]
  pane          Pane operations (split, kill, select, resize, ...)
  tab           Tab operations (create, kill, select, rename, ...)
  session       Session management (switch, connect)
  widget        Display widgets (image, markdown)
  nav           Navigation (left, right, up, down, next, prev)
  event         Event queue (emit, wait, list)
  run           Run a raw tmux command safely

Options:
  -h, --help    Show this help
  -V, --version Show version

Run 'tmuxy <command> --help' for details on each command."
    );
}

pub fn print_version() {
    println!("tmuxy {}", VERSION);
}
