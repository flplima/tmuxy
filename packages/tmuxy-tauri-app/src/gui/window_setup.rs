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

pub(super) fn handle_tmuxypreview(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;
    let not_found = || {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap_or_default()
    };
    // tmuxypreview://localhost/<pane digits>
    let number = request.uri().path().trim_start_matches('/').to_string();
    let Ok(pane) = tmuxy_core::PaneId::parse(&format!("%{number}")) else {
        return not_found();
    };
    let Some(page) = app.state::<tmuxy_core::preview::PreviewPages>().page(&pane) else {
        return not_found();
    };
    let mut builder = tauri::http::Response::builder().status(tauri::http::StatusCode::OK);
    for (name, value) in page.headers() {
        builder = builder.header(name, value);
    }
    builder
        .body(page.html.into_bytes())
        .unwrap_or_else(|_| not_found())
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
