//! Opening an action's surface: the one tmux command list per surface, run
//! through `tmux run-shell` (`job`).

use std::path::{Path, PathBuf};

use super::super::manifest::{Dim, Size, Surface};
use super::super::registry::{resolve_command, Registry};
use super::super::{PluginError, Result};
use super::token::{is_pane_id, status_path, token_path, PaneInfo, Token, Trigger};
use crate::float::{free_index, Backdrop, Float};
use crate::paths::Layout;

#[derive(Debug, Clone)]
pub struct OpenRequest {
    pub plugin: String,
    pub action: String,
    pub pane: String,
    pub trigger: Trigger,
    /// A token [`prepare`] already wrote; `None` makes one.
    pub token: Option<String>,
    pub args: Vec<String>,
    /// `--wait`: the command leaves its exit status for [`wait`].
    pub wait: bool,
}

#[derive(Debug, Clone)]
pub struct Opened {
    pub token: String,
    /// The pane the command runs in.
    pub pane: Option<String>,
    pub surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub pane: String,
    pub window: String,
    pub session_id: String,
    pub window_width: u32,
    pub window_height: u32,
    /// The lowest window index free in the session, for a float.
    pub free_index: u32,
}

const DEFAULT_FLOAT: Size = Size {
    width: Some(Dim::Percent(80)),
    height: Some(Dim::Percent(70)),
};

/// The one tmux command list (`;` as its own argument) that opens `surface`
/// on `target`, running `run` in `root`, and prints the new pane's id. A
/// float or popup is [`crate::float::Float`]'s list.
///
/// `split-window` without `-d` makes the new pane the current one for the
/// commands after it in the same list, so the untargeted `resize-pane -Z`
/// and `break-pane` act on it.
pub fn surface_argv(
    surface: Surface,
    size: Option<Size>,
    target: &Target,
    root: &Path,
    run: &str,
    name: &str,
) -> Vec<String> {
    if matches!(surface, Surface::Float | Surface::Popup) {
        let size = size.unwrap_or(DEFAULT_FLOAT);
        let fit = |dim: Option<Dim>, default: Option<Dim>, cells: u32| {
            dim.or(default)
                .map(|d| d.resolve(cells))
                .unwrap_or(1)
                .min(cells.max(1))
        };
        let popup = surface == Surface::Popup;
        return Float {
            from_pane: Some(target.pane.clone()),
            cwd: Some(root.display().to_string()),
            command: Some(run.to_string()),
            at: format!("{}:{}", target.session_id, target.free_index),
            parent_window: Some(target.window.clone()),
            width: Some(fit(size.width, DEFAULT_FLOAT.width, target.window_width)),
            height: Some(fit(size.height, DEFAULT_FLOAT.height, target.window_height)),
            drawer: None,
            backdrop: popup.then_some(Backdrop::Dim),
            no_header: popup,
        }
        .argv();
    }
    let mut argv: Vec<String> = vec!["split-window".into()];
    if surface == Surface::Split {
        argv.push("-h".into());
    }
    argv.extend([
        "-t".into(),
        target.pane.clone(),
        "-c".into(),
        root.display().to_string(),
        "-P".into(),
        "-F".into(),
        "#{pane_id}".into(),
        run.to_string(),
    ]);
    match surface {
        Surface::Zoomed => argv.extend([";", "resize-pane", "-Z"].map(String::from)),
        Surface::Tab => argv.extend([";", "break-pane", "-n", name].map(String::from)),
        _ => {}
    }
    argv
}

/// The new pane's command: this build's binary running `plugin exec`, as a
/// shell line. Only the binary's path is free text, and a path with `#` is
/// refused rather than escaped: tmux format-expands what it hands the shell,
/// and the escape is not the same on every version.
pub fn exec_command_line(
    exe: &Path,
    subcommand: Option<&str>,
    name: &str,
    action: &str,
    token: &str,
) -> Result<String> {
    let exe = exe.display().to_string();
    if exe.contains('#') {
        return Err(PluginError::Invalid(format!(
            "tmuxy's binary path {exe:?} contains '#', which tmux would expand"
        )));
    }
    let mut argv = vec![exe.as_str()];
    argv.extend(subcommand);
    argv.extend(["plugin", "exec", name, action, token]);
    Ok(format!("exec {}", crate::argv::shell_line(&argv)))
}

/// This build's binary and the subcommand its server verbs sit under.
fn own_command() -> Result<(PathBuf, Option<&'static str>)> {
    if let Some(cmd) = crate::session::server_command() {
        return Ok(cmd);
    }
    std::env::current_exe()
        .map(|exe| (exe, None))
        .map_err(|e| PluginError::io("finding tmuxy's own binary", e))
}

fn tmux(argv: &[String]) -> Result<String> {
    crate::session::tmux_output(argv).map_err(|e| PluginError::Invalid(e.to_string()))
}

