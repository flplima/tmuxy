use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Resolved path to the tmux binary, cached after first lookup.
static TMUX_PATH: OnceLock<String> = OnceLock::new();

/// Find the tmux binary path.
///
/// macOS GUI apps (.app bundles) inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// that excludes Homebrew, MacPorts, and Nix paths. We check common locations explicitly
/// so the Tauri desktop app works when launched from Finder/Spotlight.
fn find_tmux() -> String {
    // Explicit env override
    if let Ok(path) = std::env::var("TMUX_BIN") {
        if std::path::Path::new(&path).exists() {
            return path;
        }
    }

    // Try PATH first (works in terminals, CI, and Linux desktop)
    if let Ok(output) = Command::new("which").arg("tmux").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    // Common locations not in macOS GUI PATH
    let candidates = [
        "/opt/homebrew/bin/tmux", // Homebrew on Apple Silicon
        "/usr/local/bin/tmux",    // Homebrew on Intel Mac / Linux manual install
        "/usr/bin/tmux",          // System package (apt, yum)
        "/run/current-system/sw/bin/tmux", // NixOS
        "/nix/var/nix/profiles/default/bin/tmux", // Nix single-user
    ];
    for path in candidates {
        if std::path::Path::new(path).exists() {
            return path.to_string();
        }
    }

    // Fallback — let the OS try to resolve it
    "tmux".to_string()
}

/// Get the resolved tmux binary path (cached).
pub fn tmux_path() -> &'static str {
    TMUX_PATH.get_or_init(|| find_tmux())
}

/// Create a `Command` for tmux that respects the `TMUX_SOCKET` environment variable.
/// When `TMUX_SOCKET` is set, adds `-L <socket>` to connect to the named tmux server.
pub fn tmux_command() -> Command {
    let mut cmd = Command::new(tmux_path());
    if let Ok(socket) = std::env::var("TMUX_SOCKET") {
        if !socket.is_empty() {
            cmd.args(["-L", &socket]);
        }
    }
    cmd
}

/// Build the tmux shell command string with socket flag for use in shell invocations.
/// Returns e.g. "/opt/homebrew/bin/tmux -L tmuxy-dev" or just "/usr/bin/tmux".
pub fn tmux_bin() -> String {
    let bin = tmux_path();
    match std::env::var("TMUX_SOCKET") {
        Ok(socket) if !socket.is_empty() => format!("{} -L {}", bin, socket),
        _ => bin.to_string(),
    }
}

/// Default tmuxy configuration content.
/// Embedded at compile time from .devcontainer/.tmuxy.conf.
const DEFAULT_CONFIG: &str = include_str!("../../../.devcontainer/.tmuxy.conf");

/// Get the path to the tmuxy config file.
/// Checks: ~/.config/tmuxy/tmuxy.conf, ~/.tmuxy.conf, then .devcontainer/.tmuxy.conf.
pub fn get_config_path() -> Option<PathBuf> {
    // XDG-style config location
    let xdg_config = dirs::config_dir()
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
        })
        .join("tmuxy/tmuxy.conf");
    if xdg_config.exists() {
        return Some(xdg_config);
    }

    let home_config = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".tmuxy.conf");
    if home_config.exists() {
        return Some(home_config);
    }

    // Check .devcontainer/.tmuxy.conf relative to working directory or ancestor
    if let Ok(mut dir) = std::env::current_dir() {
        loop {
            let docker_config = dir.join(".devcontainer/.tmuxy.conf");
            if docker_config.exists() {
                return Some(docker_config);
            }
            if !dir.pop() {
                break;
            }
        }
    }

    None
}

/// Ensure the default config exists at ~/.config/tmuxy/tmuxy.conf.
/// Creates the directory and file with defaults if they don't exist.
/// Returns the path to the config file.
pub fn ensure_config() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
        })
        .join("tmuxy");
    let config_path = config_dir.join("tmuxy.conf");

    if !config_path.exists() {
        if let Err(e) = std::fs::create_dir_all(&config_dir) {
            eprintln!(
                "Warning: could not create config dir {:?}: {}",
                config_dir, e
            );
            return config_path;
        }
        if let Err(e) = std::fs::write(&config_path, DEFAULT_CONFIG) {
            eprintln!(
                "Warning: could not write default config to {:?}: {}",
                config_path, e
            );
        } else {
            eprintln!("Created default config at {:?}", config_path);
        }
    }

    config_path
}

pub fn session_exists(session_name: &str) -> Result<bool, String> {
    crate::debug_log::log_cmd("has-session", tmux_path(), &["has-session", "-t", session_name]);
    let output = tmux_command()
        .args(["has-session", "-t", session_name])
        .output()
        .map_err(|e| format!("Failed to check session: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    crate::debug_log::log_cmd_result("has-session", output.status.code(), &stdout, &stderr);
    Ok(output.status.success())
}

pub fn create_session(session_name: &str) -> Result<(), String> {
    let config_path = get_config_path();

    let mut args = vec!["new-session", "-d", "-s", session_name];

    // Use custom config if it exists
    let config_str = config_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    if let Some(ref cs) = config_str {
        args.insert(0, "-f");
        args.insert(1, cs);
    }

    let args_ref: Vec<&str> = args.iter().map(|s| &**s).collect();
    crate::debug_log::log_cmd("create-session", tmux_path(), &args_ref);
    let output = tmux_command()
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to create session: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    crate::debug_log::log_cmd_result("create-session", output.status.code(), &stdout, &stderr);

    if !output.status.success() {
        return Err(format!(
            "tmux new-session failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    Ok(())
}

/// Source the tmuxy config file in an existing session
pub fn source_config(_session_name: &str) -> Result<(), String> {
    let Some(config_path) = get_config_path() else {
        return Ok(()); // No config to source
    };

    let config_str = config_path.to_string_lossy().to_string();
    tmux_command()
        .args(["source-file", &config_str])
        .output()
        .map_err(|e| format!("Failed to source config: {}", e))?;

    Ok(())
}

pub fn create_or_attach(session_name: &str) -> Result<(), String> {
    if !session_exists(session_name)? {
        create_session(session_name)?;
    } else {
        // Source config for existing session
        let _ = source_config(session_name);
    }
    Ok(())
}

pub fn kill_session(session_name: &str) -> Result<(), String> {
    tmux_command()
        .args(["kill-session", "-t", session_name])
        .output()
        .map_err(|e| format!("Failed to kill session: {}", e))?;

    Ok(())
}
