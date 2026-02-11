use std::process::Command;
use std::path::PathBuf;

use crate::DEFAULT_SESSION_NAME;

/// Get the path to the tmuxy config file.
/// Checks: ~/.tmuxy.conf, then docker/.tmuxy.conf relative to working directory.
pub fn get_config_path() -> Option<PathBuf> {
    let home_config = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".tmuxy.conf");
    if home_config.exists() {
        return Some(home_config);
    }

    // Check docker/.tmuxy.conf relative to working directory or ancestor
    if let Ok(mut dir) = std::env::current_dir() {
        loop {
            let docker_config = dir.join("docker/.tmuxy.conf");
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
    let config_str = config_path.as_ref().map(|p| p.to_string_lossy().to_string());
    if let Some(ref cs) = config_str {
        args.insert(0, "-f");
        args.insert(1, cs);
    }

    Command::new("tmux")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to create session: {}", e))?;

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

// Convenience functions using default session name
pub fn session_exists_default() -> Result<bool, String> {
    session_exists(DEFAULT_SESSION_NAME)
}

pub fn create_session_default() -> Result<(), String> {
    create_session(DEFAULT_SESSION_NAME)
}

pub fn create_or_attach_default() -> Result<(), String> {
    create_or_attach(DEFAULT_SESSION_NAME)
}

pub fn kill_session_default() -> Result<(), String> {
    kill_session(DEFAULT_SESSION_NAME)
}
