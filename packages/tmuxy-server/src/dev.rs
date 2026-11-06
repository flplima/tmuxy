use axum::body::Body;
use axum::extract::Request;
use axum::http::HeaderMap;
use axum::response::Response;
use std::process::Stdio;
use std::sync::LazyLock;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{error, warn};

pub const VITE_PORT: u16 = 9001;

pub struct ViteChild {
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

/// Hop-by-hop headers a proxy must not forward (RFC 9110 §7.6.1).
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

static PROXY_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

fn without_hop_by_hop(headers: &HeaderMap) -> HeaderMap {
    let mut headers = headers.clone();
    for name in HOP_BY_HOP {
        headers.remove(*name);
    }
    headers
}

pub async fn proxy_to_vite(req: Request) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_url = format!("http://localhost:{VITE_PORT}{path_and_query}");

    match PROXY_CLIENT
        .request(req.method().clone(), &target_url)
        .headers(without_hop_by_hop(req.headers()))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            let headers = without_hop_by_hop(resp.headers());
            match resp.bytes().await {
                Ok(body) => {
                    let mut response = Response::new(Body::from(body));
                    *response.status_mut() = status;
                    *response.headers_mut() = headers;
                    response
                }
                Err(e) => bad_gateway(&e),
            }
        }
        Err(e) => bad_gateway(&e),
    }
}

/// Vite did not answer, or its answer broke off: never an empty page under
/// Vite's status.
fn bad_gateway(e: &reqwest::Error) -> Response {
    warn!(error = %e, "dev proxy error");
    Response::builder()
        .status(axum::http::StatusCode::BAD_GATEWAY)
        .body(Body::from(format!("Proxy error: {e}")))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// The npm workspace Vite runs in: the nearest ancestor of the cwd whose
/// package.json declares "workspaces" (a package's own does not).
fn workspace_root() -> Option<std::path::PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    cwd.ancestors()
        .find(|dir| {
            std::fs::read_to_string(dir.join("package.json"))
                .is_ok_and(|json| json.contains("\"workspaces\""))
        })
        .map(std::path::Path::to_path_buf)
}

/// Vite, from the checkout, and once it listens on [`VITE_PORT`].
pub async fn spawn_vite() -> Option<ViteChild> {
    let label = "vite";
    let Some(workspace_root) = workspace_root() else {
        error!("--dev runs Vite from a checkout, and none is above the current directory");
        return None;
    };

    let mut cmd = Command::new("npm");
    cmd.args(["run", "dev", "-w", "tmuxy-ui"])
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

    // `killpg(0)` would be the server's own group: without the child's id
    // there is no group to kill later, so the child is not kept.
    let Some(pgid) = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .filter(|&id| id > 1)
    else {
        error!(%label, "dev server has no process id");
        let _ = child.start_kill();
        return None;
    };

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

    wait_until_listening().await;
    Some(ViteChild { pgid })
}

/// How long Vite may take to listen before the server starts without it,
/// warning, and every request is a 502 until it does.
const VITE_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

async fn wait_until_listening() {
    let deadline = tokio::time::Instant::now() + VITE_START_TIMEOUT;
    while tokio::net::TcpStream::connect(("localhost", VITE_PORT))
        .await
        .is_err()
    {
        if tokio::time::Instant::now() >= deadline {
            warn!(
                port = VITE_PORT,
                "Vite is not listening yet; starting without it"
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
