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

/// The port `tmuxy server` listens on unless told otherwise.
const DEFAULT_PORT: u16 = 9000;

/// Wrap the router in the Basic-auth layer when a password is configured.
/// With no password the router is returned unchanged (server stays open).
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
    // SEC-10/SEC-15: a routable bind keeps the allowed list and still checks
    // `Host` against it. It used to be discarded here, so `--allowed-host` (and
    // `TMUXY_ALLOWED_HOSTS`, which the public demo builds it from) silently did
    // nothing, and a routable `--no-auth` bind was one DNS rebind from a shell.
    // `bound` is None for a wildcard, which answers on every address it has.
    let bound = (!ip.is_unspecified()).then_some(ip);
    Ok(Listen {
        ip,
        policy: HostPolicy::Bound {
            bound,
            allowed: allowed_hosts,
        },
    })
}

/// `--allowed-host` values plus the comma-separated `TMUXY_ALLOWED_HOSTS`.
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

/// Stop before serving anything when there is no usable tmux: every client
/// would otherwise sit reconnecting to a monitor that can never attach.
fn require_tmux() {
    match tmuxy_core::tmux_check::check_tmux() {
        Ok(version) => tracing::info!(%version, "tmux found"),
        Err(e) => {
            eprintln!("tmuxy server: {e}");
            std::process::exit(1);
        }
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
    /// Inspect a local action-trace file: print a summary, or export a
    /// Chrome-trace/Perfetto timeline with `--export` (docs/TRACING.md).
    Trace(crate::trace_view::TraceViewArgs),
    /// Save, restore, list or forget session snapshots. Backs
    /// `tmuxy session save|restore|snapshots|forget`.
    Session(crate::session_cli::SessionArgs),
    /// Pane-group operations. Backs the `packages/tmuxy-cli/bin/tmuxy/pane-group` script,
    /// which run it inside `tmux run-shell`. Hidden: `tmuxy pane group` is
    /// the user's way in.
    #[command(hide = true)]
    Group(tmuxy_group::GroupArgs),
    /// Wire coding agents (Claude Code, Codex, Antigravity) into tmuxy: hooks
    /// that show their state, and the tmuxy skill. Backs `tmuxy agent`.
    Agent(crate::agents::AgentArgs),
}

/// Parse `argv` — the program name first, then `tmuxy server`'s own arguments
/// and subcommands — and run it. The one clap wrapper around [`ServerArgs`]:
/// the standalone `tmuxy-server` binary hands over its own argv, and the
/// desktop binary builds one for `tmuxy server …` and `tmuxy trace …`. A
/// parse error prints clap's message and exits, as clap does.
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
            require_tmux();
            // Action tracing per the gating rules (docs/TRACING.md), which
            // announces itself. Only on the actual server-start path — never
            // for stop/status/tree/connect.
            tmuxy_core::trace::init(args.trace.clone(), dev_mode);
            if args.no_restore {
                std::env::set_var("TMUXY_NO_RESTORE", "1");
            }
            let frontend = if dev_mode {
                Frontend::Dev
            } else {
                Frontend::Embedded
            };
            serve(frontend, args.port, listen, password).await
        }
        Some(ServerAction::Stop) => stop_server(args.port),
        Some(ServerAction::Status) => server_status(args.port),
        Some(ServerAction::Trace(view_args)) => crate::trace_view::run(view_args),
        Some(ServerAction::Session(session_args)) => crate::session_cli::run(session_args).await,
        Some(ServerAction::Group(group_args)) => tmuxy_group::run(group_args),
        Some(ServerAction::Agent(agent_args)) => crate::agents::run(agent_args),
    }
}

/// Where the app's own pages come from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Frontend {
    /// The built frontend compiled into this binary.
    Embedded,
    /// `--dev`: Vite started as a child and proxied, so the UI hot-reloads.
    Dev,
}

/// Serve the API and the frontend until a shutdown signal.
async fn serve(frontend: Frontend, port: u16, listen: Listen, password: Option<String>) {
    // Vite binds a hard-coded port (strictPort: true, 9001). If tmuxy-server is
    // told to bind that one, it wins the race; Vite fails silently, and the
    // `proxy_to_vite` fallback then loops back to tmuxy-server itself — browser
    // EventSources 404 on /events while `curl` (different headers/timing)
    // appears to work. Bail early with an actionable message instead of
    // letting that happen.
    if frontend == Frontend::Dev && port == dev::VITE_PORT {
        error!(port, "FATAL: port collides with the hard-coded Vite port");
        error!(
            vite_port = dev::VITE_PORT,
            "choose a different port (e.g. --port 9000) and restart"
        );
        std::process::exit(1);
    }

    if frontend == Frontend::Embedded {
        write_pid_file(port);
    }
    // Migrate an older install's config dir, mirror the shipped config and
    // the built-in themes into the data dir, and build the config chain.
    tmuxy_core::session::ensure_config();
    tmuxy_core::session::ensure_themes();
    // Materialize bundled CLI dispatcher and helper scripts so the in-config
    // `command-alias` entries (Ctrl+hjkl nav, pane groups, etc.) and the
    // direct "Add Pane to Group" menu commands resolve at
    // `$TMUXY_DATA_DIR/bin/tmuxy/…`, the data dir the config chain publishes
    // to tmux. Mirrors gui.rs setup().
    tmuxy_core::session::ensure_bin_scripts();

    let state = Arc::new(AppState::new());

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

    crate::sse::watch_config_dir(state.clone()).await;
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