fn describe_pane(pane: &str) -> Result<(Target, PaneInfo)> {
    let out = tmux(&[
        "display-message".into(),
        "-p".into(),
        "-t".into(),
        pane.into(),
        "#{window_id}\t#{session_id}\t#{window_width}\t#{window_height}\t#{session_name}\t#{pane_current_command}\t#{pane_current_path}".into(),
    ])
    .map_err(|_| PluginError::NotFound(format!("no pane {pane}")))?;
    let line = out.lines().next().unwrap_or_default();
    let f: Vec<&str> = line.splitn(7, '\t').collect();
    if f.len() < 7 || !f[0].starts_with('@') {
        return Err(PluginError::NotFound(format!("no pane {pane}")));
    }
    let indices = tmux(&[
        "list-windows".into(),
        "-t".into(),
        f[1].into(),
        "-F".into(),
        "#{window_index}".into(),
    ])
    .unwrap_or_default();
    let target = Target {
        pane: pane.to_string(),
        window: f[0].to_string(),
        session_id: f[1].to_string(),
        window_width: f[2].parse().unwrap_or(80),
        window_height: f[3].parse().unwrap_or(24),
        free_index: free_index(&indices),
    };
    let info = PaneInfo {
        tab: f[0].to_string(),
        session: f[4].to_string(),
        command: f[5].to_string(),
        cwd: f[6].to_string(),
    };
    Ok((target, info))
}

/// Open an action's surface. The reads run as they are; the command list
/// that creates the pane runs inside `tmux run-shell` (`job`), so this is
/// safe to call from a plain process with control mode attached.
pub fn open(dirs: &Layout, request: &OpenRequest) -> Result<Opened> {
    if !is_pane_id(&request.pane) {
        return Err(PluginError::Invalid(format!(
            "{:?} is not a pane id",
            request.pane
        )));
    }
    let registry = Registry::load(dirs)?;
    let (plugin, action) = registry.action(&request.plugin, &request.action)?;
    resolve_command(&plugin.root, &action.command)?;
    let root = plugin.root.display().to_string();
    if root.contains('#') {
        return Err(PluginError::Invalid(format!(
            "the plugin's directory {root:?} contains '#', which tmux would expand"
        )));
    }

    let (target, info) = describe_pane(&request.pane)?;
    let (mut token, id) = match &request.token {
        Some(id) => {
            let token = Token::read(dirs, id)?;
            if token.plugin != request.plugin || token.action != request.action {
                return Err(PluginError::Invalid(
                    "the invocation token is for another action".into(),
                ));
            }
            (token, id.clone())
        }
        None => {
            let mut token = Token::new(
                &request.plugin,
                &request.action,
                request.trigger,
                &request.pane,
            );
            token.args = request.args.clone();
            let id = token.create(dirs)?;
            (token, id)
        }
    };
    token.pane = request.pane.clone();
    token.wait = request.wait;
    token.info = Some(info);
    token.write(dirs, &id)?;

    let (exe, sub) = own_command()?;
    let run = exec_command_line(&exe, sub, &plugin.name, &action.id, &id)?;
    let argv = surface_argv(
        action.surface,
        action.size,
        &target,
        &plugin.root,
        &run,
        &plugin.name,
    );
    let out = match super::super::job::run(dirs, &argv) {
        Ok(out) => out,
        Err(e) => {
            let _ = std::fs::remove_file(token_path(dirs, &id));
            return Err(e);
        }
    };
    let pane = out
        .lines()
        .map(str::trim)
        .find(|l| is_pane_id(l))
        .map(str::to_string);
    if request.wait && pane.is_none() {
        return Err(PluginError::Invalid(
            "tmux did not say which pane it opened, so there is nothing to wait for".into(),
        ));
    }
    super::super::log::append(
        dirs,
        &plugin.name,
        &format!(
            "open {}:{} ({}) as {} on {} -> {}",
            plugin.name,
            action.id,
            request.trigger.as_str(),
            action.surface.as_str(),
            request.pane,
            pane.as_deref().unwrap_or("?"),
        ),
    );
    Ok(Opened {
        token: id,
        pane,
        surface: action.surface,
    })
}

/// Say on the target pane's status line that a menu launch failed, and where
/// to look.
pub fn notify_failure(dirs: &Layout, pane: &str, plugin: &str, error: &str) {
    if !is_pane_id(pane) {
        return;
    }
    let text: String = format!("plugin {plugin}: {error} (tmuxy plugin log {plugin})")
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .replace('#', "##");
    let _ = super::super::job::run(
        dirs,
        &["display-message".into(), "-t".into(), pane.into(), text],
    );
}

/// Wait for the command a token launched to exit, and return its status
/// (`tmuxy plugin action --wait`). A pane that closed without one (killed
/// before its command started) is a failure, status 1.
pub fn wait(dirs: &Layout, token_id: &str, pane: Option<&str>) -> i32 {
    let path = status_path(dirs, token_id);
    for tick in 0u64.. {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(code) = text.trim().parse() {
                let _ = std::fs::remove_file(&path);
                return code;
            }
        }
        if tick % 20 == 19 {
            if let Some(pane) = pane {
                let alive = tmux(&[
                    "display-message".into(),
                    "-p".into(),
                    "-t".into(),
                    pane.into(),
                    "#{pane_id}".into(),
                ])
                .is_ok_and(|out| out.trim() == pane);
                if !alive && !path.exists() {
                    return 1;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    1
}
