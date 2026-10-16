use tauri::Manager;
use tmuxy_core::session;

use crate::commands;
use crate::monitor;
use crate::titlebar;
use crate::window_style::WindowStyles;
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

/// Start the Tauri GUI application.
pub fn run() {
    // The same subscriber as the server's, plus a copy of its lines in the
    // state dir: an app launched from Finder has no stderr anyone sees, and
    // the file is what Help ▸ Reveal Log File shows and the smoke tests read.
    tmuxy_server::init_logging_to_file(&tmuxy_core::paths::log_file());
    tmuxy_core::trace::init(None, cfg!(debug_assertions));

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // WebDriver plugin: enables GUI testing via W3C WebDriver on all platforms
    // including macOS (where the official tauri-driver doesn't support WKWebView).
    // Only included when built with --features webdriver.
    #[cfg(feature = "webdriver")]
    {
        builder = builder.plugin(tauri_plugin_webdriver::init());
    }

    // Status-bar height reported by the frontend — see titlebar.rs.
    #[cfg(target_os = "macos")]
    {
        builder = builder.manage(titlebar::TitlebarState::default());
    }

    builder
        // Single instance: when user clicks the app icon while already running,
        // bring the existing window to front instead of launching a broken second instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Clipboard manager: Debug ▸ Copy Trace Path.
        .plugin(tauri_plugin_clipboard_manager::init())
        // Window state: the window comes back where it was closed — position,
        // size, maximized and fullscreen — from a file in the app's data dir.
        // The 800×600 in the window builder is only the first-launch default.
        // Visibility is deliberately not restored: a window hidden at quit
        // must not come back hidden.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(monitor::KeyBindingsState::default())
        .manage(monitor::MonitorState::default())
        // Several GUI windows over one tmux session group, and the style each
        // window is in.
        .manage(windows::GuiWindows::default())
        .manage(WindowStyles::default())
        // The user's stylesheets — `/themes/<name>.css` and `/custom.css` —
        // from the config dir, as the web server serves them. The bundled
        // frontend only carries the built-in themes, so a theme the user made
        // was a 404 here and the page lost its colours.
        .register_uri_scheme_protocol("tmuxycss", |_ctx, request| {
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
        })
        // Pictures a pane drew (Kitty, iTerm2, Sixel) are decoded by the
        // monitor and kept in MonitorState; the webview fetches them through
        // this scheme. The web build serves the same bytes over
        // `/api/images/<pane>/<id>`, a route that does not exist here — the
        // frontend used to ask for it anyway and every image silently failed
        // to load, which is why no image protocol rendered on the desktop.
        .register_uri_scheme_protocol("tmuxyimg", |ctx, request| {
            let not_found = || {
                tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap_or_default()
            };
            // tmuxyimg://localhost/<pane digits>/<image id>
            let path = request.uri().path().to_string();
            match windows::lookup_image(ctx.app_handle(), &path) {
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
        })
        // Local files the browser widget shows (`tmuxy widget browser`) — an
        // HTML page, a markdown source, an image. The web build serves these
        // over `/api/browse/<path>`; there is no HTTP server here, so the same
        // path-shaped URLs arrive as `tmuxyfile://localhost/<path>` and are
        // read straight off disk. Path-shaped (rather than `?path=`) so a
        // framed page's relative links resolve to their neighbouring files.
        //
        // This reads anything the desktop app itself can read, which is the
        // same reach the pane's own shell already has.
        .register_uri_scheme_protocol("tmuxyfile", |_ctx, request| {
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
        })
        .setup(|app| {
            // The environment, for telling a Finder launch from a CLI one.
            let env = |key: &str| std::env::var(key).unwrap_or_else(|_| "(unset)".to_string());
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                pid = std::process::id(),
                path = %env("PATH"),
                home = %env("HOME"),
                shell = %env("SHELL"),
                term = %env("TERM"),
                tmux_socket = %env("TMUX_SOCKET"),
                tmuxy_session = %env("TMUXY_SESSION"),
                "tmuxy starting"
            );

            // Materialize the per-user config layout on first run:
            //   ~/.config/tmuxy/tmuxy.conf   — main tmux config (prefix bindings, etc.)
            //   ~/.config/tmuxy/themes/*.css — bundled themes mirrored to disk
            // The CC connection's `tmux -f <conf> -CC new-session -A` picks up
            // the tmuxy.conf for create paths; existing sessions keep their
            // running settings (an attach sources the conf via source-file in
            // sync_initial_state). Without this call the prefix never gets
            // re-bound to C-a, the status bar's prefix indicator looks wrong,
            // and prefix-key sequences silently no-op for new users.
            let config_path = tmuxy_core::session::ensure_config();
            let themes_dir = tmuxy_core::session::ensure_themes();
            // Mirror the bundled CLI dispatcher and helper scripts so the
            // in-config command-aliases (Ctrl+hjkl nav, pane groups, …) and
            // the `tmuxy <subcommand>` shell wrapper can reach them by an
            // absolute path even when launched from Finder/Spotlight.
            let bin_dir = tmuxy_core::session::ensure_bin_scripts();
            tracing::info!(
                config = %config_path.display(),
                themes = %themes_dir.display(),
                bin = %bin_dir.display(),
                "config layout"
            );

            // Patch the parent process PATH so any subprocess we spawn — including
            // executor::* paths that go through `sh -c "tmux ..."` — can resolve
            // tmux and the user's shell helpers. macOS launchd-spawned apps get
            // PATH=/usr/bin:/bin:/usr/sbin:/sbin (no Homebrew), which makes bare
            // `tmux` fail with "command not found" silently from inside the app.
            // Mirrors the per-child PATH augmentation in tmuxy_core::control_mode::connection.
            //
            // Done BEFORE the first async spawn / subprocess below so no other
            // task reads PATH concurrently with this write — `set_var` racing a
            // libc `getenv` on another thread is UB.
            #[cfg(target_os = "macos")]
            {
                // `~/.local/bin` holds the `tmuxy` shorthand the app writes on launch
                // (session::refresh_launcher); without it a pane's `tmuxy widget tree`
                // (the left sidebar) is "command not found" when launched from Finder.
                let local_bin = std::env::var("HOME")
                    .map(|h| format!("{h}/.local/bin"))
                    .unwrap_or_default();
                let extras: Vec<&str> =
                    ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
                        .into_iter()
                        .chain((!local_bin.is_empty()).then_some(local_bin.as_str()))
                        .collect();
                let current = std::env::var("PATH").unwrap_or_default();
                let missing: Vec<&str> = extras
                    .iter()
                    .copied()
                    .filter(|p| !current.split(':').any(|seg| seg == *p))
                    .collect();
                if !missing.is_empty() {
                    let prefixed = if current.is_empty() {
                        missing.join(":")
                    } else {
                        format!("{}:{}", missing.join(":"), current)
                    };
                    std::env::set_var("PATH", &prefixed);
                    tracing::info!(
                        prepended = %missing.join(":"),
                        "patched parent PATH for macOS Homebrew"
                    );
                }
            }

            // Refresh ~/.local/bin/tmuxy → this binary, async so a slow
            // disk doesn't delay the splash window. Best-effort: failures
            // are logged but don't block startup.
            if let Ok(exe) = std::env::current_exe() {
                tauri::async_runtime::spawn(async move {
                    tmuxy_core::session::refresh_launcher(&exe);
                });
            } else {
                tracing::warn!("current_exe() failed; tmuxy CLI shorthand not refreshed");
            }

            // Verify tmux is available — the monitor will create the session
            // itself via control mode (avoids race between sync creation and
            // async monitor connection where the session can die in between)
            let tmux_bin = session::tmux_path();
            let session_name = tmuxy_core::session::session_name();
            tracing::info!(tmux = %tmux_bin, session = %session_name, "tmux");

            // No tmux, or one too old, ends here in a dialog that says so and
            // how to fix it — before any window opens. An error returned from
            // setup instead aborts the process, and an app launched from
            // Finder just vanishes.
            match tmuxy_core::tmux_check::check_tmux() {
                Ok(version) => tracing::info!(%version, "tmux found"),
                Err(e) => {
                    tracing::error!(error = %e, "tmux check failed");
                    crate::startup_error::show(&e.to_string());
                    std::process::exit(1);
                }
            }

            // Create the main window programmatically so we can flip
            // transparent + Overlay titlebar based on TMUXY_OPAQUE_WINDOW.
            // tauri.conf.json's `windows: []` prevents auto-creation.
            //
            // Why: transparent windows need a compositor (Cocoa on macOS,
            // Mutter/Picom/etc. on Linux). Xvfb has none, so the WebView
            // paints onto a never-rendered surface and screenshots come
            // out monochrome. TMUXY_OPAQUE_WINDOW=1 lets tests in headless
            // CI/dev envs render visibly without changing prod defaults.
            let main_window = build_window(app.handle(), windows::MAIN_LABEL)?;

            // The menu bar is the page's: it sets it from the menu spec once it
            // is up (`components/menus/NativeMenuBar.tsx`).

            // Native blur and the platform hint.
            configure_window(&main_window);

            // Start control mode monitoring in background. The monitor
            // owns the live CC connection's command channel — handing the
            // shared MonitorState into the loop lets #[tauri::command]
            // handlers route mutations through that channel.
            let app_handle = app.handle().clone();
            let monitor_state = app.state::<monitor::MonitorState>().inner().clone();
            // The first window's registry entry: every tmux command resolves its
            // monitor through the registry, this one included.
            windows::register_main(app.handle(), monitor_state.clone());
            // Watch for `tmuxy connect` socket-switch requests. Shares the same
            // MonitorState so it can ask the monitor loop to reconnect.
            let connect_watch_state = monitor_state.clone();
            tauri::async_runtime::spawn(async move {
                monitor::poll_connect_requests(connect_watch_state).await;
            });
            // Watch the config dir for the user's edits: a saved stylesheet
            // is announced to the webviews, a saved tmuxy.conf is sourced.
            let config_watch_app = app.handle().clone();
            let config_watch_state = monitor_state.clone();
            tauri::async_runtime::spawn(async move {
                tmuxy_core::transport::watch_config(|change| {
                    let app = config_watch_app.clone();
                    let monitor = config_watch_state.clone();
                    tauri::async_runtime::spawn(async move {
                        monitor::apply_config_change(&app, &monitor, change).await;
                    });
                })
                .await;
            });
            tauri::async_runtime::spawn(async move {
                monitor::start_monitoring(app_handle, monitor_state).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Core commands
            commands::get_initial_state,
            commands::set_client_size,
            // Every tmux command and read the frontend makes
            commands::run_tmux_command,
            commands::query_tmux,
            commands::get_keybindings_snapshot,
            // Copy mode + themes (mirrors the SSE server's invoke surface so
            // the React frontend's INVOKE / FETCH_SCROLLBACK_CELLS paths work
            // identically under Tauri)
            commands::get_scrollback_cells,
            commands::get_theme_settings,
            commands::set_theme,
            commands::set_cursor_blink,
            commands::set_theme_mode,
            commands::set_swipe_tabs,
            commands::get_themes_list,
            // Window chrome: the status bar doubles as the title bar
            commands::set_titlebar_height,
            commands::titlebar_double_click,
            commands::open_url,
            // Server picker (desktop-only): list saved tmux servers and
            // live-reconnect to one (localhost socket switch or remote SSH).
            commands::list_servers,
            commands::list_snapshots,
            commands::restore_session,
            commands::connect_server,
            commands::add_server,
            commands::detach_client,
            // Several GUI windows over one tmux session group, and the iTerm2
            // window styles — the in-app Window menu's side of `windows.rs`
            // (the native macOS menu bar drives them directly).
            commands::new_window,
            commands::focus_window,
            commands::close_window,
            commands::quit_app,
            commands::reveal_log_file,
            commands::list_gui_windows,
            commands::set_window_style,
            commands::get_window_style,
            // Local action tracing (docs/TELEMETRY.md): the frontend tracer
            // queries `trace_enabled` and ships batches to `record_trace`.
            commands::trace_enabled,
            commands::restart_app,
            commands::record_trace,
            // Debug menu: read/flip the trace switch, level, and file.
            commands::get_trace_settings,
            commands::set_trace_enabled,
            commands::set_trace_level,
            commands::open_trace_file,
            // Read-only git context for the sidebar tree.
            commands::list_git_worktrees,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
