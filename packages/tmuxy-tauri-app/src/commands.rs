mod helpers;
pub mod window_size;

use serde_json::Value;
use tauri::{Manager, State};
use tmuxy_core::transport::{self, to_json};
use tmuxy_core::CommandError;

use crate::monitor::KeyBindingsState;
use crate::titlebar;
use crate::windows;

pub(crate) use helpers::is_openable_url;
use helpers::{open_path, query_via_monitor, resize_via_monitor, route_query, wait_for_monitor};

use tmuxy_core::session::session_name as get_session;

#[tauri::command]
pub async fn get_initial_state(
    window: tauri::WebviewWindow,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<Value, CommandError> {
    let state = windows::monitor_for(&window)?;
    // Resize if dimensions provided
    if let (Some(c), Some(r)) = (cols, rows) {
        resize_via_monitor(&state, c, r).await;

        // Cache the viewport size so the FIRST `new-window` after startup sizes
        // the broken-out window to match the viewport. Otherwise `last_client_size`
        // stays None until a later resize fires `set_client_size`, and a tab
        // created before that inherits the half-width post-`splitw` size or the
        // 200x50 control-mode PTY default — appearing too small until the user
        // resizes the OS window. The SSE server populates client sizes here too.
        if let Ok(mut cached) = state.last_client_size.write() {
            *cached = Some((c, r));
        }
    }

    // The monitor's own picture of the session — the same state its `Full`
    // broadcast carries, at the size just asked for. The monitor starts with
    // the app, before the webview can listen, so that broadcast is gone by
    // the time the frontend asks.
    let tx = wait_for_monitor(&state).await?;
    to_json(
        transport::initial_state_for_size(&tx, cols.zip(rows)).await?,
        "state",
    )
}

#[tauri::command]
pub async fn set_client_size(
    window: tauri::WebviewWindow,
    cols: u32,
    rows: u32,
) -> Result<(), CommandError> {
    let state = windows::monitor_for(&window)?;
    let (cols, rows) = tmuxy_core::client_size::clamp_client_size(cols, rows);
    // Cache the size so the next run_tmux_command("new-window") can size
    // the broken-out window to match the viewport. Without this the new
    // window inherits the half-width post-`splitw` size and looks tiny.
    if let Ok(mut size) = state.last_client_size.write() {
        *size = Some((cols, rows));
    }
    resize_via_monitor(&state, cols, rows).await;
    Ok(())
}

#[tauri::command]
pub async fn run_tmux_command(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    command: String,
) -> Result<(), CommandError> {
    let entry = windows::entry_for(&window)?;
    let session = entry.session();
    let state = entry.monitor;
    // Routed, written and — after a `source-file` — followed by fresh copies
    // of the settings it may have changed, as the web server does it.
    let tx = state.connected_tx()?;
    let size = state.last_client_size.read().ok().and_then(|g| *g);
    transport::run_client_command(&tx, &command, &session, size, || {
        crate::monitor::emit_config_settings(&app, &state)
    })
    .await
}

/// Run a tmux command and return what it printed — the one way the frontend
/// reads from tmux. Same connection as a mutation; only reads route
/// (`route_query`), a mutation goes through `run_tmux_command`. The reply is
/// the command's own output (`RunCommandWithReply`), and an `%error` from
/// tmux comes back as an error of kind `tmux`; a refused command as
/// `forbidden`.
#[tauri::command]
pub async fn query_tmux(
    window: tauri::WebviewWindow,
    command: String,
) -> Result<String, CommandError> {
    let entry = windows::entry_for(&window)?;
    let Some(routed) = route_query(&command) else {
        return Err(CommandError::forbidden("a query only reads"));
    };
    query_via_monitor(&entry.monitor, &routed).await
}

/// Fetch a range of scrollback cells for copy mode — the web server's
/// `get_scrollback_cells`, through this window's monitor.
#[tauri::command]
pub async fn get_scrollback_cells(
    window: tauri::WebviewWindow,
    pane_id: String,
    start: i64,
    end: i64,
) -> Result<Value, CommandError> {
    let pane_id = tmuxy_core::PaneId::parse(&pane_id)?;
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    transport::scrollback_cells(&tx, &pane_id, start, end).await
}

/// A `preview` pane's document or a resource it links — the web server's
/// `read_preview`, authorised by tmux through this window's monitor.
#[tauri::command]
pub async fn read_preview(
    window: tauri::WebviewWindow,
    pane_id: String,
    path: Option<String>,
) -> Result<Value, CommandError> {
    let pane_id = tmuxy_core::PaneId::parse(&pane_id)?;
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    tmuxy_core::preview::read_preview(&tx, &pane_id, path).await
}

/// Stage a `preview` pane's composed page for its frame, which loads it from
/// the `tmuxypreview:` scheme — the web server's `POST /api/preview/{pane}`.
#[tauri::command]
pub async fn stage_preview(
    window: tauri::WebviewWindow,
    pages: tauri::State<'_, tmuxy_core::preview::PreviewPages>,
    pane_id: String,
    html: String,
) -> Result<(), CommandError> {
    let pane_id = tmuxy_core::PaneId::parse(&pane_id)?;
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    tmuxy_core::preview::stage_page(&tx, &pages, pane_id, html).await
}

/// The theme name, mode and appearance, read over this window's monitor —
/// waiting for one that is still connecting, since the webview asks at start.
#[tauri::command]
pub async fn get_theme_settings(window: tauri::WebviewWindow) -> Result<Value, CommandError> {
    let tx = wait_for_monitor(&windows::monitor_for(&window)?).await?;
    tmuxy_core::theme::get_theme_settings(&tx).await
}

#[tauri::command]
pub async fn set_theme(
    window: tauri::WebviewWindow,
    name: String,
    mode: Option<String>,
) -> Result<(), CommandError> {
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    tmuxy_core::theme::set_theme(&tx, &name, mode.as_deref()).await
}

#[tauri::command]
pub async fn set_cursor_blink(
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), CommandError> {
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    tmuxy_core::theme::set_cursor_blink(&tx, enabled).await
}

#[tauri::command]
pub async fn set_send_ask(window: tauri::WebviewWindow, enabled: bool) -> Result<(), CommandError> {
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    tmuxy_core::theme::set_send_ask(&tx, enabled).await
}

/// `@tmuxy-transparency`, from View ▸ Enable Window Transparency (macOS).
/// The settings are pushed straight after, so every window repaints its
/// surfaces and its blur follows without waiting for a config reload.
#[tauri::command]
pub async fn set_transparency(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), CommandError> {
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    tmuxy_core::theme::set_transparency(&tx, enabled).await?;
    crate::monitor::emit_theme_settings(&app, &tx).await;
    Ok(())
}

/// `@tmuxy-gesture-swipe-tabs` as the page sees it (docs/DESKTOP.md): the
/// shell claims a two-finger slide only while this is on.
#[tauri::command]
pub fn set_swipe_tabs(enabled: bool) {
    crate::gestures::set_swipe_tabs(enabled);
}

#[tauri::command]
pub async fn set_theme_mode(
    window: tauri::WebviewWindow,
    mode: String,
) -> Result<(), CommandError> {
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    tmuxy_core::theme::set_theme_mode(&tx, &mode).await
}

#[tauri::command]
pub async fn get_themes_list() -> Result<Value, CommandError> {
    Ok(tmuxy_core::theme::get_themes_list())
}

/// Git worktree context for the sidebar tree, discovered from the cwd of
/// every pane on the socket (read through tmux, never supplied by the page).
#[tauri::command]
pub async fn list_git_worktrees(window: tauri::WebviewWindow) -> Result<Value, CommandError> {
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    transport::git_worktrees_json(&tx).await
}

/// The status bar is the window's title bar; it reports its rendered height
/// (logical px) so the native window buttons stay centred on it.
///
/// `action_id` is the client's trace correlation id (docs/TRACING.md).
#[tauri::command]
pub fn set_titlebar_height(window: tauri::WebviewWindow, height: f64, action_id: Option<String>) {
    titlebar::set_height(&window, height, action_id.as_deref());
}

/// Double-click on the status bar's empty space — the native title-bar gesture.
#[tauri::command]
pub fn titlebar_double_click(
    window: tauri::WebviewWindow,
    action_id: Option<String>,
) -> Result<(), CommandError> {
    titlebar::double_click(&window, action_id.as_deref())
        .map_err(|e| CommandError::unavailable(e.to_string()))
}

/// Return the most recent `tmux-keybindings` payload, or null if the monitor
/// hasn't broadcast one yet. The frontend calls this on connect to recover
/// from the race where the backend emits before the WebView's listener is
/// attached.
#[tauri::command]
pub fn get_keybindings_snapshot(
    state: State<'_, KeyBindingsState>,
) -> Option<transport::KeyBindings> {
    state.0.read().ok().and_then(|guard| guard.clone())
}

/// List the saved servers (localhost plus any added via `tmuxy connect`), read
/// fresh from `~/.config/tmuxy/servers.json`, along with the id of the server
/// the app is currently attached to. Powers the sidebar server picker — a
/// desktop-only surface; the web build always uses its launch socket.
#[tauri::command]
pub async fn list_servers() -> Result<Value, CommandError> {
    let servers = tmuxy_core::servers::read_servers();
    let current = tmuxy_core::servers::current_server_id();
    Ok(serde_json::json!({
        "servers": servers,
        "currentId": current,
    }))
}

/// The sessions that have a snapshot to be rebuilt from (`session_snapshot`).
#[tauri::command]
pub async fn list_snapshots() -> Result<Value, CommandError> {
    transport::list_snapshots_json().await
}

/// Rebuild a session from its latest snapshot through this window's
/// control-mode client, the way the web server does. Refused when the session
/// is already running.
#[tauri::command]
pub async fn restore_session(
    window: tauri::WebviewWindow,
    session: String,
) -> Result<(), CommandError> {
    let tx = windows::monitor_for(&window)?.connected_tx()?;
    transport::restore_named(&session, &tx).await
}

/// Reconnect the desktop app to a saved server by id: resolve it from
/// servers.json and ask the monitor to retarget its socket, SSH tunnel, and
/// session live (no relaunch). Routes through the same [`request_reconnect`]
/// path as `tmuxy connect <socket>`.
///
/// [`request_reconnect`]: crate::monitor::request_reconnect
#[tauri::command]
pub async fn connect_server(
    window: tauri::WebviewWindow,
    id: String,
    session: Option<String>,
) -> Result<(), CommandError> {
    let state = windows::monitor_for(&window)?;
    let server = tmuxy_core::servers::find_server(&id)
        .ok_or_else(|| CommandError::invalid(format!("unknown server '{id}'")))?;
    let (socket, ssh) = server.connect_env();
    let session = session
        .or_else(|| server.session.clone())
        .unwrap_or_else(get_session);
    if !tmuxy_core::session::is_safe_session_name(&session) {
        return Err(CommandError::invalid(format!(
            "'{session}' is not a session name"
        )));
    }
    let _ = tmuxy_core::servers::touch_server(&id, Some(&session));
    crate::monitor::request_reconnect(
        &state,
        crate::monitor::ConnectTarget {
            socket,
            session,
            ssh,
        },
    )
    .await;
    Ok(())
}

/// Detach this client, leaving the tmux server and every session running.
///
/// Not a plain `detach-client`: the monitor has to be told this was deliberate
/// or its loop treats the ended connection as a flap and reattaches, dropping
/// the user back into the session they just left.
#[tauri::command]
pub async fn detach_client(window: tauri::WebviewWindow) -> Result<(), CommandError> {
    let state = windows::monitor_for(&window)?;
    crate::monitor::request_detach(&state).await;
    Ok(())
}

/// Open another GUI window on the same tmux session group (Window ▸ New Window).
///
/// The new window is a second, independent client: it shares every tab and pane
/// with this one but keeps its own current tab, so two tabs of one session can be
/// on screen at once. See `windows.rs`.
#[tauri::command]
pub fn new_window(app: tauri::AppHandle) -> Result<(), CommandError> {
    crate::windows::open(&app)
        .map(|_| ())
        .map_err(CommandError::unavailable)
}

/// Bring the GUI window at `index` to the front (Window ▸ the window list, and
/// the Cmd/Ctrl+Shift+digit shortcuts).
#[tauri::command]
pub fn focus_window(app: tauri::AppHandle, index: usize) {
    crate::windows::focus_index(&app, index);
}

/// Close this OS window (Window ▸ Close Window).
#[tauri::command]
pub fn close_window(window: tauri::WebviewWindow) -> Result<(), CommandError> {
    window
        .close()
        .map_err(|e| CommandError::unavailable(e.to_string()))
}

/// Leave the app (Quit, where the menu is the app's own rather than the
/// platform's). tmux keeps every session.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0)
}

