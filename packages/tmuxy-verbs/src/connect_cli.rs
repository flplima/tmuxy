//! `tmuxy connect` and `tmuxy session connect`: move the desktop app onto
//! another tmux server (`tmuxy_core::servers::connect`).
//!
//! `session connect` checks the server first, in stages it prints as it goes
//! (docs/DATA-FLOW.md, "the 4-step connect flow"): ssh to the host, tmux
//! there, its sessions, then the request. A stage that fails prints `✗` and
//! what ssh or tmux said, and nothing is requested.

use std::io::{BufRead, Write};
use std::process::{Command, Output};

use tmuxy_core::argv::shell_line;
use tmuxy_core::constants::STASH_SESSION;
use tmuxy_core::servers::connect::{remember, ConnectRequest, CONNECT_REQUEST};
use tmuxy_core::session::{
    is_no_server, is_safe_session_name, local_tmux_on, socket_args, tmux_path, tmux_socket,
};

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_USAGE};

#[derive(clap::Args, Debug)]
pub struct ConnectArgs {
    /// The tmux socket name (`-L`) or path (`-S`) to reconnect to.
    #[arg(long)]
    socket: String,
    /// The session to attach to there; the first one it has otherwise.
    #[arg(long)]
    session: Option<String>,
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
}

#[derive(clap::Args, Debug)]
#[command(override_help = SESSION_CONNECT_HELP)]
pub struct SessionConnectArgs {
    /// `[user@]host`, or `localhost` / empty for this machine; asked for
    /// when absent.
    dest: Option<String>,
    /// The session to attach to (also `--session`).
    session_arg: Option<String>,
    #[arg(long)]
    socket: Option<String>,
    #[arg(long)]
    session: Option<String>,
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
}

const SESSION_CONNECT_HELP: &str = "\
Usage: tmuxy session connect [<dest>] [--socket <name>] [--session <name>]

Connect to a tmux server on <dest> ([user@]host, or \"localhost\" / empty for
this machine) and attach to a session on its socket (default: tmuxy).

Stages:
  1. ssh <user@host> (or localhost)
  2. tmux <version> on the socket <name>
  3. listing sessions
  4. attach

Options:
  --socket <name>   tmux socket name (-L) or path (-S) (default: tmuxy)
  --session <name>  Session to attach to on the target server
  -h, --help        Show this help
";

/// `tmuxy connect <socket> [session]`: the request, with no stages.
pub fn run(args: ConnectArgs) {
    let answer = Answer::new(args.json);
    let mut request = request_or_exit(&answer, &args.socket, args.session.as_deref(), None);
    if request.session.is_none() {
        let listed = Server::local(&request.socket).sessions();
        request.session = Some(
            listed
                .ok()
                .and_then(|names| first_safe_session(&names))
                .unwrap_or_else(|| tmuxy_core::DEFAULT_SESSION_NAME.to_string()),
        );
    }
    publish(&answer, &request);
    let session = request.session.as_deref().unwrap_or_default();
    answer.done(
        &fields(&request),
        &format!(
            "Requested desktop app reconnect to socket '{}' (session '{session}').\n\
             No effect in the web UI — the web server's socket is fixed at launch.",
            request.socket
        ),
    );
}

/// `tmuxy session connect`: the stages, then the request, saved for the
/// session menu.
pub fn session_connect(args: SessionConnectArgs) {
    let answer = Answer::new(args.json);
    let dest = match args.dest {
        Some(dest) => dest,
        None => ask_destination(),
    };
    let dest = dest.trim();
    // A pasted `ssh user@host` is the host; anything else after `ssh ` is
    // still refused as a destination below, so no option reaches ssh.
    let dest = dest.strip_prefix("ssh ").unwrap_or(dest).trim();
    let ssh = Some(dest).filter(|d| !d.is_empty() && *d != "localhost");
    let socket = args.socket.unwrap_or_else(|| match ssh {
        Some(_) => tmuxy_core::session::DEFAULT_TMUX_SOCKET.to_string(),
        None => tmux_socket(),
    });
    let session = args.session.or(args.session_arg);
    let mut request = request_or_exit(&answer, &socket, session.as_deref(), ssh);
    let server = match &request.ssh {
        Some(dest) => Server::remote(dest, &request.socket),
        None => Server::local(&request.socket),
    };
    let stages = Stages { answer: &answer };

    match &request.ssh {
        Some(dest) => {
            let reached = server.ssh(&["true"]);
            stages.check(&format!("ssh {dest}"), reached.map(drop));
            stages.passed(&format!("ssh {dest}"));
        }
        None => stages.passed("localhost"),
    }

    let version = server.version();
    let version = stages.check(&format!("tmux on the socket {}", request.socket), version);
    let version = version.trim().trim_start_matches("tmux ").to_string();
    let named = if version.is_empty() {
        String::new()
    } else {
        format!(" {version}")
    };
    stages.passed(&format!("tmux{named} on the socket {}", request.socket));

    let sessions = stages.check("listing sessions", server.sessions());
    stages.passed("listing sessions");
    if request.session.is_none() {
        request.session = first_safe_session(&sessions);
    }

    if let Some(saved) = request.server(&tmux_socket()) {
        if let Err(e) = remember(saved) {
            answer.exit(
                EXIT_FAILED,
                &format!("the server was not saved to servers.json: {e}"),
            );
        }
    }
    publish(&answer, &request);
    stages.passed("attach");
    let mut answered = fields(&request);
    answered.push(("tmux", cli_json::string(&version)));
    answer.done(&answered, "");
}

