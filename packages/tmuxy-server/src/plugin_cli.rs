//! `tmuxy plugin …`: install, list, update and remove plugins, run their
//! actions, and help write one (docs/PLUGINS.md). The machinery is
//! `tmuxy_core::plugins`; this is the command line and the install gate.
//!
//! Every verb runs as a plain process, so the gate can ask on the terminal
//! and `action --wait` waits in the caller's own process. What changes tmux
//! (opening a surface, publishing the inventory) goes through a `run-shell`
//! of its own (`plugins::job`, docs/TMUX.md).

use std::path::PathBuf;

use tmuxy_core::plugins::invoke::{self, OpenRequest, Trigger};
use tmuxy_core::plugins::registry::Registry;
use tmuxy_core::plugins::{inventory, log, Dirs, PluginError};

mod gate;
mod info;
mod install;
use gate::Answer;
use info::{check, list, new, show_log};
use install::{install, remove, update};

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;

#[derive(clap::Args, Debug)]
pub struct PluginArgs {
    #[command(subcommand)]
    verb: PluginCommand,
    /// Answer in JSON.
    #[arg(long, short = 'j', global = true)]
    json: bool,
}

#[derive(clap::Subcommand, Debug)]
enum PluginCommand {
    /// Install a plugin from GitHub (owner/repo[/subdir][@ref]) or link a
    /// local directory (--path). With neither, install exactly what
    /// plugins.json lists.
    Install {
        source: Option<String>,
        /// Link a local directory: used in place, edits apply at once.
        #[arg(long, value_name = "DIR", conflicts_with = "source")]
        path: Option<PathBuf>,
        /// Do not ask (no terminal): needs --sha for a repository.
        #[arg(long)]
        yes: bool,
        /// The commit you reviewed, for --yes.
        #[arg(long, value_name = "COMMIT")]
        sha: Option<String>,
    },
    /// The installed plugins.
    List,
    /// Move plugins to the latest commit of the ref they follow; asks again.
    Update {
        name: Option<String>,
        #[arg(long)]
        yes: bool,
        #[arg(long, value_name = "COMMIT")]
        sha: Option<String>,
    },
    /// Uninstall a plugin. Its config dir stays unless --purge.
    Remove {
        name: String,
        #[arg(long)]
        purge: bool,
    },
    /// Run an action (<plugin>:<id>) on a pane, in the surface it declares.
    Action {
        target: String,
        /// The pane it is about (default: the caller's).
        #[arg(long, value_name = "PANE")]
        pane: Option<String>,
        /// Wait for the command to exit, and exit with its status.
        #[arg(long)]
        wait: bool,
        /// A token prepared by the server (menu actions with a selection).
        #[arg(long, hide = true)]
        token: Option<String>,
        #[arg(long, hide = true, value_enum, default_value = "action")]
        trigger: TriggerArg,
        /// Extra arguments for the command, after `--`.
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// A plugin's log: what ran, and how it exited.
    Log {
        name: String,
        /// Keep printing as it grows.
        #[arg(short, long)]
        follow: bool,
    },
    /// Validate a plugin directory's manifest and commands.
    Check {
        #[arg(default_value = ".")]
        dir: PathBuf,
    },
    /// Write a new plugin, tmuxy-<name>/, to start from.
    New { name: String },
    /// Run an action's command in the pane `action` opened. Internal.
    #[command(hide = true)]
    Exec {
        name: String,
        action: String,
        token: String,
    },
    /// Publish the inventory to the tmux server. Internal: `config reload`.
    #[command(hide = true)]
    Publish,
    /// Any other word: an installed plugin's `[[cli]]` verb and its arguments.
    #[command(external_subcommand)]
    Verb(Vec<String>),
}

#[derive(clap::ValueEnum, Clone, Copy, Debug)]
enum TriggerArg {
    Action,
    Menu,
}

/// How a verb ended: what to print, and the exit code.
struct Failure {
    code: i32,
    message: String,
}

impl From<PluginError> for Failure {
    fn from(e: PluginError) -> Self {
        Failure {
            code: e.exit_code(),
            message: e.to_string(),
        }
    }
}

fn usage(message: impl Into<String>) -> Failure {
    Failure {
        code: 2,
        message: message.into(),
    }
}

type Outcome = Result<serde_json::Value, Failure>;

pub fn run(args: PluginArgs) {
    let dirs = Dirs::current();
    let json = args.json;
    let result = match args.verb {
        PluginCommand::Install {
            source,
            path,
            yes,
            sha,
        } => install(&dirs, source, path, &Answer { yes, sha }, json),
        PluginCommand::List => list(&dirs, json),
        PluginCommand::Update { name, yes, sha } => update(&dirs, name, &Answer { yes, sha }, json),
        PluginCommand::Remove { name, purge } => remove(&dirs, &name, purge, json),
        PluginCommand::Action {
            target,
            pane,
            wait,
            token,
            trigger,
            args,
        } => action(&dirs, &target, pane, wait, token, trigger, args, json),
        PluginCommand::Log { name, follow } => show_log(&dirs, &name, follow),
        PluginCommand::Check { dir } => check(&dir, json),
        PluginCommand::New { name } => new(&name, json),
        PluginCommand::Exec {
            name,
            action,
            token,
        } => std::process::exit(invoke::exec(&dirs, &name, &action, &token)),
        PluginCommand::Verb(words) => run_cli_verb(&dirs, &words),
        PluginCommand::Publish => {
            inventory::publish(&dirs);
            Ok(serde_json::Value::Null)
        }
    };
    match result {
        Ok(value) => {
            if json && !value.is_null() {
                let mut out = serde_json::json!({ "ok": true });
                if let (Some(out), Some(fields)) = (out.as_object_mut(), value.as_object()) {
                    out.extend(fields.clone());
                }
                println!("{out}");
            }
        }
        Err(failure) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "ok": false, "error": failure.message, "code": failure.code })
                );
            } else {
                eprintln!("tmuxy plugin: {}", failure.message);
            }
            std::process::exit(failure.code);
        }
    }
}