/// Every open GUI window, in Window-menu order, for the in-app menu to list —
/// the native menu bar builds its own from the same registry.
#[tauri::command]
pub fn list_gui_windows(app: tauri::AppHandle) -> Vec<Value> {
    let focused = windows::focused_label(&app);
    windows::list(&app)
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "index": entry.index,
                "title": entry.title,
                "focused": entry.label == focused,
            })
        })
        .collect()
}

/// Put this window into one of the iTerm2 window styles, by its menu slug
/// (`full-width-top`, `no-title-bar`, …). Unknown slugs are refused rather than
/// silently ignored, so a typo in the UI shows up as a snackbar.
#[tauri::command]
pub fn set_window_style(window: tauri::WebviewWindow, style: String) -> Result<(), CommandError> {
    let style = crate::window_style::WindowStyle::from_slug(&style)
        .ok_or_else(|| CommandError::invalid(format!("unknown window style '{style}'")))?;
    crate::window_style::apply(&window, style)
        .map_err(|e| CommandError::unavailable(e.to_string()))?;
    Ok(())
}

/// The style this window is in, as its slug — what the in-app menu ticks.
#[tauri::command]
pub fn get_window_style(window: tauri::WebviewWindow) -> String {
    crate::window_style::slug_of(
        window
            .state::<crate::window_style::WindowStyles>()
            .of(window.label()),
    )
}

