mod window_setup;

use tauri::Manager;
use tmuxy_core::session;

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
            window_setup::handle_tmuxycss(request)
        })
        // Pictures a pane drew (Kitty, iTerm2, Sixel) are decoded by the
        // monitor and kept in MonitorState; the webview fetches them through
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
        .manage(tmuxy_core::preview::PreviewPages::default())
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
            // The `preview` widget's document, resources and framed page
            commands::read_preview,
            commands::stage_preview,
            commands::get_theme_settings,
            commands::set_theme,
            commands::set_cursor_blink,
            commands::set_send_ask,
            commands::set_transparency,
            commands::set_theme_mode,
            commands::set_swipe_tabs,
            commands::get_themes_list,
            // Window chrome: the status bar doubles as the title bar
            commands::set_titlebar_height,
            commands::titlebar_double_click,
            commands::window_size::grow_window,
            commands::open_url,
            // Server picker (desktop-only): list saved tmux servers and
            // live-reconnect to one (localhost socket switch or remote SSH).
            commands::list_servers,
            commands::list_snapshots,
            commands::restore_session,
            commands::connect_server,
            commands::detach_client,
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
            // Local action tracing (docs/TRACING.md): the frontend tracer
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
        .run(tauri::generate_context!());
    if let Err(e) = run {
        tracing::error!(error = %e, "the tauri application failed to run");
        eprintln!("error while running tauri application: {e}");
        std::process::exit(1);
    }
}
