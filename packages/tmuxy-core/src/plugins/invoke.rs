//! Running an action: open its surface, and run its command inside it.
//!
//! Two steps, so that no data ever rides a command line. A pane's command is
//! a string tmux hands to `$SHELL -c`, so it carries only names and an
//! invocation token from a fixed alphabet:
//!
//! 1. [`open`] (`tmuxy plugin action`, inside `tmux run-shell`) writes the
//!    token file `.run/<token>.json` (owner-only) with everything the command
//!    should know — the target pane, its cwd, the selection — and opens the
//!    action's surface running `tmuxy plugin exec <plugin> <action> <token>`.
//! 2. [`exec`], the new pane's process, reads the token once (and deletes
//!    it), puts the selection in a file, sets the plugin's environment and
//!    runs the declared argv directly (`Command::new`, never a shell), with the
//!    plugin's directory as its working directory.
//!
//! The selection the client sends with a menu action reaches the token
//! through [`prepare`], which the web and desktop servers call
//! (`prepare_plugin_action`).

mod surface;
mod token;

pub use surface::{
    exec_command_line, free_index, notify_failure, open, surface_argv, wait, OpenRequest, Opened,
    Target,
};
pub use token::{is_pane_id, prepare, status_path, PaneInfo, Token, Trigger, MAX_SELECTION_BYTES};

use std::path::Path;

use super::manifest::Action;
use super::registry::{resolve_command, Installed, Registry};
use super::{private_dir, Dirs, PluginError, Result};
use token::selection_path;

/// `TMUXY_PLUGIN_CONTEXT_JSON`.
pub fn context_json(
    plugin: &Installed,
    action: Option<&str>,
    trigger: Trigger,
    pane: &str,
    info: Option<&PaneInfo>,
    selection_file: Option<&Path>,
) -> String {
    let info = info.cloned().unwrap_or_default();
    let mut context = serde_json::json!({
        "plugin": plugin.name,
        "trigger": trigger.as_str(),
        "pane": { "id": pane, "cwd": info.cwd, "command": info.command },
        "tab": info.tab,
        "session": info.session,
        "settings": {},
    });
    if let Some(action) = action {
        context["action"] = action.into();
    }
    if let Some(file) = selection_file {
        context["selection_file"] = file.display().to_string().into();
    }
    context.to_string()
}

/// The environment every plugin command gets.
pub fn plugin_env(
    dirs: &Dirs,
    plugin: &Installed,
    pane: &str,
    context: String,
) -> Result<Vec<(String, String)>> {
    let config = dirs.plugin_config(&plugin.name);
    let state = dirs.plugin_state(&plugin.name);
    private_dir(&config)?;
    private_dir(&state)?;
    Ok(vec![
        ("TMUXY_PLUGIN_NAME".into(), plugin.name.clone()),
        ("TMUXY_PLUGIN_DIR".into(), plugin.root.display().to_string()),
        (
            "TMUXY_PLUGIN_CONFIG_DIR".into(),
            config.display().to_string(),
        ),
        ("TMUXY_PLUGIN_STATE_DIR".into(), state.display().to_string()),
        ("TMUXY_TARGET_PANE".into(), pane.to_string()),
        ("TMUXY_PLUGIN_CONTEXT_JSON".into(), context),
    ])
}

fn command_for(
    plugin: &Installed,
    action: &Action,
    extra: &[String],
) -> Result<std::process::Command> {
    let program = resolve_command(&plugin.root, &action.command)?;
    let mut cmd = std::process::Command::new(program);
    cmd.args(&action.command[1..])
        .args(extra)
        .current_dir(&plugin.root);
    Ok(cmd)
}

