//! Running an action: open its surface, and run its command inside it.
//!
//! Two steps, so that no data ever rides a command line. A pane's command is
//! a string tmux hands to `$SHELL -c`, so it carries only names and an
//! invocation token from a fixed alphabet:
//!
//! 1. [`open`] (`tmuxy plugin action`, in the caller's process) writes the
//!    token file `.run/<token>.json` (owner-only) with everything the command
//!    should know (the target pane, its cwd, the selection) and opens the
//!    action's surface running `tmuxy plugin exec <plugin> <action> <token>`,
//!    the one tmux command list that changes anything going through
//!    `run-shell` (`job`).
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
    exec_command_line, notify_failure, open, surface_argv, wait, OpenRequest, Opened, Target,
};
pub use token::{is_pane_id, prepare, status_path, PaneInfo, Token, Trigger, MAX_SELECTION_BYTES};

use std::path::Path;

use super::manifest::Action;
use super::registry::{resolve_command, Installed, Registry};
use super::{private_dir, PluginError, Result};
use crate::paths::Layout;
use token::selection_path;

#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    pub action: Option<&'a str>,
    pub trigger: Trigger,
    pub pane: &'a str,
    pub info: Option<&'a PaneInfo>,
    pub selection_file: Option<&'a Path>,
    pub link: Option<&'a super::links::LinkInfo>,
}

/// `TMUXY_PLUGIN_CONTEXT_JSON`: the target pane, what started the command,
/// the link a click matched, and the settings in force (never a secret one).
pub fn context_json(dirs: &Layout, plugin: &Installed, ctx: Context<'_>) -> Result<String> {
    let info = ctx.info.cloned().unwrap_or_default();
    let mut context = serde_json::json!({
        "plugin": plugin.name,
        "trigger": ctx.trigger.as_str(),
        "pane": { "id": ctx.pane, "cwd": info.cwd, "command": info.command },
        "tab": info.tab,
        "session": info.session,
        "settings": super::settings::context_values(dirs, plugin)?,
    });
    if let Some(action) = ctx.action {
        context["action"] = action.into();
    }
    if let Some(file) = ctx.selection_file {
        context["selection_file"] = file.display().to_string().into();
    }
    if let Some(link) = ctx.link {
        context["link"] = serde_json::to_value(link).unwrap_or_default();
    }
    Ok(context.to_string())
}

/// The environment every plugin command gets (docs/PLUGIN-API.md).
pub fn plugin_env(
    dirs: &Layout,
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
pub fn exec(dirs: &Layout, name: &str, action_id: &str, token_id: &str) -> i32 {
    let (status, waited) = match exec_inner(dirs, name, action_id, token_id) {
        Ok(ran) => ran,
        Err(e) => {
            super::log::append(dirs, name, &format!("exec {name}:{action_id} failed: {e}"));
            eprintln!("tmuxy plugin {name}: {e}");
            // The token may be gone with whatever failed: a waiter that gets
            // no status stops when the pane closes.
            (1, true)
        }
    };
    if waited {
        let _ = crate::private_files::write(&status_path(dirs, token_id), status.to_string());
    }
    if status != 0 && std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        eprintln!("\n[{name}:{action_id} exited with status {status}; press Enter to close]");
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
    }
    status
}

/// The command's exit status, and whether someone waits for it.
fn exec_inner(dirs: &Layout, name: &str, action_id: &str, token_id: &str) -> Result<(i32, bool)> {
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
        dirs,
        plugin,
        Context {
            action: Some(action_id),
            trigger: token.trigger,
            pane: &token.pane,
            info: token.info.as_ref(),
            selection_file: selection_file.as_deref(),
            link: token.link.as_ref(),
        },
    )?;
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
    Ok((code, token.wait))
}

/// Spawn and wait, with this process ignoring the interrupt and quit keys
/// meanwhile: they reach the whole foreground group, and the child decides
/// what they mean. The exit is still logged after a Ctrl-C.
///
/// The disposition is process-wide, which is why this runs only in the
/// short-lived `tmuxy plugin exec` process a pane runs ([`exec`]), never in
/// a server. The child is spawned first, so it starts with the default
/// dispositions rather than inheriting the ignore.
fn run_waiting(cmd: &mut std::process::Command) -> std::io::Result<i32> {
    let mut child = cmd.spawn()?;
    // SAFETY: `signal` with `SIG_IGN` installs no handler code, so nothing
    // runs in signal context; both signal numbers are valid, so neither call
    // returns `SIG_ERR`.
    #[cfg(unix)]
    let previous = unsafe {
        (
            libc::signal(libc::SIGINT, libc::SIG_IGN),
            libc::signal(libc::SIGQUIT, libc::SIG_IGN),
        )
    };
    let status = child.wait();
    // SAFETY: puts back exactly the dispositions the calls above replaced
    // (the default, or an ignore this process was started with), so nothing
    // is installed that was not there before the wait.
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
pub fn cli_command(dirs: &Layout, verb: &str, args: &[String]) -> Result<std::process::Command> {
    let registry = Registry::load(dirs)?;
    let (plugin, cli) = registry
        .verb(verb)
        .ok_or_else(|| PluginError::NotFound(format!("no plugin has the verb {verb:?}")))?;
    let program = resolve_command(&plugin.root, &cli.command)?;
    let pane = std::env::var("TMUXY_CALLER_PANE")
        .ok()
        .filter(|p| is_pane_id(p))
        .unwrap_or_default();
    let context = context_json(
        dirs,
        plugin,
        Context {
            action: None,
            trigger: Trigger::Cli,
            pane: &pane,
            info: None,
            selection_file: None,
            link: None,
        },
    )?;
    let mut cmd = std::process::Command::new(program);
    cmd.args(&cli.command[1..])
        .args(args)
        .envs(plugin_env(dirs, plugin, &pane, context)?);
    super::log::append(dirs, &plugin.name, &format!("cli {verb}"));
    Ok(cmd)
}
