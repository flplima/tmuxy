use clap::{Args, Subcommand};
use std::process::Command;

#[derive(Args)]
pub struct FloatArgs {
    #[command(subcommand)]
    pub action: Option<FloatAction>,
}

#[derive(Subcommand)]
pub enum FloatAction {
    /// Create a new float pane
    Create {
        /// Command to run in the float pane
        #[arg(trailing_var_arg = true)]
        cmd: Vec<String>,
    },
    /// Close a float pane
    Close {
        /// Pane ID to close (e.g., %5)
        pane_id: String,
    },
    /// Convert an embedded pane to a float
    Convert {
        /// Pane ID to convert (e.g., %5)
        pane_id: String,
    },
    /// Embed a float pane back into the active window
    Embed {
        /// Pane ID to embed (e.g., %5)
        pane_id: String,
    },
}

fn tmux(args: &[&str]) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run tmux: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "tmux {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn refresh_panes() -> Result<(), String> {
    tmux(&[
        "list-panes", "-s", "-F",
        "#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}",
    ])?;
    Ok(())
}

pub fn run(args: FloatArgs) {
    let action = args.action.unwrap_or(FloatAction::Create { cmd: vec![] });
    if let Err(e) = run_action(action) {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

fn run_action(action: FloatAction) -> Result<(), String> {
    match action {
        FloatAction::Create { cmd } => create(cmd),
        FloatAction::Close { pane_id } => close(&pane_id),
        FloatAction::Convert { pane_id } => convert(&pane_id),
        FloatAction::Embed { pane_id } => embed(&pane_id),
    }
}

fn create(cmd: Vec<String>) -> Result<(), String> {
    let mut split_args = vec!["split-window", "-dP", "-F", "#{pane_id}"];

    let cmd_str = cmd.join(" ");
    if !cmd.is_empty() {
        split_args.push(&cmd_str);
    }

    let new_pane_id = tmux(&split_args)?;
    tmux(&["break-pane", "-d", "-s", &new_pane_id, "-n", "__float_temp"])?;
    refresh_panes()
}

fn close(pane_id: &str) -> Result<(), String> {
    let win_id = tmux(&["display-message", "-t", pane_id, "-p", "#{window_id}"])?;
    if !win_id.is_empty() {
        tmux(&["kill-window", "-t", &win_id])?;
    }
    refresh_panes()
}

fn convert(pane_id: &str) -> Result<(), String> {
    let pane_num = pane_id.trim_start_matches('%');
    let window_name = format!("__float_{}", pane_num);

    tmux(&["break-pane", "-d", "-s", pane_id])?;
    let win_id = tmux(&["display-message", "-t", pane_id, "-p", "#{window_id}"])?;
    tmux(&["rename-window", "-t", &win_id, &window_name])?;
    refresh_panes()
}

fn embed(pane_id: &str) -> Result<(), String> {
    let active_win = tmux(&["display-message", "-p", "#{window_id}"])?;
    tmux(&["join-pane", "-s", pane_id, "-t", &active_win])?;
    refresh_panes()
}
