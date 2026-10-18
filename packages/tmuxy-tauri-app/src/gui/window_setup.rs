use tauri::Manager;

use crate::titlebar;
use crate::windows;

/// Put the native blur behind the window on or off (`@tmuxy-blur`). macOS
/// only — the option is accepted and ignored elsewhere. The surface opacities
/// the blur shows through are the frontend's business (`theme::Appearance`,
/// applied as CSS variables).
#[cfg(target_os = "macos")]
pub(crate) fn apply_blur(window: &tauri::WebviewWindow, blur: bool) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        // Every apply adds a fresh NSVisualEffectView under the webview and
        // tauri's `set_effects(None)` clears nothing on macOS, so drop the
        // previous view first — that is also what turns blur off.
        if let Err(e) = window_vibrancy::clear_vibrancy(&target) {
            eprintln!("Failed to clear window blur: {}", e);
        }
        if !blur {
            return;
        }
        // Pin the effect state to Active so the blur stays applied when the
        // window loses key focus. NSVisualEffectView defaults to
        // FollowsWindowActiveState — switching away from the tmuxy window
        // would drop the blur and leave the inactive window flat.
        let effects = tauri::window::EffectsBuilder::new()
            .effect(tauri::window::Effect::UnderWindowBackground)
            .state(tauri::window::EffectState::Active)
            .build();
        if let Err(e) = target.set_effects(effects) {
            eprintln!("Failed to apply window blur: {}", e);
        }
    });
}

/// No native window material on this platform; the option is read for parity
/// and has nothing to drive.
#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_blur(_window: &tauri::WebviewWindow, _blur: bool) {}

/// Build a webview window from code so its transparency settings can react to
/// runtime env (TMUXY_OPAQUE_WINDOW=1 → opaque + decorated).
///
/// Defaults match the previous tauri.conf.json values exactly so production
/// behavior is unchanged: transparent webview, hidden macOS title with the
/// traffic lights centred on the status bar. The opaque branch removes both —
/// needed when running under Xvfb-style displays that lack a compositor.
///
/// Every GUI window is built here, the first one and the ones the Window menu
/// opens alike, so a second window is the same kind of window as the first.
pub(crate) fn build_window<M: Manager<tauri::Wry>>(
    app: &M,
    label: &str,
) -> tauri::Result<tauri::WebviewWindow> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let opaque = std::env::var_os("TMUXY_OPAQUE_WINDOW").is_some();

    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("tmuxy")
        .inner_size(800.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        // macOS swallows the first click on an inactive window — only the
        // os-level focus changes, the webview never sees the mousedown. With
        // `accept_first_mouse(true)` the click flows through, so clicking
        // an inactive pane to bring tmuxy back to the foreground also makes
        // that pane active in one motion instead of two.
        .accept_first_mouse(true);

    if !opaque {
        builder = builder.transparent(true);

        #[cfg(target_os = "macos")]
        {
            use tauri::TitleBarStyle;
            // The web status bar is the visible title bar; titlebar.rs keeps
            // the traffic-light buttons centred on it as its height changes.
            builder = builder
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true);
        }
    }

    let window = builder.build()?;

    if !opaque {
        titlebar::install(&window);
    } else {
        tracing::info!("TMUXY_OPAQUE_WINDOW=1: built window with decorations, no transparency");
    }
    // The two-finger slide between tabs, from the shell's own scroll phases.
    crate::gestures::install(&window);

    Ok(window)
}

/// The per-window set-up that is not the builder's: the native blur behind it,
/// the platform hint the layout reads, and the menu refresh that keeps the
/// Window menu describing whichever window has focus.
pub(crate) fn configure_window(window: &tauri::WebviewWindow) {
    // Blur is on by default (`@tmuxy-blur`). A window opens before its
    // monitor has sourced the config, so it starts with the default and
    // `monitor::emit_theme_settings` puts it where the live value says once
    // the config is read.
    apply_blur(window, true);

    // Tell the frontend which platform we're on so it can adjust layout
    // (e.g., hide hamburger menu on macOS, add traffic light spacing)
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let _ = window.eval(format!(
        "document.documentElement.setAttribute('data-platform', '{}')",
        platform
    ));

    // The registry follows the window out of existence, and (for a window that
    // has a session of its own) takes that session with it.
    windows::watch_for_close(window);
}

/// Reveal the app's log file (`tmuxy_core::paths::log_file`, the `tracing`
/// lines stderr would have shown) in the platform file manager: selected in
/// Finder on macOS, its directory opened elsewhere.
pub(crate) fn reveal_log_file() {
    let path = tmuxy_core::paths::log_file();
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
    }
}

