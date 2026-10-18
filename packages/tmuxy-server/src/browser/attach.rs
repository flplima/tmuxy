//! Finding a browser that is already running, for `--attach` with no endpoint.
//!
//! A browser with remote debugging on announces itself in one of two ways, and
//! both are looked at before giving up:
//!
//!   1. `DevToolsActivePort` in its profile directory — the port on the first
//!      line and the websocket path on the second. Chrome writes it on start
//!      whenever debugging is enabled, including through the consent prompt at
//!      `chrome://inspect/#remote-debugging` (Chrome 144+), which is the only
//!      way the DEFAULT profile ever gets one.
//!   2. A listener on `127.0.0.1:9222`, the port everyone passes to
//!      `--remote-debugging-port` when they start a browser by hand.
//!
//! This is a probe, never a launch: nothing here starts a browser, and 9222
//! appears here only to be LOOKED for (see `engine.rs` for why a browser tmuxy
//! starts never listens there).
use std::path::PathBuf;

/// The port every hand-started browser is told to listen on.
const USUAL_PORT: u16 = 9222;

/// How long the loopback probe may take: a closed port answers at once, and
/// a port that neither answers nor refuses is not a browser.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

/// The DevTools endpoint of a browser already running on this machine.
///
/// `asked` is what `--attach` was given: a real endpoint is used as it is, and
/// the bare flag (`auto`) looks. The error names what was looked at, in the
/// terms the user needs to fix it.
pub async fn resolve_endpoint(asked: &str) -> Result<String, String> {
    if !asked.is_empty() && asked != "auto" {
        return Ok(asked.to_string());
    }
    let profiles = profile_dirs();
    if let Some(endpoint) = profiles.iter().find_map(|dir| active_port_endpoint(dir)) {
        return Ok(endpoint);
    }
    if port_open(USUAL_PORT).await {
        return Ok(format!("http://127.0.0.1:{USUAL_PORT}"));
    }
    let mut message = String::from(
        "no running browser with remote debugging found. Either start one with \
         `--remote-debugging-port=9222 --user-data-dir=<some dir>`, or turn it on \
         for your own profile at chrome://inspect/#remote-debugging (Chrome 144+), \
         then try again — or pass the endpoint: --attach http://127.0.0.1:PORT.\n\n\
         Looked for DevToolsActivePort in:",
    );
    for dir in &profiles {
        message.push_str(&format!("\n  {}", dir.display()));
    }
    message.push_str(&format!("\nand for a listener on 127.0.0.1:{USUAL_PORT}."));
    Err(message)
}

/// The endpoint a profile's `DevToolsActivePort` names, if there is one and
/// something is still listening on it — the file outlives the browser, and
/// a stale one would name a port now held by anything.
fn active_port_endpoint(profile: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let endpoint = parse_active_port(&text)?;
    let port = endpoint_port(&endpoint)?;
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        PROBE_TIMEOUT,
    )
    .ok()?;
    Some(endpoint)
}

/// `DevToolsActivePort`'s two lines as a websocket URL.
fn parse_active_port(text: &str) -> Option<String> {
    let mut lines = text.lines().map(str::trim);
    let port: u16 = lines.next()?.parse().ok()?;
    let path = lines.next()?;
    if port == 0 || !path.starts_with('/') {
        return None;
    }
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

fn endpoint_port(endpoint: &str) -> Option<u16> {
    let rest = endpoint.split("://").nth(1)?;
    let authority = rest.split('/').next()?;
    authority.rsplit(':').next()?.parse().ok()
}

async fn port_open(port: u16) -> bool {
    tokio::time::timeout(
        PROBE_TIMEOUT,
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|connected| connected.is_ok())
}

/// Where each browser keeps its default profile, most-preferred first — the
/// same order `discover.rs` prefers the binaries in.
#[cfg(target_os = "macos")]
fn profile_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let support = home.join("Library/Application Support");
    [
        "Google/Chrome",
        "Chromium",
        "Microsoft Edge",
        "BraveSoftware/Brave-Browser",
    ]
    .iter()
    .map(|name| support.join(name))
    .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn profile_dirs() -> Vec<PathBuf> {
    let Some(config) = dirs::config_dir() else {
        return Vec::new();
    };
    [
        "google-chrome",
        "chromium",
        "microsoft-edge",
        "BraveSoftware/Brave-Browser",
    ]
    .iter()
    .map(|name| config.join(name))
    .collect()
}

#[cfg(not(unix))]
fn profile_dirs() -> Vec<PathBuf> {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return Vec::new();
    };
    let local = PathBuf::from(local);
    [
        r"Google\Chrome\User Data",
        r"Chromium\User Data",
        r"Microsoft\Edge\User Data",
        r"BraveSoftware\Brave-Browser\User Data",
    ]
    .iter()
    .map(|name| local.join(name))
    .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_active_port_file_names_a_websocket() {
        assert_eq!(
            parse_active_port("53121\n/devtools/browser/0a1b-2c3d\n"),
            Some("ws://127.0.0.1:53121/devtools/browser/0a1b-2c3d".into())
        );
        // A browser that has exited leaves nothing usable behind.
        assert_eq!(parse_active_port(""), None);
        assert_eq!(parse_active_port("0\n/devtools/browser/x\n"), None);
        assert_eq!(parse_active_port("notaport\n/x"), None);
        assert_eq!(parse_active_port("53121\n"), None);
    }

    #[test]
    fn the_port_is_read_off_either_endpoint_shape() {
        assert_eq!(
            endpoint_port("ws://127.0.0.1:53121/devtools/browser/x"),
            Some(53121)
        );
        assert_eq!(endpoint_port("http://127.0.0.1:9222"), Some(9222));
        assert_eq!(endpoint_port("nonsense"), None);
    }

    #[tokio::test]
    async fn an_explicit_endpoint_is_used_as_given() {
        assert_eq!(
            resolve_endpoint("http://127.0.0.1:1").await.as_deref(),
            Ok("http://127.0.0.1:1")
        );
    }

    #[tokio::test]
    async fn a_profile_whose_port_nobody_listens_on_is_stale() {
        let dir = std::env::temp_dir().join(format!("tmuxy-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A port nothing listens on: bound, then released.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        std::fs::write(
            dir.join("DevToolsActivePort"),
            format!("{port}\n/devtools/browser/gone\n"),
        )
        .unwrap();
        assert_eq!(active_port_endpoint(&dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_live_profile_port_is_the_endpoint() {
        let dir = std::env::temp_dir().join(format!("tmuxy-attach-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::write(
            dir.join("DevToolsActivePort"),
            format!("{port}\n/devtools/browser/here\n"),
        )
        .unwrap();
        assert_eq!(
            active_port_endpoint(&dir),
            Some(format!("ws://127.0.0.1:{port}/devtools/browser/here"))
        );
        drop(listener);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
