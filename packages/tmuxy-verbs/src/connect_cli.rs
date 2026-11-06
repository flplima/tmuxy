//! `tmuxy-server connect`: ask the desktop app to reconnect to another tmux
//! server (`tmuxy_core::servers::connect`), and with `--save` remember the
//! server in `servers.json`. Backs `tmuxy connect <socket>` and the last stage
//! of `tmuxy session connect`, which probe the server first.

use tmuxy_core::servers::connect::{remember, ConnectRequest, CONNECT_REQUEST};

use crate::cli_json::{self, Answer, EXIT_FAILED, EXIT_USAGE};

#[derive(clap::Args, Debug)]
pub struct ConnectArgs {
    /// The tmux socket name (`-L`) or path (`-S`) to reconnect to.
    #[arg(long)]
    socket: String,
    /// The session to attach to there.
    #[arg(long)]
    session: Option<String>,
    /// `[user@]host`, for a server on another machine.
    #[arg(long)]
    ssh: Option<String>,
    /// Save the server to servers.json, for the session menu.
    #[arg(long)]
    save: bool,
    /// Answer in JSON.
    #[arg(long)]
    json: bool,
}

pub fn run(args: ConnectArgs) {
    let answer = Answer::new(args.json);
    let request =
        match ConnectRequest::new(&args.socket, args.session.as_deref(), args.ssh.as_deref()) {
            Ok(request) => request,
            Err(message) => std::process::exit(answer.fail(EXIT_USAGE, &message)),
        };
    if args.save {
        if let Some(server) = request.server(&tmuxy_core::session::tmux_socket()) {
            if let Err(e) = remember(server) {
                eprintln!("tmuxy: the server was not saved to servers.json: {e}");
            }
        }
    }
    let publish = [
        "set-environment".to_string(),
        "-g".into(),
        CONNECT_REQUEST.into(),
        request.encode(),
    ];
    if let Err(e) = tmuxy_core::plugins::job::run(&tmuxy_core::paths::Layout::current(), &publish) {
        std::process::exit(answer.fail(EXIT_FAILED, &e.to_string()));
    }
    let session = request.session.as_deref().unwrap_or_default();
    answer.done(
        &[
            ("socket", cli_json::string(&request.socket)),
            ("session", cli_json::string(session)),
        ],
        "",
    );
}
