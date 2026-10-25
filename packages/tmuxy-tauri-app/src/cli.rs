use std::path::PathBuf;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Find the tmuxy-cli shell script.
///
/// Search order:
/// 1. $TMUXY_SCRIPTS env var
/// 2. ~/.config/tmuxy/bin/tmuxy-cli (materialized by ensure_bin_scripts;
///    the canonical location whenever the .app has been launched at least
///    once on this machine)
/// 3. Relative to binary: ../../../packages/tmuxy-cli/bin/tmuxy-cli (dev layout)
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
            // Dev layout: target/debug/tmuxy → repo/packages/tmuxy-cli/bin/tmuxy-cli
            let dev = bin_dir
                .join("..")
                .join("..")
                .join("..")
                .join("packages")
                .join("tmuxy-cli")
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

    if std::env::var_os(tmuxy_core::session::SERVER_BIN_ENV).is_none() {
        if let Ok(exe) = std::env::current_exe() {
            std::env::set_var(tmuxy_core::session::SERVER_BIN_ENV, exe);
            std::env::set_var(tmuxy_core::session::SERVER_SUBCOMMAND_ENV, "server");
        }
    }

    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        // A NUL byte cannot reach exec; an argument carrying one is refused
        // here rather than taken down with a panic.
        let c_string = |bytes: &[u8]| {
            CString::new(bytes).unwrap_or_else(|_| {
                eprintln!("Error: an argument contains a NUL byte");
                std::process::exit(1);
            })
        };
        let script_c = c_string(script.as_os_str().as_bytes());
        let mut argv: Vec<CString> = vec![c_string(b"tmuxy")];
        for arg in &args {
            argv.push(c_string(arg.as_bytes()));
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

/// Run the web server mode (delegates to tmuxy-server).
pub fn run_server(args: Vec<String>) {
    // Match the standalone `tmuxy-server` binary: without a subscriber, every
    // server log — including the fatal dev-mode port-collision message — is
    // silently dropped, so `tmuxy server` would exit with no diagnostic output.
    tmuxy_server::init_logging();
    // Everything after the `server` noun is the server's own command line.
    run_server_argv(args.into_iter().skip(1));
}

/// Run `tmuxy trace ...` (inspect/export a local action-trace file). The
/// server's `Trace` subcommand; unlike `run_server`, the noun is kept so clap
/// sees `trace` as the subcommand.
pub fn run_trace(args: Vec<String>) {
    run_server_argv(args);
}

/// `tmuxy-server <args>`, parsed and run by the server crate on a runtime of
/// this binary's own.
fn run_server_argv(args: impl IntoIterator<Item = String>) {
    let argv = std::iter::once("tmuxy-server".to_string()).chain(args);
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| {
            eprintln!("Error: cannot start the server runtime: {e}");
            std::process::exit(1);
        })
        .block_on(tmuxy_server::server::run_argv(argv));
}

/// The dispatcher's own help, which lists every noun it serves — a copy kept
/// here went stale as nouns were added.
pub fn print_help() {
    run_cli(vec!["--help".to_string()]);
}

pub fn print_version() {
    println!("tmuxy {}", VERSION);
}
