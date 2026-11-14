use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tmuxy_core::argv::{control_line, control_list, shell_line};
use tmuxy_core::float::{self, Drawer, Float, Spot};
use tmuxy_core::paths::Layout;
use tmuxy_core::tmux_command::NewTab;
use tmuxy_core::{tmux_quote, CommandError, PaneId};

use super::super::tmux::Tmux;
use super::super::{ask, Caller};
use super::timeout;

fn printed_id(output: &str, sigil: char) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let digits = word.strip_prefix(sigil)?;
        (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| word.to_string())
    })
}

#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(in crate::mcp) enum SplitDirection {
    #[default]
    Right,
    Down,
}

#[derive(Deserialize)]
pub(in crate::mcp) struct SplitArgs {
    pane: Option<String>,
    #[serde(default)]
    direction: SplitDirection,
    command: Option<String>,
}

pub(in crate::mcp) fn split_command(
    pane: &PaneId,
    direction: SplitDirection,
    command: Option<&str>,
) -> String {
    let flag = match direction {
        SplitDirection::Right => "-h",
        SplitDirection::Down => "-v",
    };
    let program = command
        .filter(|c| !c.trim().is_empty())
        .map(|c| format!(" {}", tmux_quote(c)))
        .unwrap_or_default();
    format!("splitw {flag} -d -t {pane} -c '#{{pane_current_path}}' -P -F '#{{pane_id}}'{program}")
}

pub(in crate::mcp) async fn pane_split(
    tmux: &Tmux,
    args: SplitArgs,
) -> Result<Value, CommandError> {
    let pane = tmux.pane(args.pane.as_deref()).await?;
    let output = tmux
        .mutate(&split_command(
            &pane.id,
            args.direction,
            args.command.as_deref(),
        ))
        .await?;
    let id = printed_id(&output, '%').ok_or_else(|| {
        CommandError::tmux(format!("tmux did not say which pane it made: {output:?}"))
    })?;
    Ok(json!({ "paneId": id }))
}

#[derive(Deserialize)]
pub(in crate::mcp) struct SendArgs {
    pane: String,
    keys: Vec<String>,
    timeout_seconds: Option<u64>,
}

const SEND_DEFAULT: Duration = Duration::from_secs(120);
pub(in crate::mcp) const SEND_MAX: Duration = Duration::from_secs(600);
const MAX_SEND_BYTES: usize = 64 * 1024;

pub(in crate::mcp) async fn pane_send_keys(
    tmux: &Tmux,
    caller: &Caller,
    args: SendArgs,
) -> Result<Value, CommandError> {
    if args.keys.is_empty() || args.keys.iter().all(String::is_empty) {
        return Err(CommandError::invalid("keys required"));
    }
    if args.keys.iter().map(String::len).sum::<usize>() > MAX_SEND_BYTES {
        return Err(CommandError::invalid(format!(
            "at most {MAX_SEND_BYTES} bytes of keys per send"
        )));
    }
    let pane = tmux.pane(Some(&args.pane)).await?;
    let timeout = timeout(args.timeout_seconds, SEND_DEFAULT, SEND_MAX);
    ask::send_keys(tmux, &pane.id, &args.keys, caller.display_name(), timeout).await
}

#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(in crate::mcp) enum FloatPosition {
    #[default]
    Center,
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub(in crate::mcp) enum Backdrop {
    Dim,
    Blur,
    None,
}

#[derive(Deserialize, Default)]
pub(in crate::mcp) struct FloatArgs {
    pub command: Option<String>,
    #[serde(default)]
    pub position: FloatPosition,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub background: Option<Backdrop>,
}

impl FloatArgs {
    fn drawer(&self) -> Option<Drawer> {
        match self.position {
            FloatPosition::Center => None,
            FloatPosition::Left => Some(Drawer::Left),
            FloatPosition::Right => Some(Drawer::Right),
            FloatPosition::Top => Some(Drawer::Top),
            FloatPosition::Bottom => Some(Drawer::Bottom),
        }
    }

    fn backdrop(&self) -> Option<float::Backdrop> {
        self.background.map(|bg| match bg {
            Backdrop::Dim => float::Backdrop::Dim,
            Backdrop::Blur => float::Backdrop::Blur,
            Backdrop::None => float::Backdrop::None,
        })
    }
}

/// The float's command list (`tmuxy_core::float`, as `tmuxy pane float`
/// makes it) as one control-mode line, running `program` (a shell line; a
/// shell when absent).
pub(in crate::mcp) fn float_command(
    anchor: &PaneId,
    spot: &Spot,
    args: &FloatArgs,
    program: Option<String>,
) -> String {
    let drawer = args.drawer();
    let (width, height) = float::default_size(args.width, args.height, drawer, spot.rows);
    let float = Float {
        from_pane: Some(anchor.to_string()),
        cwd: None,
        command: program,
        at: spot.at(),
        parent_window: Some(spot.window.clone()),
        width,
        height,
        drawer,
        backdrop: args.backdrop(),
        no_header: false,
    };
    control_list(&float.argv())
}

