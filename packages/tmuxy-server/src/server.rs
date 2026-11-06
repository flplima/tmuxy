use axum::extract::Request;
use clap::{Args, Subcommand};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use tracing::error;

use crate::dev;
use crate::request_guard::HostPolicy;
use crate::state::AppState;

mod lifecycle;
use lifecycle::*;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;

#[derive(Args)]
pub struct ServerArgs {
    #[command(subcommand)]
    pub action: Option<ServerAction>,

    /// Port to listen on
    #[arg(long, default_value_t = DEFAULT_PORT)]
    pub port: u16,

    /// Address to listen on. The default is reachable from this machine only
    /// (and through an SSH tunnel). Any other address needs --password, or
    /// --no-auth to serve it open.
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// Require HTTP Basic auth with this password (any username is accepted).
    /// Falls back to the TMUXY_PASSWORD env var. Prefer TMUXY_PASSWORD to keep
    /// the secret out of `ps`.
    #[arg(long)]
    pub password: Option<String>,

    /// Serve a non-loopback --host with no password. Anyone who can reach the
    /// port gets a shell as you, so only on a network where that is already
    /// true of everyone on it (a container's published port, a private VPN).
    #[arg(long)]
    pub no_auth: bool,

    /// A hostname requests may be addressed to besides loopback ones — the
    /// public name of a reverse proxy that forwards its `Host`. Repeatable;
    /// also read from TMUXY_ALLOWED_HOSTS (comma-separated).
    #[arg(long = "allowed-host", value_name = "HOST")]
    pub allowed_hosts: Vec<String>,

    /// Start a missing session empty even when a snapshot of it exists
    /// (`TMUXY_NO_RESTORE=1` does the same).
    #[arg(long)]
    pub no_restore: bool,

    /// Run in development mode (proxy to Vite dev server)
    #[arg(long)]
    pub dev: bool,

    /// Enable local action tracing to an NDJSON file (see docs/TRACING.md).
    /// Pass a path to choose the file, or bare `--trace` for the default under
    /// the state dir. Off by default on release builds; the trace never leaves
    /// this machine. `DO_NOT_TRACK=1` or `TMUXY_NO_TRACE=1` force it off.
    #[arg(long, value_name = "PATH", num_args = 0..=1)]
    pub trace: Option<Option<String>>,
}

/// Resolve the auth password: a non-empty `--password` wins, else a non-empty
/// `TMUXY_PASSWORD` env var; an empty `--password ""` falls back to
/// `TMUXY_PASSWORD` instead of silently disabling it.
fn resolve_password(flag: Option<String>) -> Option<String> {
    resolve_password_from(flag, std::env::var("TMUXY_PASSWORD").ok())
}

fn resolve_password_from(flag: Option<String>, env_password: Option<String>) -> Option<String> {
    flag.filter(|s| !s.is_empty())
        .or_else(|| env_password.filter(|s| !s.is_empty()))
}

const DEFAULT_PORT: u16 = 9000;

fn with_optional_auth(
    app: axum::Router,
    password: Option<String>,
    policy: HostPolicy,
) -> axum::Router {
    match password {
        Some(pw) => app.layer(axum::middleware::from_fn_with_state(
            std::sync::Arc::new(crate::auth::AuthState {
                password: pw,
                throttle: crate::auth::AuthThrottle::new(),
                policy,
            }),
            crate::auth::require_basic_auth,
        )),
        None => app,
    }
}

/// Where the server listens, and which `Host` names its API answers.
#[derive(Debug, PartialEq, Eq)]
struct Listen {
    ip: IpAddr,
    policy: HostPolicy,
}

/// Resolve `--host` against the auth settings. A loopback address is served as
/// it is. Any other address puts a shell on the network, so it needs a
/// password — or `--no-auth`, saying out loud that the network is trusted.
/// See docs/SECURITY.md.
fn resolve_listen(
    host: &str,
    password_set: bool,
    no_auth: bool,
    allowed_hosts: Vec<String>,
) -> Result<Listen, String> {
    let ip: IpAddr = if host.eq_ignore_ascii_case("localhost") {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .parse()
            .map_err(|_| {
                format!("--host {host} is not an IP address (try 127.0.0.1, ::1 or 0.0.0.0)")
            })?
    };
    if ip.is_loopback() {
        return Ok(Listen {
            ip,
            policy: HostPolicy::Loopback {
                allowed: allowed_hosts,
            },
        });
    }
    if !password_set && !no_auth {
        return Err(format!(
            "refusing to listen on {ip} with no password: anyone who can reach it would get a shell as you.\n\
             Set TMUXY_PASSWORD (or --password), listen on --host 127.0.0.1, or pass --no-auth on a network you trust."
        ));
    }
    // A routable bind checks `Host` too: without it a routable `--no-auth`
    // bind is one DNS rebind from a shell. `bound` is None for a wildcard,
    // which answers on every address it has.
    let bound = (!ip.is_unspecified()).then_some(ip);
    Ok(Listen {
        ip,
        policy: HostPolicy::Bound {
            bound,
            allowed: allowed_hosts,
        },
    })
}

fn resolve_allowed_hosts(flag: Vec<String>) -> Vec<String> {
    let env = std::env::var("TMUXY_ALLOWED_HOSTS").unwrap_or_default();
    flag.into_iter()
        .chain(
            env.split(',')
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .map(String::from),
        )
        .collect()
}

/// Get the process ready to serve (`tmuxy_core::host::prepare`), or stop
/// with the reason: with no usable tmux every client would sit reconnecting
/// to a monitor that can never attach.
fn prepare() {
    if let Err(e) = tmuxy_core::host::prepare::prepare() {
        eprintln!("tmuxy server: {e}");
        std::process::exit(1);
    }
}

