use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
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

pub(in crate::mcp) fn float_create_args(args: &FloatArgs, program: &[String]) -> Vec<String> {
    let mut out = vec!["--detach".to_string()];
    match args.position {
        FloatPosition::Center => {}
        FloatPosition::Left => out.push("--left".into()),
        FloatPosition::Right => out.push("--right".into()),
        FloatPosition::Top => out.push("--top".into()),
        FloatPosition::Bottom => out.push("--bottom".into()),
    }
    if let Some(width) = args.width {
        out.extend(["--width".into(), width.to_string()]);
    }
    if let Some(height) = args.height {
        out.extend(["--height".into(), height.to_string()]);
    }
    if let Some(bg) = args.background {
        let bg = match bg {
            Backdrop::Dim => "dim",
            Backdrop::Blur => "blur",
            Backdrop::None => "none",
        };
        out.extend(["--bg".into(), bg.into()]);
    }
    if !program.is_empty() {
        out.push("--".into());
        out.extend(program.iter().cloned());
    }
    out
}

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// run-shell expands formats in its command first, so every `#` is doubled
/// to reach the shell as it was written.
pub(in crate::mcp) fn float_command(
    script: &str,
    anchor: &PaneId,
    script_args: &[String],
) -> String {
    let mut line = format!("TMUX_PANE={anchor} bash {}", sh_quote(script));
    for arg in script_args {
        line.push(' ');
        line.push_str(&sh_quote(arg));
    }
    format!(
        "run-shell {}",
        tmux_quote(&tmuxy_core::argv::format_literal(&line))
    )
}

fn script_path(name: &str) -> String {
    tmuxy_core::session::bin_dir()
        .join("tmuxy")
        .join(name)
        .display()
        .to_string()
}

/// Open a float from the focused pane running `program` (a shell when
/// empty), and its pane id.
async fn open_float(
    tmux: &Tmux,
    args: &FloatArgs,
    program: &[String],
) -> Result<String, CommandError> {
    let anchor = tmux.anchor().await?;
    let output = tmux
        .mutate(&float_command(
            &script_path("float-create"),
            &anchor.id,
            &float_create_args(args, program),
        ))
        .await?;
    printed_id(&output, '%')
        .ok_or_else(|| CommandError::tmux(format!("the float did not open: {}", output.trim())))
}

pub(in crate::mcp) async fn pane_float(
    tmux: &Tmux,
    args: FloatArgs,
) -> Result<Value, CommandError> {
    let program: Vec<String> = match args.command.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(command) => vec!["bash".into(), "-c".into(), command.to_string()],
        None => Vec::new(),
    };
    let id = open_float(tmux, &args, &program).await?;
    Ok(json!({ "paneId": id }))
}

#[derive(Deserialize)]
pub(in crate::mcp) struct TabArgs {
    pub name: Option<String>,
    pub command: Option<String>,
}

/// A tab into the session by name, without selecting it, from the anchor's
/// directory.
pub(in crate::mcp) fn tab_command(session: &str, anchor: &PaneId, args: &TabArgs) -> String {
    let into = format!("={session}");
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
    let program = vec![
        "bash".to_string(),
        script_path("tmuxy-widget-preview"),
        "--".to_string(),
        path.display().to_string(),
    ];
    let id = open_float(tmux, &float, &program).await?;
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
