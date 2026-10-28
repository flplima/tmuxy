//! Sizing the OS window around a grid `@tmuxy-size` fixes.

use tmuxy_core::CommandError;

/// The narrowest a sidebar may leave the window, in logical px.
const MIN_WINDOW_WIDTH: f64 = 320.0;

/// Widen the window by `dx` logical px (narrow it, for a negative one): a
/// sidebar opening beside a grid `@tmuxy-size` fixes gets its column from the
/// screen, and the pane area keeps its size. A maximized or fullscreen window
/// is left as it is, and one grows no further than its screen's work area —
/// the grid is scaled to whatever room that leaves. Returns how far the width
/// actually changed, which is what closing the column takes back.
#[tauri::command]
pub fn grow_window(
    window: tauri::WebviewWindow,
    dx: f64,
    action_id: Option<String>,
) -> Result<f64, CommandError> {
    let fail = |e: tauri::Error| CommandError::unavailable(e.to_string());
    if window.is_maximized().map_err(fail)? || window.is_fullscreen().map_err(fail)? {
        return Ok(0.0);
    }
    let scale = window.scale_factor().map_err(fail)?;
    let inner = window.inner_size().map_err(fail)?.to_logical::<f64>(scale);
    let mut width = (inner.width + dx).max(MIN_WINDOW_WIDTH);
    // Where the screen ends right of the window. Not every platform reports
    // a window's position (Wayland does not); there the width is unclamped.
    let room = window
        .current_monitor()
        .ok()
        .flatten()
        .zip(window.outer_position().ok())
        .zip(window.outer_size().ok());
    if let Some(((monitor, position), outer)) = room {
        let area = monitor.work_area();
        let screen_right = (area.position.x as f64 + area.size.width as f64) / scale;
        let frame = outer.to_logical::<f64>(scale).width - inner.width;
        let left = position.to_logical::<f64>(scale).x;
        width = width.min((screen_right - left - frame).max(inner.width));
    }
    let applied = width - inner.width;
    tracing::debug!(dx, applied, ?action_id, "grow window");
    if applied != 0.0 {
        window
            .set_size(tauri::LogicalSize::new(width, inner.height))
            .map_err(fail)?;
    }
    Ok(applied)
}