pub(super) fn handle_tmuxycss(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path().to_string();
    let builder = tauri::http::Response::builder().header("Cache-Control", "no-store");
    match tmuxy_core::session::resolve_user_css(&path) {
        Some(css) => builder
            .status(tauri::http::StatusCode::OK)
            .header("Content-Type", "text/css; charset=utf-8")
            .body(css),
        None => builder
            .status(tauri::http::StatusCode::NOT_FOUND)
            .body(Vec::new()),
    }
    .unwrap_or_default()
}

pub(super) fn handle_tmuxyimg(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap_or_default()
    };
    // tmuxyimg://localhost/<pane digits>/<image id>
    let path = request.uri().path().to_string();
    match windows::lookup_image(app, &path) {
        Some(img) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::OK)
            .header("Content-Type", img.mime_type)
            // Placement ids restart with the process, so a cached
            // response would be the previous run's picture.
            .header("Cache-Control", "no-store")
            .body(img.data)
            .unwrap_or_else(|_| not_found()),
        None => not_found(),
    }
}

pub(super) fn handle_tmuxyfile(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    // SEC-19. This scheme reads any file the app can, so who may READ
    // the answer matters as much as what it returns. `*` let anything
    // fetch it — including a local page the widget itself framed with
    // `sandbox allow-scripts`, which has an opaque origin and could
    // therefore read `~/.ssh/id_ed25519` through this scheme and send
    // it anywhere. Only the app's own origin is allowed now, and a
    // sandboxed frame's `Origin: null` is not it.
    let allowed_origin = request
        .headers()
        .get("Origin")
        .and_then(|v| v.to_str().ok())
        .filter(|origin| is_app_origin(origin))
        .map(str::to_string);

    let respond = |status: tauri::http::StatusCode, content_type: &str, body: Vec<u8>| {
        let mut builder = tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            // A widget re-reads a file to show an edit; a cached
            // response would show the version from before the save.
            .header("Cache-Control", "no-store")
            // The same sandbox the web routes answer with: an HTML
            // file served here would otherwise run in the app's own
            // origin, with the Tauri IPC behind it.
            .header(
                "Content-Security-Policy",
                tmuxy_core::mime::FILE_SANDBOX_CSP,
            );
        if let Some(origin) = &allowed_origin {
            builder = builder.header("Access-Control-Allow-Origin", origin.as_str());
        }
        builder.body(body).unwrap_or_default()
    };
    let path = tmuxy_core::mime::percent_decode(request.uri().path());
    match tmuxy_core::mime::read_served_file(&path) {
        Ok(bytes) => respond(
            tauri::http::StatusCode::OK,
            tmuxy_core::mime::content_type_for_path(&path),
            bytes,
        ),
        Err(refusal) => {
            use tmuxy_core::mime::ServeRefusal;
            let (status, message) = match refusal {
                ServeRefusal::NotFound(e) => (
                    tauri::http::StatusCode::NOT_FOUND,
                    format!("{}: {}", path, e),
                ),
                ServeRefusal::NotRegular => (
                    tauri::http::StatusCode::BAD_REQUEST,
                    format!("{}: not a regular file", path),
                ),
                ServeRefusal::TooLarge { bytes } => (
                    tauri::http::StatusCode::PAYLOAD_TOO_LARGE,
                    format!("{}: {} bytes is over the limit", path, bytes),
                ),
            };
            respond(status, "text/plain; charset=utf-8", message.into_bytes())
        }
    }
}

/// Whether `origin` is the app's own webview origin.
///
/// Tauri serves the app from `tauri://localhost` (macOS/Linux) or
/// `http://tauri.localhost` (Windows). Anything else asking to read a
/// `tmuxyfile:` response is not the app: a framed local page carries
/// `Origin: null` under its sandbox, and a remote page carries its own site.
fn is_app_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tmuxyfile_origin_tests {
    use super::is_app_origin;

    /// SEC-19. The scheme reads any file the app can. A local page the widget
    /// framed runs sandboxed, so it has an opaque origin — `null` — and must
    /// not be able to read `~/.ssh/id_ed25519` through it.
    #[test]
    fn only_the_apps_own_origin_may_read_a_served_file() {
        assert!(is_app_origin("tauri://localhost"));
        assert!(is_app_origin("http://tauri.localhost"));

        for other in [
            "null",
            "https://evil.example",
            "tauri://localhost.evil.example",
            "http://localhost:9000",
            "",
        ] {
            assert!(
                !is_app_origin(other),
                "{other} must not be treated as the app"
            );
        }
    }
}
