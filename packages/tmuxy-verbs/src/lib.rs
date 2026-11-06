//! The `tmuxy server <verb>` tools that serve nothing: plugins, session
//! snapshots, coding agents, pane groups, the config files and trace files.
//! The CLI scripts call them; both binaries (`tmuxy-server`, and the desktop
//! app's `tmuxy server …`) run them through [`Verb`] without the web server
//! being involved.

mod agents;
mod cli_json;
mod config_cli;
mod connect_cli;
mod float_cli;
mod plugin_cli;
mod send_cli;
mod session_cli;
mod trace_view;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum Verb {
    /// Inspect a local action-trace file: print a summary, or export a
    /// Chrome-trace/Perfetto timeline with `--export` (docs/TRACING.md).
    Trace(trace_view::TraceViewArgs),
    /// Save, restore, list or forget session snapshots. Backs
    /// `tmuxy session save|restore|snapshots|forget`.
    Session(session_cli::SessionArgs),
    /// Pane-group operations. Backs the `packages/tmuxy-cli/bin/tmuxy/pane-group` script,
    /// which run it inside `tmux run-shell`. Hidden: `tmuxy pane group` is
    /// the user's way in.
    #[command(hide = true)]
    Group(tmuxy_group::GroupArgs),
    /// Wire coding agents (Claude Code, Codex, Antigravity) into tmuxy: hooks
    /// that show their state, and the tmuxy skill. Backs `tmuxy agent`.
    Agent(agents::AgentArgs),
    /// Install, list, update and remove plugins, and run their actions.
    /// Backs `tmuxy plugin` (docs/PLUGINS.md).
    Plugin(plugin_cli::PluginArgs),
    /// The config verbs whose work is a file tmuxy-core owns: `paths`,
    /// `reload`, `use-tmux-conf`. What `tmuxy config` can call.
    Config(config_cli::ConfigArgs),
    /// Type keys, or paste text, into a pane, asking the user there first
    /// when it is not the caller's own. Backs `tmuxy pane send` and
    /// `tmuxy pane paste`, which resolve the target and the caller.
    #[command(hide = true)]
    Send(send_cli::SendArgs),
    /// Ask the desktop app to reconnect to another tmux server, and save the
    /// server for the session menu. Backs `tmuxy connect` and
    /// `tmuxy session connect`, which probe the server first.
    #[command(hide = true)]
    Connect(connect_cli::ConnectArgs),
    /// Print the agent guide (the tmuxy skill). Backs `tmuxy skill`.
    Skill,
    /// Make a float over the caller's tab and print its pane and window.
    /// Backs `float-create` (`tmuxy pane float`).
    #[command(hide = true)]
    Float(float_cli::FloatArgs),
}

/// Run one verb to completion.
pub async fn run(verb: Verb) {
    match verb {
        Verb::Trace(args) => trace_view::run(args),
        Verb::Session(args) => session_cli::run(args).await,
        Verb::Group(args) => tmuxy_group::run(args),
        Verb::Agent(args) => agents::run(args),
        Verb::Plugin(args) => plugin_cli::run(args),
        Verb::Config(args) => config_cli::run(args),
        Verb::Send(args) => send_cli::run(args).await,
        Verb::Connect(args) => connect_cli::run(args),
        Verb::Skill => print!("{}", agents::SKILL),
        Verb::Float(args) => float_cli::run(args),
    }
}