/// Print the auth status, and warn loudly about a routable address served with
/// `--no-auth` — matching the threat model in docs/SECURITY.md.
fn announce_security(listen: &Listen, password_set: bool) {
    if password_set {
        println!(
            "tmuxy server: HTTP Basic auth enabled (any username; use the configured password)"
        );
    } else if matches!(listen.policy, HostPolicy::Bound { .. }) {
        eprintln!(
            "warning: --no-auth on {} — anyone who can reach this port has full shell access.",
            listen.ip
        );
    }
}

#[derive(Subcommand)]
pub enum ServerAction {
    /// Stop the running server
    Stop,
    /// Show server status
    Status,
    #[command(flatten)]
    Verb(tmuxy_verbs::Verb),
}

/// `argv` is the program name, then `tmuxy server`'s own arguments: the
/// standalone binary hands over its own, and the desktop binary builds one
/// for `tmuxy server …` and `tmuxy trace …`. Serving, `stop` and `status` are
/// this crate's; every other verb is `tmuxy-verbs`'. A parse error prints
/// clap's message and exits.
pub async fn run_argv<I, T>(argv: I)
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString> + Clone,
{
    #[derive(clap::Parser)]
    #[command(
        name = "tmuxy-server",
        about = "Tmuxy production server with embedded frontend"
    )]
    struct Cli {
        #[command(flatten)]
        server: ServerArgs,
    }
    let cli = <Cli as clap::Parser>::parse_from(argv);
    run(cli.server).await
}

pub async fn run(args: ServerArgs) {
    let dev_mode = args.dev;
    let password = resolve_password(args.password.clone());
    match args.action {
        None => {
            let allowed_hosts = resolve_allowed_hosts(args.allowed_hosts);
            let listen =
                match resolve_listen(&args.host, password.is_some(), args.no_auth, allowed_hosts) {
                    Ok(listen) => listen,
                    Err(message) => {
                        eprintln!("tmuxy server: {message}");
                        std::process::exit(2);
                    }
                };
            prepare();
            let frontend = if dev_mode {
                Frontend::Dev
            } else {
                Frontend::Embedded
            };
            let state = AppState {
                restore: !args.no_restore,
                ..AppState::default()
            };
            serve(frontend, args.port, listen, password, state, args.trace).await
        }
        Some(ServerAction::Stop) => stop_server(args.port),
        Some(ServerAction::Status) => server_status(args.port),
        Some(ServerAction::Verb(verb)) => tmuxy_verbs::run(verb).await,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Frontend {
    Embedded,
    /// `--dev`: Vite started as a child and proxied, so the UI hot-reloads.
    Dev,
}

async fn serve(
    frontend: Frontend,
    port: u16,
    listen: Listen,
    password: Option<String>,
    state: AppState,
    trace: Option<Option<String>>,
) {
    // Vite binds a hard-coded port (strictPort: true, 9001). If tmuxy-server
    // takes it, Vite fails silently and the dev proxy loops back to
    // tmuxy-server itself: EventSources 404 on /events while `curl` appears
    // to work.
    if frontend == Frontend::Dev && port == dev::VITE_PORT {
        error!(port, "FATAL: port collides with the hard-coded Vite port");
        error!(
            vite_port = dev::VITE_PORT,
            "choose a different port (e.g. --port 9000) and restart"
        );
        std::process::exit(1);
    }

    let state = Arc::new(state);
    let started = tmuxy_core::host::start(state.clone(), trace, frontend == Frontend::Dev);
    if frontend == Frontend::Embedded {
        write_pid_file(port);
    }

    let vite = match frontend {
        Frontend::Embedded => None,
        Frontend::Dev => {
            println!(
                "[dev] Starting Vite dev server on port {}...",
                dev::VITE_PORT
            );
            let vite = dev::spawn_vite().await;
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            vite
        }
    };

    let shutdown = state.shutdown.clone();
    let background = started.background;
    state
        .spawn(async move {
            tokio::select! {
                _ = background => {}
                _ = shutdown.cancelled() => {}
            }
        })
        .await;
    crate::push::watch(state.clone(), started.panes).await;
    let routes = crate::state::api_routes(listen.policy.clone());
    let app = match frontend {
        Frontend::Embedded => routes.fallback(serve_embedded),
        Frontend::Dev => routes.fallback_service(tower::service_fn(|req: Request| async move {
            Ok::<_, std::convert::Infallible>(serve_dev(req).await)
        })),
    }
    .with_state(state.clone());
    let password_set = password.is_some();
    let app = with_optional_auth(app, password, listen.policy.clone());

    let addr = std::net::SocketAddr::new(listen.ip, port);
    match frontend {
        Frontend::Embedded => println!("tmuxy server running at http://{addr}"),
        Frontend::Dev => println!("tmuxy dev server running at http://{addr}"),
    }
    announce_security(&listen, password_set);
    if frontend == Frontend::Dev {
        println!("[dev] Vite proxied from port {}", dev::VITE_PORT);
    }

    let listener = bind_with_retry(addr, BIND_RETRIES).await;

    // `into_make_service_with_connect_info` rather than the plain router: the
    // auth layer reads the peer address to rate-limit failed passwords per
    // source, and `ConnectInfo` is only populated by this make-service.
    if let Err(e) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(state, vite))
    .await
    {
        error!(error = %e, "axum serve loop exited with error");
    }

    if frontend == Frontend::Embedded {
        remove_pid_file(port, std::process::id());
    }
}