fn request_or_exit(
    answer: &Answer,
    socket: &str,
    session: Option<&str>,
    ssh: Option<&str>,
) -> ConnectRequest {
    ConnectRequest::new(socket, session, ssh)
        .unwrap_or_else(|message| answer.exit(EXIT_USAGE, &message))
}

fn fields(request: &ConnectRequest) -> Vec<(&'static str, String)> {
    vec![
        ("socket", cli_json::string(&request.socket)),
        (
            "session",
            cli_json::string(request.session.as_deref().unwrap_or_default()),
        ),
    ]
}

/// The request goes on the CURRENT server, where the desktop app's connect
/// watcher reads it.
fn publish(answer: &Answer, request: &ConnectRequest) {
    let publish = [
        "set-environment".to_string(),
        "-g".into(),
        CONNECT_REQUEST.into(),
        request.encode(),
    ];
    if let Err(e) = tmuxy_core::run_shell::tmux(&tmuxy_core::paths::Layout::current(), &publish) {
        answer.exit(EXIT_FAILED, &e.to_string());
    }
}

/// What the person types at the prompt; end of input is this machine.
fn ask_destination() -> String {
    eprint!("Connect to ([user@]host, or blank for localhost): ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    line
}

/// The first name a session listing gives that tmuxy will put on a command
/// line, the stash of parked group members passed over.
fn first_safe_session(names: &[String]) -> Option<String> {
    names
        .iter()
        .find(|name| name.as_str() != STASH_SESSION && is_safe_session_name(name))
        .cloned()
}

struct Stages<'a> {
    answer: &'a Answer,
}

impl Stages<'_> {
    fn passed(&self, stage: &str) {
        if !self.answer.is_json() {
            println!("✓ {stage}");
        }
    }

    /// A stage's result, or `✗ <stage>` and what failed, and exit 1.
    fn check<T>(&self, stage: &str, result: Result<T, String>) -> T {
        match result {
            Ok(value) => value,
            Err(why) if self.answer.is_json() => {
                let why = why.trim();
                let message = if why.is_empty() {
                    stage.to_string()
                } else {
                    format!("{stage}: {why}")
                };
                self.answer.exit(EXIT_FAILED, &message)
            }
            Err(why) => {
                eprintln!("✗ {stage}");
                if !why.trim().is_empty() {
                    eprintln!("{}", why.trim_end());
                }
                std::process::exit(EXIT_FAILED)
            }
        }
    }
}

/// The server to check: tmux on `socket`, here or through ssh.
struct Server {
    ssh: Option<String>,
    socket: String,
}

/// ssh may never ask anything (`BatchMode`) and gives up on a host that does
/// not answer.
const SSH_OPTIONS: [&str; 4] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];

impl Server {
    fn local(socket: &str) -> Self {
        Self {
            ssh: None,
            socket: socket.to_string(),
        }
    }

    fn remote(dest: &str, socket: &str) -> Self {
        Self {
            ssh: Some(dest.to_string()),
            socket: socket.to_string(),
        }
    }

    /// `command` on the host, through ssh, which joins it into one line for
    /// the remote shell: quoted for that shell.
    fn ssh(&self, command: &[&str]) -> Result<String, String> {
        let dest = self.ssh.as_deref().unwrap_or_default();
        let mut ssh = Command::new("ssh");
        ssh.args(SSH_OPTIONS)
            .arg("--")
            .arg(dest)
            .arg(shell_line(command));
        finished(ssh.output())
    }

    fn tmux(&self, args: &[&str]) -> Result<String, String> {
        match &self.ssh {
            Some(_) => self.ssh(&[&["tmux"], &socket_args(&self.socket)[..], args].concat()),
            None => finished(local_tmux_on(&self.socket).args(args).output()),
        }
    }

    fn version(&self) -> Result<String, String> {
        match &self.ssh {
            Some(_) => self.ssh(&["tmux", "-V"]),
            None => finished(Command::new(tmux_path()).arg("-V").output()),
        }
    }

    /// The sessions on the socket; none when no server runs there yet (the
    /// app starts one on attach).
    fn sessions(&self) -> Result<Vec<String>, String> {
        match self.tmux(&["list-sessions", "-F", "#{session_name}"]) {
            Ok(out) => Ok(out
                .lines()
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect()),
            Err(why) if is_no_server(&why) => Ok(Vec::new()),
            Err(why) => Err(why),
        }
    }
}

fn finished(output: std::io::Result<Output>) -> Result<String, String> {
    let output = output.map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_safe_session_skips_the_stash_and_unsafe_names() {
        let names = ["__tmuxy_stash", "-x", "my work", "dev", "other"].map(String::from);
        assert_eq!(first_safe_session(&names).as_deref(), Some("dev"));
        assert_eq!(first_safe_session(&[]), None);
    }
}
