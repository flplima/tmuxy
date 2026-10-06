use axum::body::Body;
use axum::extract::Request;
use axum::http::HeaderMap;
use axum::response::Response;
use std::process::Stdio;
use std::sync::LazyLock;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{error, warn};

/// Port for Vite dev server
pub const VITE_PORT: u16 = 9001;

/// Port for Next.js demo dev server
pub const DEMO_PORT: u16 = 9002;

/// A dev child's process group, killed with the server.
pub struct ViteChild {
    #[cfg_attr(not(unix), allow(dead_code))]
    pgid: i32,
}

impl ViteChild {
    pub fn kill(&self) {
        // SAFETY: `killpg` takes plain integers and touches no memory of ours.
        #[cfg(unix)]
        unsafe {
            libc::killpg(self.pgid, libc::SIGTERM);
        }
        println!("[dev] Process group killed");
    }
}

/// Hop-by-hop headers that must not be forwarded by a proxy.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

/// One client for every proxied request, so connections to Vite are reused.
static PROXY_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

/// Drop the headers that describe one hop rather than the message.
fn without_hop_by_hop(headers: &HeaderMap) -> HeaderMap {
    let mut headers = headers.clone();
    for name in HOP_BY_HOP {
        headers.remove(*name);
    }
    headers
}

async fn proxy_to_port(port: u16, req: Request) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_url = format!("http://localhost:{port}{path_and_query}");

    match PROXY_CLIENT
        .request(req.method().clone(), &target_url)
        .headers(without_hop_by_hop(req.headers()))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            let headers = without_hop_by_hop(resp.headers());
            let body = resp.bytes().await.unwrap_or_default();
            let mut response = Response::new(Body::from(body));
            *response.status_mut() = status;
            *response.headers_mut() = headers;
            response
        }
        Err(e) => {
            warn!(error = %e, "dev proxy error");
            Response::builder()
                .status(axum::http::StatusCode::BAD_GATEWAY)
                .body(Body::from(format!("Proxy error: {}", e)))
                .unwrap_or_else(|_| Response::new(Body::empty()))
        }
    }
}

pub async fn proxy_to_vite(req: Request) -> Response {
    proxy_to_port(VITE_PORT, req).await
}

pub async fn proxy_to_demo(req: Request) -> Response {
    proxy_to_port(DEMO_PORT, req).await
}

pub async fn spawn_dev_server(
    label: &str,
    npm_workspace: &str,
    extra_args: &[&str],
) -> Option<ViteChild> {
    let workspace_root = crate::state::find_workspace_root();

    let mut args = vec!["run", "dev", "-w", npm_workspace];
    args.extend_from_slice(extra_args);

    let mut cmd = Command::new("npm");
    cmd.args(&args)
        .current_dir(&workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group, so the shutdown can stop npm and everything it
    // started with one signal.
    // SAFETY: `setpgid` is async-signal-safe, which is all `pre_exec` asks.
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            error!(%label, error = %e, "failed to spawn dev server");
            return None;
        }
    };

    let pgid = child.id().unwrap_or(0) as i32;

    let label_out = label.to_string();
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                println!("[{}] {}", label_out, line);
            }
        });
    }

    let label_err = label.to_string();
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                warn!(target: "tmuxy::dev", label = %label_err, "{}", line);
            }
        });
    }

    let label_wait = label.to_string();
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                if !status.success() {
                    warn!(label = %label_wait, %status, "dev process exited unsuccessfully");
                }
            }
            Err(e) => {
                error!(label = %label_wait, error = %e, "error waiting for dev process");
            }
        }
    });

    Some(ViteChild { pgid })
}
