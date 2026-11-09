//! The `tmuxy server <verb>` tools that serve nothing: plugins, session
//! snapshots, coding agents, pane groups, floats, tabs, sends, the config
//! files, trace files and a pane capture as HTML. The CLI scripts call them;
//! every binary (`tmuxy-server`, the desktop app's `tmuxy server …`, and
//! `tmuxy-verbs` where neither is installed) runs them through [`Verb`]
//! without the web server being involved.
//!
//! Built without the `native` feature (the in-browser guests' `tmuxy-verbs`)
//! the verbs on tmuxy-core's async transport are left out, and each answers
//! as not available here, under the CLI's contract.

mod agents;
mod capture_cli;
mod cli_json;
mod config_cli;
#[cfg(feature = "native")]
mod connect_cli;
mod float_cli;
mod group_cli;
#[cfg(feature = "native")]
mod plugin_cli;
mod run_cli;
mod send_cli;
#[cfg(feature = "native")]
mod session_cli;
#[cfg(feature = "native")]
mod trace_view;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum Verb {
    /// Inspect a local action-trace file: print a summary, or export a
    /// Chrome-trace/Perfetto timeline with `--export` (docs/TRACING.md).
    #[cfg(feature = "native")]
    Trace(trace_view::TraceViewArgs),
    /// Save, restore, list or forget session snapshots. Backs
    /// `tmuxy session save|restore|snapshots|forget`.
    #[cfg(feature = "native")]
    Session(session_cli::SessionArgs),
    /// Pane-group operations, run inside `tmux run-shell` (`tmuxy pane
    /// group`, the `pane-group` script).
    // Hidden: `tmuxy pane group` is the user's way in.
    #[command(hide = true)]
    Group(group_cli::GroupArgs),
    /// Wire coding agents (Claude Code, Codex, Antigravity) into tmuxy: hooks
    /// that show their state, and the tmuxy skill. Backs `tmuxy agent`.
    Agent(agents::AgentArgs),
    /// Install, list, update and remove plugins, and run their actions.
    /// Backs `tmuxy plugin` (docs/PLUGINS.md).
    #[cfg(feature = "native")]
    Plugin(plugin_cli::PluginArgs),
    /// The config files tmuxy-core owns: `paths`, `reload`, `init`,
    /// `use-tmux-conf`, `doctor`. Backs `tmuxy config`.
    Config(config_cli::ConfigArgs),
    /// Type keys, or paste text, into a pane, asking the user there first
    /// when it is not the caller's own. Backs `tmuxy pane send` and
    /// `tmuxy pane paste`, which resolve the target and the caller.
    #[command(hide = true)]
    Send(send_cli::SendArgs),
    /// Ask the desktop app to reconnect to another tmux server. Backs
    /// `tmuxy connect <socket>`.
    #[cfg(feature = "native")]
    #[command(hide = true)]
    Connect(connect_cli::ConnectArgs),
    /// Check a server stage by stage, save it for the session menu and ask
    /// the desktop app to attach to it. Backs `tmuxy session connect`.
    #[cfg(feature = "native")]
    #[command(hide = true)]
    SessionConnect(connect_cli::SessionConnectArgs),
    /// Print the agent guide (the tmuxy skill). Backs `tmuxy skill`.
    Skill(agents::SkillArgs),
    /// Run a tmux command that reads, arranges or closes, inside run-shell.
    /// Backs `tmuxy run`.
    #[command(hide = true)]
    Run(run_cli::RunArgs),
    /// A new tab beside the caller's pane, and its id. Backs
    /// `tmuxy tab create`.
    #[command(hide = true)]
    NewTab(run_cli::NewTabArgs),
    /// Make a float over the caller's tab and print its pane and window.
    /// Backs `float-create` (`tmuxy pane float`).
    #[command(hide = true)]
    Float(float_cli::FloatArgs),
    /// A `capture-pane -e` screen, on stdin, as HTML. Backs
    /// `tmuxy pane capture --format html`.
    #[command(hide = true)]
    CaptureHtml,
    /// A verb this build leaves out (see the crate's doc), as the CLI handed
    /// it over: its name, then its arguments.
    #[cfg(not(feature = "native"))]
    #[command(external_subcommand)]
    NotHere(Vec<String>),
}

pub async fn run(verb: Verb) {
    end_quietly_on_a_closed_stdout();
    #[cfg(all(feature = "native", target_os = "linux"))]
    tmuxy_core::control_mode::leave_appimage_mount();
    match verb {
        #[cfg(feature = "native")]
        Verb::Trace(args) => trace_view::run(args),
        #[cfg(feature = "native")]
        Verb::Session(args) => session_cli::run(args).await,
        Verb::Group(args) => group_cli::run(args),
        Verb::Agent(args) => agents::run(args),
        #[cfg(feature = "native")]
        Verb::Plugin(args) => plugin_cli::run(args),
        Verb::Config(args) => config_cli::run(args),
        Verb::Send(args) => send_cli::run(args).await,
        #[cfg(feature = "native")]
        Verb::Connect(args) => connect_cli::run(args),
        #[cfg(feature = "native")]
        Verb::SessionConnect(args) => connect_cli::session_connect(args),
        Verb::Skill(args) => agents::skill(args),
        Verb::Float(args) => float_cli::run(args),
        Verb::Run(args) => run_cli::run(args),
        Verb::NewTab(args) => run_cli::tab_create(args),
        Verb::CaptureHtml => capture_cli::html(),
        #[cfg(not(feature = "native"))]
        Verb::NotHere(argv) => not_here(&argv),
    }
}

/// A verb is a shell tool: piped into `head`, it ends when the reader does.
/// Rust starts with SIGPIPE ignored, so the next `println!` panicked with
/// "failed printing to stdout: Broken pipe" instead. The server never runs a
/// verb, so its sockets and children keep the ignored signal.
fn end_quietly_on_a_closed_stdout() {
    #[cfg(unix)]
    // SAFETY: signal(2) only sets the process's disposition, and no code a
    // verb runs installs a SIGPIPE handler of its own.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
}

/// The answer to a verb this build leaves out: a failure under the CLI's
/// contract, in JSON when the command line asked for it.
#[cfg(not(feature = "native"))]
fn not_here(argv: &[String]) -> ! {
    let verb = argv.first().map_or("", String::as_str);
    let answer = cli_json::Answer::new(argv.iter().any(|arg| arg == "--json"));
    answer.exit(
        cli_json::EXIT_FAILED,
        &format!("`{verb}` is not available here: it needs tmuxy-server, which this machine does not have"),
    )
}

#[cfg(all(test, feature = "native"))]
mod tests {
    use super::Verb;
    use clap::Parser;

    /// `--json` works on every command (`tmuxy --help`): the shell hands it to
    /// whichever verb answers, which must take it.
    #[test]
    fn every_verb_the_cli_hands_json_to_takes_it() {
        #[derive(Parser)]
        struct Cli {
            #[command(subcommand)]
            verb: Verb,
        }
        for argv in [
            &["trace", "--json"][..],
            &["trace", "--health", "--json"],
            &["skill", "--json"],
            &["session", "snapshots", "--json"],
            &["agent", "status", "--json"],
            &["config", "paths", "--json"],
            &["plugin", "list", "--json"],
            &["run", "--json", "--", "list-panes"],
            &["new-tab", "--json"],
            &["connect", "--json", "--socket", "x"],
            &["session-connect", "--json"],
        ] {
            let parsed = Cli::try_parse_from(std::iter::once("tmuxy").chain(argv.iter().copied()));
            assert!(parsed.is_ok(), "{argv:?}");
        }
    }
}