/// Relaunch the desktop app in place (Debug ▸ Restart App). tmux keeps every
/// session; the new process reattaches to the same socket on start.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart()
}

/// Whether local action tracing is active on this desktop backend
/// (docs/TRACING.md). The frontend tracer ships events only when this is true.
#[tauri::command]
pub fn trace_enabled() -> bool {
    tmuxy_core::trace::is_enabled()
}

/// The machine's host name, for the status line's host label
/// (`tmuxy_server::host_name`): the desktop app runs the server in-process,
/// so there is no greeting to carry it.
#[tauri::command]
pub fn host_name() -> String {
    tmuxy_server::host_name()
}

/// Everything the Debug menu needs to render itself
/// (`transport::trace_settings_json`).
#[tauri::command]
pub fn get_trace_settings() -> Value {
    transport::trace_settings_json()
}

/// Turn tracing on or off and remember the choice. Returns the state actually
/// in force, which is `false` for an `enabled: true` request that the kill
/// switch refuses — the caller renders the answer, never its own request.
#[tauri::command]
pub fn set_trace_enabled(enabled: bool) -> bool {
    tmuxy_core::trace::set_enabled(enabled)
}

/// Set the level (`shape` | `labeled` | `full`) and remember it; the level in
/// force.
#[tauri::command]
pub fn set_trace_level(level: String) -> String {
    transport::set_trace_level(&level).to_string()
}