/// Print a line for a person; nothing under `--json`.
fn say(json: bool, text: impl AsRef<str>) {
    if !json {
        println!("{}", text.as_ref());
    }
}

// ── action / cli ────────────────────────────────────────────────────────

/// `<plugin>:<id>`.
fn split_target(target: &str) -> Result<(String, String), Failure> {
    target
        .split_once(':')
        .filter(|(p, a)| {
            tmuxy_core::plugins::is_valid_name(p) && tmuxy_core::plugins::is_valid_name(a)
        })
        .map(|(p, a)| (p.to_string(), a.to_string()))
        .ok_or_else(|| usage(format!("{target:?}: name an action as <plugin>:<id>")))
}

#[allow(clippy::too_many_arguments)]
fn action(
    dirs: &Dirs,
    target: &str,
    pane: Option<String>,
    wait: bool,
    token: Option<String>,
    trigger: TriggerArg,
    args: Vec<String>,
    json: bool,
) -> Outcome {
    let (plugin, action) = split_target(target)?;
    let trigger = match trigger {
        TriggerArg::Action => Trigger::Action,
        TriggerArg::Menu => Trigger::Menu,
    };
    let pane = pane
        .or_else(|| std::env::var("TMUX_PANE").ok())
        .filter(|p| invoke::is_pane_id(p))
        .ok_or_else(|| usage("no pane to act on: pass --pane %<id>, or run it in a pane"))?;
    let request = OpenRequest {
        plugin: plugin.clone(),
        action: action.clone(),
        pane: pane.clone(),
        trigger,
        token,
        args,
        wait,
    };
    let opened = match invoke::open(dirs, &request) {
        Ok(opened) => opened,
        Err(e) => {
            if tmuxy_core::plugins::is_valid_name(&plugin) {
                log::append(
                    dirs,
                    &plugin,
                    &format!("open {plugin}:{action} failed: {e}"),
                );
            }
            if trigger == Trigger::Menu {
                invoke::notify_failure(dirs, &pane, &plugin, &e.to_string());
            }
            return Err(e.into());
        }
    };
    if wait {
        let status = invoke::wait(dirs, &opened.token, opened.pane.as_deref());
        if json {
            println!(
                "{}",
                serde_json::json!({ "ok": status == 0, "pane": opened.pane, "status": status })
            );
        }
        std::process::exit(status);
    }
    say(json, opened.pane.clone().unwrap_or_default());
    Ok(serde_json::json!({
        "pane": opened.pane,
        "surface": opened.surface.as_str(),
    }))
}

/// `tmuxy plugin <verb> [args…]`: the plugin's command, run in place of this
/// process so its input, output and exit status are the caller's. A word no
/// plugin has is a bad command line, like any unknown subcommand.
fn run_cli_verb(dirs: &Dirs, words: &[String]) -> Outcome {
    let (verb, args) = words.split_first().ok_or_else(|| usage("no command"))?;
    let known = Registry::load(dirs).is_ok_and(|r| r.verb(verb).is_some());
    if !known {
        return Err(usage(format!(
            "{verb:?} is neither a `tmuxy plugin` command nor an installed plugin's \
             (`tmuxy plugin --help`, `tmuxy plugin list`)"
        )));
    }
    let mut cmd = invoke::cli_command(dirs, verb, args)?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = cmd.exec();
        Err(PluginError::io(format!("running tmuxy plugin {verb}"), e).into())
    }
    #[cfg(not(unix))]
    {
        let status = cmd.status().map_err(|e| {
            Failure::from(PluginError::io(format!("running tmuxy plugin {verb}"), e))
        })?;
        std::process::exit(status.code().unwrap_or(1));
    }
}
