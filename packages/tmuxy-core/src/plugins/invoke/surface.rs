//! Opening an action's surface: the one tmux command list per surface, run
//! from inside `tmux run-shell`.

use std::path::{Path, PathBuf};

use super::super::manifest::{Dim, Size, Surface};
use super::super::registry::{resolve_command, Registry};
use super::super::{Dirs, PluginError, Result};
use super::token::{is_pane_id, status_path, token_path, PaneInfo, Token, Trigger};

/// What `tmuxy plugin action` was asked to do.
#[derive(Debug, Clone)]
pub struct OpenRequest {
    pub plugin: String,
    pub action: String,
    pub pane: String,
    pub trigger: Trigger,
    /// A token [`prepare`] already wrote; `None` makes one.
    pub token: Option<String>,
    pub args: Vec<String>,
}

/// What [`open`] did.
#[derive(Debug, Clone)]
pub struct Opened {
    pub token: String,
    /// The pane the command runs in.
    pub pane: Option<String>,
    pub surface: Surface,
}

/// Where a surface opens: the target pane and what tmux says about it.
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

/// The default size of a float or popup, when the manifest names none.
const DEFAULT_FLOAT: Size = Size {
    width: Some(Dim::Percent(80)),
    height: Some(Dim::Percent(70)),
};

/// The one tmux command list (`;` as its own argument) that opens `surface`
/// on `target`, running `run` in `root`, and prints the new pane's id.
///
/// `split-window` without `-d` makes the new pane the current one for the
/// commands after it in the same list, so the untargeted `break-pane` and
/// `resize-pane -Z` act on it — the rule `bin/tmuxy/float-create` builds a
/// float with, which also keeps the intermediate split from ever being drawn.
pub fn surface_argv(
    surface: Surface,
    size: Option<Size>,
    target: &Target,
    root: &Path,
    run: &str,
    name: &str,
) -> Vec<String> {
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
    let mut then = |cmd: &[&str]| {
        argv.push(";".into());
        argv.extend(cmd.iter().map(|s| s.to_string()));
    };
    match surface {
        Surface::Split => {}
        Surface::Zoomed => then(&["resize-pane", "-Z"]),
        Surface::Tab => then(&["break-pane", "-n", name]),
        Surface::Float | Surface::Popup => {
            let at = format!("{}:{}", target.session_id, target.free_index);
            let size = size.unwrap_or(DEFAULT_FLOAT);
            let width = size
                .width
                .or(DEFAULT_FLOAT.width)
                .map(|d| d.resolve(target.window_width))
                .unwrap_or(1)
                .min(target.window_width.max(1))
                .to_string();
            let height = size
                .height
                .or(DEFAULT_FLOAT.height)
                .map(|d| d.resolve(target.window_height))
                .unwrap_or(1)
                .min(target.window_height.max(1))
                .to_string();
            then(&["break-pane", "-d", "-n", "float", "-t", &at]);
            then(&["set-option", "-w", "-t", &at, "@tmuxy-window-type", "float"]);
            then(&[
                "set-option",
                "-w",
                "-t",
                &at,
                "@tmuxy-float-parent",
                &target.window,
            ]);
            then(&["set-option", "-w", "-t", &at, "@tmuxy-float-width", &width]);
            then(&[
                "set-option",
                "-w",
                "-t",
                &at,
                "@tmuxy-float-height",
                &height,
            ]);
            if surface == Surface::Popup {
                then(&["set-option", "-w", "-t", &at, "@tmuxy-float-noheader", "1"]);
                then(&["set-option", "-w", "-t", &at, "@tmuxy-float-bg", "dim"]);
            }
            then(&["resize-pane", "-t", &at, "-x", &width]);
            then(&["resize-pane", "-t", &at, "-y", &height]);
            // break-pane took the caller's active pane away; give it back,
            // as float-create does.
            then(&["select-pane", "-t", &target.pane]);
        }
    }
    argv
}

/// The new pane's command: this build's binary running `plugin exec`, every
/// word single-quoted. Only the binary's path is free text, and a path with
/// `#` is refused rather than escaped: tmux format-expands what it hands the
/// shell, and the escape is not the same on every version.
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
    let quote = |w: &str| format!("'{}'", w.replace('\'', r"'\''"));
    let mut words = vec![quote(&exe)];
    if let Some(sub) = subcommand {
        words.push(quote(sub));
    }
    words.extend(["plugin", "exec", name, action, token].map(quote));
    Ok(format!("exec {}", words.join(" ")))
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

/// What tmux says about `pane`: the surface's target and the context.
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

/// The lowest window index not in use, scanning up from the lowest one, as
/// `float-create`'s `free_window_index` does.
pub fn free_index(listing: &str) -> u32 {
    let used: std::collections::BTreeSet<u32> = listing
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
    let mut i = used.iter().next().copied().unwrap_or(0);
    while used.contains(&i) {
        i += 1;
    }
    i
}

/// Open an action's surface. Runs tmux commands that create panes, so it
/// must run inside `tmux run-shell`; the CLI wraps `tmuxy plugin action`
/// that way.
pub fn open(dirs: &Dirs, request: &OpenRequest) -> Result<Opened> {
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
    let out = match tmux(&argv) {
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
/// to look. Runs inside run-shell, like [`open`].
pub fn notify_failure(pane: &str, plugin: &str, error: &str) {
    if !is_pane_id(pane) {
        return;
    }
    let text: String = format!("plugin {plugin}: {error} (tmuxy plugin log {plugin})")
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .replace('#', "##");
    let _ = tmux(&["display-message".into(), "-t".into(), pane.into(), text]);
}

/// Wait for the command a token launched to exit, and return its status
/// (`tmuxy plugin action --wait`). A pane that closed without one (killed
/// before its command started) is a failure, status 1.
pub fn wait(dirs: &Dirs, token_id: &str, pane: Option<&str>) -> i32 {
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