/// Open the trace file in the OS default handler. Desktop-only by nature: the
/// file lives on the machine running the backend.
#[tauri::command]
pub fn open_trace_file() -> Result<(), CommandError> {
    let path = tmuxy_core::trace::trace_path()
        .ok_or_else(|| CommandError::unavailable("no trace file path could be resolved"))?;
    if !path.exists() {
        return Err(CommandError::unavailable(format!(
            "{} does not exist yet",
            path.display()
        )));
    }
    open_path(&path)
}

/// Open a web link in the user's default browser.
///
/// The desktop webview never opens `target="_blank"` anchors on its own (a
/// new-window request is denied), so a click on an OSC 8 or auto-detected link
/// in a pane used to do nothing on the desktop. The frontend routes link clicks
/// here instead. Only web schemes are accepted: a pane can print any text, so
/// `file:` and custom schemes stay out.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), CommandError> {
    let url = url.trim();
    if !is_openable_url(url) {
        return Err(CommandError::forbidden(format!(
            "refusing to open {url:?}: only http(s) and mailto links"
        )));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    // Not `cmd /C start`: cmd.exe parses `&`, `|` and `%VAR%` in its
    // arguments, and a link's query string is full of `&`.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    cmd.arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| CommandError::unavailable(format!("could not open {url}: {e}")))
}

/// Ingest a batch of client trace events into the shared NDJSON file. **Fails
/// closed**: dropped entirely when tracing is off, regardless of what the
/// frontend believes. Every event is re-sanitized by `record_client_event`
/// before it reaches the file, so no terminal content can slip through.
#[tauri::command]
pub fn record_trace(events: Vec<serde_json::Map<String, Value>>) {
    if !tmuxy_core::trace::is_enabled() {
        return;
    }
    for obj in events.into_iter().take(1000) {
        tmuxy_core::trace::record_client_event(obj);
    }
}
