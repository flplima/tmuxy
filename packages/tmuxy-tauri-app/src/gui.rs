mod window_setup;

use tauri::Manager;

use crate::commands;
use crate::monitor;
#[cfg(target_os = "macos")]
use crate::titlebar;
use crate::window_style::WindowStyles;
use crate::windows;

pub(crate) use window_setup::{apply_blur, build_window, configure_window};

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

    let run = builder
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
        // Several GUI windows over one tmux session group, and the style each
        // window is in.
        .manage(windows::GuiWindows::default())
        .manage(WindowStyles::default())
        // The user's stylesheets — `/themes/<name>.css` and `/custom.css` —
        // from the config dir, as the web server serves them. The bundled
        // frontend only carries the built-in themes, so a theme the user made
        // was a 404 here and the page lost its colours.
        .register_uri_scheme_protocol("tmuxycss", |_ctx, request| {
            window_setup::handle_tmuxycss(request)
        })
        // Pictures a pane drew (Kitty, iTerm2, Sixel) are decoded by the
        // monitor and kept in its runtime; the webview fetches them through
        // this scheme. The web build serves the same bytes over
        // `/api/images/<pane>/<id>`, a route that does not exist here — the
        // frontend used to ask for it anyway and every image silently failed
        // to load, which is why no image protocol rendered on the desktop.
        .register_uri_scheme_protocol("tmuxyimg", |ctx, request| {
            window_setup::handle_tmuxyimg(ctx.app_handle(), request)
        })
        // A `preview` pane's composed page, staged by `stage_preview` and
        // loaded by the pane's frame, served under the page's own policy —
        // the web server's `GET /api/preview/{pane}`.
        .manage(std::sync::Arc::new(
            tmuxy_core::preview::PreviewPages::default(),
        ))
        .register_uri_scheme_protocol("tmuxypreview", |ctx, request| {
            window_setup::handle_tmuxypreview(ctx.app_handle(), request)
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

            // PATH, tmux, the config dirs and the scripts
            // (`tmuxy_core::host::prepare`). No tmux, or one too old, ends
            // here in a dialog that says so and how to fix it — before any
            // window opens. An error returned from setup instead aborts the
            // process, and an app launched from Finder just vanishes.
            if let Err(e) = tmuxy_core::host::prepare::prepare() {
                tracing::error!(error = %e, "tmux check failed");
                crate::startup_error::show(&e.to_string());
                std::process::exit(1);
            }

            // Refresh ~/.local/bin/tmuxy → this binary, async so a slow
            // disk doesn't delay the splash window. Best-effort: failures
            // are logged but don't block startup.
            if let Some(exe) = tmuxy_core::session::invoked_exe() {
                tauri::async_runtime::spawn(async move {
                    tmuxy_core::session::refresh_launcher(&exe);
                });
            } else {
                tracing::warn!("invoked_exe() failed; tmuxy CLI shorthand not refreshed");
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

            // The first window's monitor, on the base session; every tmux
            // command resolves its monitor through the window registry.
            windows::open_main(app.handle());
            // Watch for `tmuxy connect` socket-switch requests.
            tauri::async_runtime::spawn(monitor::poll_connect_requests(app.handle().clone()));
            // Every pane on the socket, read for the agent-dialog correction
            // (`host::socket_watch`).
            let (panes, _) = tmuxy_core::host::socket_watch::channel();
            tauri::async_runtime::spawn(tmuxy_core::host::socket_watch::run(panes));
            // Watch the config dir for the user's edits: a saved stylesheet
            // is announced to the webviews, a saved tmuxy.conf is sourced.
            let config_watch_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tmuxy_core::transport::watch_config(|change| {
                    let app = config_watch_app.clone();
                    tauri::async_runtime::spawn(async move {
                        for window in windows::list_all(&app) {
                            window.monitor.runtime.config_changed(change).await;
                        }
                    });
                })
                .await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Every client command, for the window it came from — the same
            // `{ cmd, args }` the web build POSTs to `/commands`.
            commands::dispatch,
            // Window chrome: the status bar doubles as the title bar
            commands::set_titlebar_height,
            commands::titlebar_double_click,
            commands::window_size::grow_window,
            // Several GUI windows over one tmux session group, and the iTerm2
            // window styles — the in-app Window menu's side of `windows.rs`
            // (the native macOS menu bar drives them directly).
            commands::new_window,
            commands::focus_window,
            commands::close_window,
            commands::quit_app,
            commands::list_gui_windows,
            commands::set_window_style,
            commands::get_window_style,
            commands::restart_app,
        ])
        .build(tauri::generate_context!());
    let app = match run {
        Ok(app) => app,
        Err(e) => {
            tracing::error!(error = %e, "the tauri application failed to run");
            eprintln!("error while running tauri application: {e}");
            std::process::exit(1);
        }
    };
    // Quitting, from any menu: the last snapshot of every window's session
    // first (`monitor::save_snapshots`), then the exit asked for.
    let saved = std::sync::atomic::AtomicBool::new(false);
    app.run(move |handle, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            if saved.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                monitor::save_snapshots(&handle).await;
                handle.exit(code.unwrap_or(0));
            });
        }
    });
}