/// Run an action's command as the process of the pane [`open`] made, and
/// return its exit status. Never returns an `Err`: what went wrong is
/// printed in the pane and logged, so the user sees it there.
pub fn exec(dirs: &Dirs, name: &str, action_id: &str, token_id: &str) -> i32 {
    let status = match exec_inner(dirs, name, action_id, token_id) {
        Ok(code) => code,
        Err(e) => {
            super::log::append(dirs, name, &format!("exec {name}:{action_id} failed: {e}"));
            eprintln!("tmuxy plugin {name}: {e}");
            1
        }
    };
    let _ = std::fs::write(status_path(dirs, token_id), status.to_string());
    if status != 0 && std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        eprintln!("\n[{name}:{action_id} exited with status {status}; press Enter to close]");
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
    }
    status
}

fn exec_inner(dirs: &Dirs, name: &str, action_id: &str, token_id: &str) -> Result<i32> {
    let token = Token::take(dirs, token_id)?;
    if token.plugin != name || token.action != action_id {
        return Err(PluginError::Invalid(
            "the invocation token is for another action".into(),
        ));
    }
    let registry = Registry::load(dirs)?;
    let (plugin, action) = registry.action(name, action_id)?;

    let selection_file = match &token.selection {
        Some(text) => {
            let path = selection_path(dirs, token_id);
            crate::private_files::write(&path, text.as_bytes())
                .map_err(|e| PluginError::io(format!("writing {}", path.display()), e))?;
            Some(path)
        }
        None => None,
    };
    let context = context_json(
        plugin,
        Some(action_id),
        token.trigger,
        &token.pane,
        token.info.as_ref(),
        selection_file.as_deref(),
    );
    let mut cmd = command_for(plugin, action, &token.args)?;
    cmd.envs(plugin_env(dirs, plugin, &token.pane, context)?);
    if let Some(file) = &selection_file {
        cmd.env("TMUXY_SELECTION_FILE", file);
    }
    super::log::append(
        dirs,
        name,
        &format!("start {name}:{action_id} in {}", token.pane),
    );
    let result = run_waiting(&mut cmd);
    if let Some(file) = &selection_file {
        let _ = std::fs::remove_file(file);
    }
    let code =
        result.map_err(|e| PluginError::io(format!("running {:?}", action.command[0]), e))?;
    super::log::append(
        dirs,
        name,
        &format!("exit {name}:{action_id} status {code}"),
    );
    Ok(code)
}

/// Spawn and wait, with this process ignoring the interrupt and quit keys
/// meanwhile: they reach the whole foreground group, and the child decides
/// what they mean. The exit is still logged after a Ctrl-C.
fn run_waiting(cmd: &mut std::process::Command) -> std::io::Result<i32> {
    let mut child = cmd.spawn()?;
    #[cfg(unix)]
    let previous = unsafe {
        (
            libc::signal(libc::SIGINT, libc::SIG_IGN),
            libc::signal(libc::SIGQUIT, libc::SIG_IGN),
        )
    };
    let status = child.wait();
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGINT, previous.0);
        libc::signal(libc::SIGQUIT, previous.1);
    }
    let status = status?;
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return Ok(128 + signal);
        }
    }
    Ok(status.code().unwrap_or(1))
}

/// The command a `[[cli]]` verb runs, with the plugin's environment, in the
/// caller's working directory (the verb is the user's own command, run from
/// their shell). The CLI `exec`s it.
pub fn cli_command(dirs: &Dirs, verb: &str, args: &[String]) -> Result<std::process::Command> {
    let registry = Registry::load(dirs)?;
    let (plugin, cli) = registry
        .verb(verb)
        .ok_or_else(|| PluginError::NotFound(format!("no plugin has the verb {verb:?}")))?;
    let program = resolve_command(&plugin.root, &cli.command)?;
    let pane = std::env::var("TMUXY_CALLER_PANE")
        .ok()
        .filter(|p| is_pane_id(p))
        .unwrap_or_default();
    let context = context_json(plugin, None, Trigger::Cli, &pane, None, None);
    let mut cmd = std::process::Command::new(program);
    cmd.args(&cli.command[1..])
        .args(args)
        .envs(plugin_env(dirs, plugin, &pane, context)?);
    super::log::append(dirs, &plugin.name, &format!("cli {verb}"));
    Ok(cmd)
}
