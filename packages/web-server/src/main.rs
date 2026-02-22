use axum::{body::Body, extract::Request, response::Response};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::signal;
use tower_http::services::ServeDir;
use web_server::AppState;

/// Port for Vite dev server
const VITE_PORT: u16 = 1420;

/// Find an available port starting from 9000, incrementing until one is free.
/// Override with PORT env var.
fn get_port() -> u16 {
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

/// Handle to Vite child process for cleanup
#[cfg(unix)]
struct ViteChild {
    pgid: i32,
}

#[cfg(unix)]
impl ViteChild {
    fn kill(&self) {
        unsafe {
            libc::killpg(self.pgid, libc::SIGTERM);
        }
        println!("[dev] Vite process group killed");
    }
}

#[cfg(not(unix))]
struct ViteChild {
    child: tokio::process::Child,
}

#[cfg(not(unix))]
impl ViteChild {
    fn kill(mut self) {
        let _ = self.child.start_kill();
        println!("[dev] Vite process killed");
    }
}

#[tokio::main]
async fn main() {
    let dev_mode = std::env::args().any(|arg| arg == "--dev")
        || std::env::var("TMUXY_DEV").is_ok();

    let state = Arc::new(AppState::new());

    // In dev mode, spawn Vite dev server
    let vite_child = if dev_mode {
        println!("[dev] Starting Vite dev server on port {}...", VITE_PORT);
        let child = spawn_vite_dev_server().await;
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        child
    } else {
        None
    };

    // Build router: API routes + fallback (Vite proxy or static files)
    let app = if dev_mode {
        web_server::api_routes()
            .fallback_service(tower::service_fn(|req: Request| async move {
                Ok::<_, std::convert::Infallible>(proxy_to_vite(req).await)
            }))
            .with_state(state)
    } else {
        web_server::api_routes()
            .fallback_service(ServeDir::new("dist"))
            .with_state(state)
    };

    let port = get_port();
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    println!("tmuxy web server running at http://localhost:{}", port);
    if dev_mode {
        println!("[dev] Vite HMR and static files proxied from port {}", VITE_PORT);
    }

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(vite_child))
        .await
        .unwrap();
}

async fn shutdown_signal(vite_child: Option<ViteChild>) {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    println!("\nShutting down...");

    if let Some(child) = vite_child {
        child.kill();
    }
}

async fn proxy_to_vite(req: Request) -> Response {
    let client = reqwest::Client::new();

    let uri = req.uri();
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    let vite_url = format!("http://localhost:{}{}", VITE_PORT, path_and_query);

    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in req.headers() {
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

    match client.request(method, &vite_url).headers(headers).send().await {
        Ok(resp) => {
            let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);

            let mut response_builder = Response::builder().status(status);

            for (name, value) in resp.headers() {
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

async fn spawn_vite_dev_server() -> Option<ViteChild> {
    let workspace_root = web_server::find_workspace_root();

    #[cfg(unix)]
    let mut cmd = {
        let mut cmd = Command::new("npm");
        cmd.args(["run", "dev", "-w", "tmuxy-ui"])
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
        cmd.args(["run", "dev", "-w", "tmuxy-ui"])
            .current_dir(&workspace_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    };

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("Failed to spawn Vite dev server: {}", e);
            return None;
        }
    };

    #[cfg(unix)]
    let pid = child.id().unwrap_or(0) as i32;

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                println!("[vite] {}", line);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[vite] {}", line);
            }
        });
    }

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                if !status.success() {
                    eprintln!("[vite] Process exited with status: {}", status);
                }
            }
            Err(e) => {
                eprintln!("[vite] Error waiting for process: {}", e);
            }
        }
    });

    #[cfg(unix)]
    return Some(ViteChild { pgid: pid });

    #[cfg(not(unix))]
    return None;
}
