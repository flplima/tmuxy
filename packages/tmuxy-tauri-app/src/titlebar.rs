//! Desktop window chrome for the status bar, which doubles as the window's
//! title bar.
//!
//! On macOS the main window is built with `TitleBarStyle::Overlay`: the
//! native title bar is transparent and the webview paints underneath it, so
//! the web status bar is what the user sees as the title bar. Its height
//! scales with `--tmuxy-font-size`, and the native traffic-light buttons must
//! stay vertically centred on it. tao's `traffic_light_position` is a
//! build-time inset that it re-applies on every redraw, and tauri exposes no
//! runtime setter, so the buttons are positioned here from the height the
//! frontend reports (`set_titlebar_height`) and re-applied whenever AppKit
//! re-lays-out the title bar (resize, focus, backing-scale change).
//!
//! The title-bar double-click gesture is routed here too (`double_click`):
//! the webview receives the click before AppKit's title bar can, so the
//! frontend forwards it and the user's macOS "Double-click a window's title
//! bar to" setting (`AppleActionOnDoubleClick`) is honoured.
//!
//! Every action is traced (docs/TELEMETRY.md) with the client's `action_id`
//! and content-free geometry, so `tmuxy trace` shows the invoke joined to its
//! native outcome. Events name their target explicitly: this crate's bin target
//! is `tmuxy`, so `module_path!()` would fall outside the trace allowlist.

use tauri::WebviewWindow;

const TRACE_TARGET: &str = "tmuxy_tauri_app::titlebar";

/// Frontend's initial `--statusbar-height` (15px font × 2.4), used until the
/// status bar reports its rendered height.
#[cfg(target_os = "macos")]
const DEFAULT_HEIGHT: f64 = 36.0;

/// Left edge of the close button; the frontend's `.traffic-light-spacer`
/// reserves the matching room.
#[cfg(target_os = "macos")]
const LEFT_INSET: f64 = 16.0;

/// Most recent status-bar height (logical px) reported by the frontend.
#[cfg(target_os = "macos")]
pub struct TitlebarState {
    height: std::sync::Mutex<f64>,
}

#[cfg(target_os = "macos")]
impl Default for TitlebarState {
    fn default() -> Self {
        Self {
            height: std::sync::Mutex::new(DEFAULT_HEIGHT),
        }
    }
}

/// Centre the traffic lights on the status bar now and keep them centred
/// across AppKit title-bar re-layouts.
#[cfg(target_os = "macos")]
pub fn install(window: &WebviewWindow) {
    use tauri::WindowEvent;

    let target = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_)
                | WindowEvent::Focused(true)
                | WindowEvent::ScaleFactorChanged { .. }
        ) {
            apply(&target, None);
        }
    });
    apply(window, None);
}

/// Record the status bar's rendered height and re-centre the traffic lights.
#[cfg(target_os = "macos")]
pub fn set_height(window: &WebviewWindow, height: f64, action_id: Option<&str>) {
    use tauri::Manager;

    if let Some(state) = window.try_state::<TitlebarState>() {
        *state.height.lock().unwrap() = height;
    }
    apply(window, action_id);
}

/// Only macOS draws native window buttons over the status bar; elsewhere the
/// bar owns its whole height and there is nothing to align.
#[cfg(not(target_os = "macos"))]
pub fn install(_window: &WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
pub fn set_height(_window: &WebviewWindow, _height: f64, _action_id: Option<&str>) {}

/// Title-bar double-click: honour the macOS "Double-click a window's title
/// bar to" setting; other platforms toggle maximize like their native title bar.
pub fn double_click(window: &WebviewWindow, action_id: Option<&str>) -> tauri::Result<()> {
    let action = double_click_action();
    let (kind, outcome) = match action.as_deref() {
        Some("Minimize") => {
            window.minimize()?;
            ("minimize", "minimized")
        }
        Some("None") => ("none", "unchanged"),
        _ => {
            if window.is_maximized()? {
                window.unmaximize()?;
                ("zoom", "restored")
            } else {
                window.maximize()?;
                ("zoom", "maximized")
            }
        }
    };
    match action_id {
        Some(action_id) => {
            tracing::debug!(target: TRACE_TARGET, kind, variant = outcome, action_id, "titlebar double-click")
        }
        None => {
            tracing::debug!(target: TRACE_TARGET, kind, variant = outcome, "titlebar double-click")
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn double_click_action() -> Option<String> {
    use objc2_foundation::{NSString, NSUserDefaults};

    NSUserDefaults::standardUserDefaults()
        .stringForKey(&NSString::from_str("AppleActionOnDoubleClick"))
        .map(|action| action.to_string())
}

#[cfg(not(target_os = "macos"))]
fn double_click_action() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn apply(window: &WebviewWindow, action_id: Option<&str>) {
    use tauri::Manager;

    let height = window
        .try_state::<TitlebarState>()
        .map(|state| *state.height.lock().unwrap())
        .unwrap_or(DEFAULT_HEIGHT);
    let target = window.clone();
    // Only the action-driven applies are traced; the re-applies AppKit's
    // re-layouts trigger (dozens per zoom animation) would just repeat them.
    let action_id = action_id.map(str::to_string);
    let _ = window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        let Some(y) = center_traffic_lights(ns_window, height) else {
            return;
        };
        if let Some(action_id) = action_id {
            tracing::debug!(target: TRACE_TARGET, height, y, action_id, "traffic lights centred");
        }
    });
}

/// Grow the native title-bar container to the status bar's height and place
/// the three window buttons on its vertical midline, `LEFT_INSET` from the
/// left edge with AppKit's own spacing between them. Main thread only.
/// Returns the buttons' centre line, in logical px from the window's top.
#[cfg(target_os = "macos")]
fn center_traffic_lights(ns_window: *mut std::ffi::c_void, bar_height: f64) -> Option<f64> {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use objc2_foundation::NSPoint;

    // SAFETY: `ns_window` is the live NSWindow behind a tauri WebviewWindow and
    // this runs on the main thread (`run_on_main_thread`).
    let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
    let [Some(close), Some(miniaturize), Some(zoom)] = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|kind| window.standardWindowButton(kind)) else {
        return None;
    };
    // SAFETY: superview() is only unsafe because the returned view is not
    // tied to the button's lifetime; both are owned by the window for as
    // long as this function runs.
    let container =
        (unsafe { close.superview() }).and_then(|titlebar| unsafe { titlebar.superview() })?;

    let button_height = close.frame().size.height;
    let bar_height = bar_height.max(button_height);
    let mut container_frame = container.frame();
    container_frame.origin.y = window.frame().size.height - bar_height;
    container_frame.size.height = bar_height;
    container.setFrame(container_frame);

    let spacing = miniaturize.frame().origin.x - close.frame().origin.x;
    let y = (bar_height - button_height) / 2.0;
    for (i, button) in [close, miniaturize, zoom].iter().enumerate() {
        button.setFrameOrigin(NSPoint::new(LEFT_INSET + i as f64 * spacing, y));
    }
    Some(bar_height / 2.0)
}
