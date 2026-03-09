use std::path::PathBuf;
use std::process::Command;

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
    let output = Command::new("tmux")
        .args(["has-session", "-t", session_name])
        .output()
        .map_err(|e| format!("Failed to check session: {}", e))?;

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

    let output = Command::new("tmux")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to create session: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
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
    Command::new("tmux")
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
    Command::new("tmux")
        .args(["kill-session", "-t", session_name])
        .output()
        .map_err(|e| format!("Failed to kill session: {}", e))?;

    Ok(())
}
