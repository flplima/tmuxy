//! `tmuxy plugin config <name> [<key> [<value>]] [--unset]`: a plugin's
//! settings (`plugins::settings`). A secret is never printed, only whether
//! it is set; setting one without a value reads it from the terminal with
//! echo off, so it lands in neither the shell history nor `ps`.

use tmuxy_core::paths::Layout;
use tmuxy_core::plugins::registry::Registry;
use tmuxy_core::plugins::{settings, PluginError};

use super::{say, usage, Failure, Outcome};

pub(super) fn config(
    dirs: &Layout,
    name: &str,
    key: Option<String>,
    value: Option<String>,
    unset: bool,
    json: bool,
) -> Outcome {
    let registry = Registry::load(dirs)?;
    let plugin = registry.require(name)?;
    let Some(key) = key else {
        if unset || value.is_some() {
            return Err(usage(
                "name the setting: tmuxy plugin config <name> <key> …",
            ));
        }
        let rows: Vec<serde_json::Value> = settings::current(dirs, plugin)
            .iter()
            .map(|c| {
                serde_json::json!({
                    "key": c.setting.key,
                    "type": c.setting.kind.describe(),
                    "value": settings::shown(c),
                    "set": c.set.is_some(),
                    "secret": c.setting.secret,
                    "description": c.setting.description,
                })
            })
            .collect();
        if rows.is_empty() {
            say(json, format!("plugin {name} has no settings"));
        }
        for row in &rows {
            let mark = if row["set"] == true { "" } else { " (default)" };
            say(
                json,
                format!(
                    "{:<20} {:<12} {}{mark}  {}",
                    row["key"].as_str().unwrap_or_default(),
                    row["value"].as_str().unwrap_or_default(),
                    row["type"].as_str().unwrap_or_default(),
                    row["description"].as_str().unwrap_or_default(),
                ),
            );
        }
        return Ok(serde_json::json!({ "settings": rows }));
    };
    if unset {
        if value.is_some() {
            return Err(usage("--unset takes no value"));
        }
        settings::unset(dirs, plugin, &key)?;
        say(json, format!("{name}.{key} is back to its default"));
        return Ok(serde_json::json!({ "key": key, "unset": true }));
    }
    let current = settings::current(dirs, plugin);
    let Some(entry) = current.iter().find(|c| c.setting.key == key) else {
        return Err(
            PluginError::NotFound(format!("plugin {name:?} has no setting {key:?}")).into(),
        );
    };
    let secret = entry.setting.secret;
    let value = match value {
        Some(value) => value,
        None if secret => read_secret(&format!("{name}.{key}: "))?,
        None => {
            let shown = settings::shown(entry);
            say(json, &shown);
            return Ok(serde_json::json!({ "key": key, "value": shown }));
        }
    };
    let stored = settings::set(dirs, plugin, &key, &value)?;
    let shown = if secret {
        "set".to_string()
    } else {
        stored.display()
    };
    say(json, format!("{name}.{key} = {shown}"));
    Ok(serde_json::json!({ "key": key, "value": shown }))
}

/// A line from the terminal with echo off.
fn read_secret(prompt: &str) -> Result<String, Failure> {
    use std::io::{BufRead, Write};
    let tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| usage("no terminal to read the secret from; pass the value"))?;
    let mut writer = &tty;
    let _ = write!(writer, "{prompt}");
    let _ = writer.flush();
    let restore = echo_off(&tty);
    let mut line = String::new();
    let read = std::io::BufReader::new(&tty).read_line(&mut line);
    if let Some(saved) = restore {
        echo_restore(&tty, saved);
    }
    let _ = writeln!(writer);
    read.map_err(|e| Failure::from(PluginError::io("reading the secret", e)))?;
    Ok(line.trim_end_matches(['\n', '\r']).to_string())
}

#[cfg(unix)]
fn echo_off(tty: &std::fs::File) -> Option<libc::termios> {
    use std::os::unix::io::AsRawFd;
    let fd = tty.as_raw_fd();
    // SAFETY: tcgetattr/tcsetattr on a terminal fd this function holds open,
    // with a termios the call itself filled in.
    unsafe {
        let mut term: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut term) != 0 {
            return None;
        }
        let saved = term;
        term.c_lflag &= !libc::ECHO;
        (libc::tcsetattr(fd, libc::TCSANOW, &term) == 0).then_some(saved)
    }
}

#[cfg(unix)]
fn echo_restore(tty: &std::fs::File, saved: libc::termios) {
    use std::os::unix::io::AsRawFd;
    // SAFETY: as in `echo_off`, restoring what it saved.
    unsafe {
        libc::tcsetattr(tty.as_raw_fd(), libc::TCSANOW, &saved);
    }
}

#[cfg(not(unix))]
fn echo_off(_tty: &std::fs::File) -> Option<()> {
    None
}

#[cfg(not(unix))]
fn echo_restore(_tty: &std::fs::File, _saved: ()) {}
