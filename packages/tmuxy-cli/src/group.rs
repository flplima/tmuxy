use clap::{Args, Subcommand};

use crate::embedded;

#[derive(Args)]
pub struct GroupArgs {
    #[command(subcommand)]
    pub action: GroupAction,
}

#[derive(Subcommand)]
pub enum GroupAction {
    /// Add current pane to a group (or create new group)
    Add,
    /// Close a pane from its group
    Close {
        /// Pane ID (e.g., %5). If omitted, uses active pane via #{pane_id}
        pane_id: Option<String>,
    },
    /// Switch to a specific pane tab in its group
    Switch {
        /// Target pane ID (e.g., %5)
        pane_id: String,
    },
    /// Switch to next tab in group
    Next,
    /// Switch to previous tab in group
    Prev,
}

/// Run a script via `tmux run-shell`. When extra_args contains tmux format
/// strings like `#{pane_id}`, tmux expands them before executing.
fn run_shell_script(script_name: &str, extra_args: &str) {
    embedded::ensure_scripts_extracted();
    let script_path = embedded::scripts_dir().join(script_name);

    let cmd = if extra_args.is_empty() {
        format!("bash {}", script_path.display())
    } else {
        format!("bash {} {}", script_path.display(), extra_args)
    };

    let output = std::process::Command::new("tmux")
        .args(["run-shell", &cmd])
        .output();

    match output {
        Ok(result) => {
            if !result.status.success() {
                let stderr = String::from_utf8_lossy(&result.stderr);
                if !stderr.is_empty() {
                    eprintln!("{}", stderr);
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to run tmux: {}", e);
            std::process::exit(1);
        }
    }
}

pub fn run(args: GroupArgs) {
    match args.action {
        GroupAction::Add => {
            run_shell_script(
                "pane-group-add.sh",
                "#{pane_id} #{pane_width} #{pane_height}",
            );
        }
        GroupAction::Close { pane_id } => {
            let arg = pane_id.unwrap_or_else(|| "#{pane_id}".to_string());
            run_shell_script("pane-group-close.sh", &arg);
        }
        GroupAction::Switch { pane_id } => {
            run_shell_script("pane-group-switch.sh", &pane_id);
        }
        GroupAction::Next => {
            run_shell_script("pane-group-next.sh", "#{pane_id}");
        }
        GroupAction::Prev => {
            run_shell_script("pane-group-prev.sh", "#{pane_id}");
        }
    }
}