/// The agent's command runs under bash, whatever the user's default shell.
pub(in crate::mcp) async fn pane_float(
    tmux: &Tmux,
    args: FloatArgs,
) -> Result<Value, CommandError> {
    let program = args
        .command
        .as_deref()
        .filter(|c| !c.trim().is_empty())
        .map(|c| shell_line(&["bash", "-c", c]));
    let id = open_float(tmux, &args, program).await?;
    Ok(json!({ "paneId": id }))
}

/// Open a float from the anchor pane, and its pane id.
async fn open_float(
    tmux: &Tmux,
    args: &FloatArgs,
    program: Option<String>,
) -> Result<String, CommandError> {
    let anchor = tmux.anchor().await?;
    let pane_out = tmux
        .read(&control_line(&Spot::pane_read(Some(anchor.id.as_str()))))
        .await?;
    if !Spot::answered_by(&pane_out, anchor.id.as_str()) {
        return Err(CommandError::tmux(format!("{} is gone", anchor.id)));
    }
    let windows = tmux
        .read(&control_line(&Spot::windows_read(&pane_out)))
        .await?;
    let spot = Spot::new(&pane_out, &windows);
    let output = tmux
        .mutate(&float_command(&anchor.id, &spot, args, program))
        .await?;
    printed_id(&output, '%')
        .ok_or_else(|| CommandError::tmux(format!("the float did not open: {}", output.trim())))
}

#[derive(Deserialize)]
pub(in crate::mcp) struct TabArgs {
    pub name: Option<String>,
    pub command: Option<String>,
}

/// A tab into the session by name, without selecting it, from the anchor's
/// directory.
pub(in crate::mcp) fn tab_command(session: &str, anchor: &PaneId, args: &TabArgs) -> String {
    let into = tmuxy_core::session::exact_session_target(session);
    NewTab {
        from: Some(anchor.as_str()),
        into: Some(&into),
        name: args.name.as_deref().filter(|n| !n.trim().is_empty()),
        cwd: Some("#{pane_current_path}"),
        program: args.command.as_deref().filter(|c| !c.trim().is_empty()),
        background: true,
        print_id: true,
        size: None,
    }
    .command_line()
}

pub(in crate::mcp) async fn tab_create(tmux: &Tmux, args: TabArgs) -> Result<Value, CommandError> {
    let anchor = tmux.anchor().await?;
    let output = tmux
        .mutate(&tab_command(tmux.session(), &anchor.id, &args))
        .await?;
    let id = printed_id(&output, '@').ok_or_else(|| {
        CommandError::tmux(format!("tmux did not say which tab it made: {output:?}"))
    })?;
    Ok(json!({ "tabId": id }))
}

#[derive(Deserialize)]
pub(in crate::mcp) struct PreviewArgs {
    path: String,
    #[serde(default)]
    position: FloatPosition,
    width: Option<u32>,
    height: Option<u32>,
}

/// What the preview widget renders (`tmuxy-widget-preview`).
const PREVIEW_EXTENSIONS: &[&str] = &["md", "markdown", "html", "htm"];

pub(in crate::mcp) fn preview_path(path: &str) -> Result<std::path::PathBuf, CommandError> {
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err(CommandError::invalid(
            "the path must be absolute: the server does not share your working directory",
        ));
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !PREVIEW_EXTENSIONS.contains(&extension.as_str()) {
        return Err(CommandError::invalid(
            "only .md, .markdown, .html and .htm files can be previewed",
        ));
    }
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => Ok(path),
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(CommandError::invalid("a symlink cannot be previewed"))
        }
        Ok(_) => Err(CommandError::invalid("not a file")),
        Err(e) => Err(CommandError::invalid(format!(
            "cannot read {}: {e}",
            path.display()
        ))),
    }
}

pub(in crate::mcp) async fn open_preview(
    tmux: &Tmux,
    args: PreviewArgs,
) -> Result<Value, CommandError> {
    let path = preview_path(&args.path)?;
    let float = FloatArgs {
        position: args.position,
        width: args.width,
        height: args.height,
        ..FloatArgs::default()
    };
    let script = Layout::current().scripts().join("tmuxy-widget-preview");
    let program = shell_line(&[
        "bash",
        &script.display().to_string(),
        "--",
        &path.display().to_string(),
    ]);
    let id = open_float(tmux, &float, Some(program)).await?;
    Ok(json!({ "paneId": id }))
}

#[derive(Deserialize)]
pub(in crate::mcp) struct KillArgs {
    pane: String,
}

pub(in crate::mcp) async fn pane_kill(tmux: &Tmux, args: KillArgs) -> Result<Value, CommandError> {
    let pane = tmux.pane(Some(&args.pane)).await?;
    tmux.mutate(&format!("killp -t {}", pane.id)).await?;
    Ok(json!({ "paneId": pane.id, "killed": true }))
}
