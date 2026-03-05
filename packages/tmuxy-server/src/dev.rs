use axum::body::Body;
use axum::extract::Request;
use axum::response::Response;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Port for Vite dev server
pub const VITE_PORT: u16 = 9001;

/// Port for Next.js demo dev server
pub const DEMO_PORT: u16 = 9002;

/// Find an available port starting from 9000, incrementing until one is free.
/// Override with PORT env var.
pub fn get_port() -> u16 {
    if let Some(port) = std::env::var("PORT").ok().and_then(|p| p.parse().ok()) {
        return port;
    }

    for port in 9000..9100u16 {
        if std::net::TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return port;
        }
    }

    9000
}

/// Handle to a dev child process for cleanup
#[cfg(unix)]
pub struct ViteChild {
    pgid: i32,
}

#[cfg(unix)]
impl ViteChild {
    pub fn kill(&self) {
        unsafe {
            libc::killpg(self.pgid, libc::SIGTERM);
        }
        println!("[dev] Process group killed");
    }
}

#[cfg(not(unix))]
pub struct ViteChild {
    child: tokio::process::Child,
}

#[cfg(not(unix))]
impl ViteChild {
    pub fn kill(mut self) {
        let _ = self.child.start_kill();
        println!("[dev] Process killed");
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

fn is_hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP.contains(&name.to_ascii_lowercase().as_str())
}

async fn proxy_to_port(port: u16, req: Request) -> Response {
    let client = reqwest::Client::new();

    let uri = req.uri();
    let path_and_query = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");

    let target_url = format!("http://localhost:{}{}", port, path_and_query);

    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in req.headers() {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        if let Ok(name) = reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()) {
            if let Ok(value) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
                headers.insert(name, value);
            }
        }
    }

    let method = match req.method().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        _ => reqwest::Method::GET,
    };

    match client
        .request(method, &target_url)
        .headers(headers)
        .send()
        .await
    {
        Ok(resp) => {
            let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);

            let mut response_builder = Response::builder().status(status);

            for (name, value) in resp.headers() {
                if is_hop_by_hop(name.as_str()) {
                    continue;
                }
                if let Ok(name) = axum::http::HeaderName::from_bytes(name.as_str().as_bytes()) {
                    if let Ok(value) = axum::http::HeaderValue::from_bytes(value.as_bytes()) {
                        response_builder = response_builder.header(name, value);
                    }
                }
            }

            let body = resp.bytes().await.unwrap_or_default();
            response_builder
                .body(Body::from(body))
                .unwrap_or_else(|_| Response::new(Body::empty()))
        }
        Err(e) => {
            eprintln!("[dev] Proxy error: {}", e);
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

    #[cfg(unix)]
    let mut cmd = {
        let mut cmd = Command::new("npm");
        cmd.args(&args)
            .current_dir(&workspace_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unsafe {
            cmd.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
        cmd
    };

    #[cfg(not(unix))]
    let mut cmd = {
        let mut cmd = Command::new("npm");
        cmd.args(&args)
            .current_dir(&workspace_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    };

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("Failed to spawn {} dev server: {}", label, e);
            return None;
        }
    };

    #[cfg(unix)]
    let pid = child.id().unwrap_or(0) as i32;

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
                eprintln!("[{}] {}", label_err, line);
            }
        });
    }

    let label_wait = label.to_string();
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                if !status.success() {
                    eprintln!("[{}] Process exited with status: {}", label_wait, status);
                }
            }
            Err(e) => {
                eprintln!("[{}] Error waiting for process: {}", label_wait, e);
            }
        }
    });

    #[cfg(unix)]
    return Some(ViteChild { pgid: pid });

    #[cfg(not(unix))]
    return None;
}
