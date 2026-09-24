//! Window styles, as iTerm2 spells them.
//!
//! A style is a shape for the OS window: normal, full screen, maximized, no
//! title bar, or docked against an edge of the screen. The docked ones are what
//! make a terminal usable as a strip along the top of a display — the reason
//! iTerm2 has them — and they are computed from the monitor's *work area*, so a
//! full-height window stops at the menu bar and the dock rather than sliding
//! under them.
//!
//! The style a window is in is remembered per window (`WindowStyles`), along
//! with the frame it had while it was Normal: leaving Normal is a one-way trip
//! for the geometry, so `Normal` puts back what the user had rather than
//! inventing a size. Nothing here is persisted across launches — the
//! window-state plugin owns that, and it stores a frame, not a style.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// The twelve styles iTerm2 offers, in its own menu order.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum WindowStyle {
    #[default]
    Normal,
    FullScreen,
    Maximized,
    NoTitleBar,
    FullWidthTop,
    FullWidthBottom,
    FullHeightLeft,
    FullHeightRight,
    Top,
    Bottom,
    Left,
    Right,
}

/// Every style, in menu order.
pub const ALL: [WindowStyle; 12] = [
    WindowStyle::Normal,
    WindowStyle::FullScreen,
    WindowStyle::Maximized,
    WindowStyle::NoTitleBar,
    WindowStyle::FullWidthTop,
    WindowStyle::FullWidthBottom,
    WindowStyle::FullHeightLeft,
    WindowStyle::FullHeightRight,
    WindowStyle::Top,
    WindowStyle::Bottom,
    WindowStyle::Left,
    WindowStyle::Right,
];

/// Prefix every style's menu id carries.
const ID_PREFIX: &str = "window-style-";

impl WindowStyle {
    /// Menu item id — `window-style-full-width-top`.
    pub fn id(self) -> String {
        format!("{ID_PREFIX}{}", self.slug())
    }

    /// The style a menu id names, or `None` for an id that is not a style.
    pub fn from_id(id: &str) -> Option<Self> {
        let slug = id.strip_prefix(ID_PREFIX)?;
        ALL.into_iter().find(|style| style.slug() == slug)
    }

    /// The style's slug — its menu id without the prefix, and the value the
    /// frontend's Window menu exchanges.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::FullScreen => "full-screen",
            Self::Maximized => "maximized",
            Self::NoTitleBar => "no-title-bar",
            Self::FullWidthTop => "full-width-top",
            Self::FullWidthBottom => "full-width-bottom",
            Self::FullHeightLeft => "full-height-left",
            Self::FullHeightRight => "full-height-right",
            Self::Top => "top",
            Self::Bottom => "bottom",
            Self::Left => "left",
            Self::Right => "right",
        }
    }

    /// Menu label, verbatim from iTerm2.
    pub fn label(self) -> &'static str {
        match self {
            Self::Normal => "Normal",
            Self::FullScreen => "Full Screen",
            Self::Maximized => "Maximized",
            Self::NoTitleBar => "No Title Bar",
            Self::FullWidthTop => "Full-Width Top of Screen",
            Self::FullWidthBottom => "Full-Width Bottom of Screen",
            Self::FullHeightLeft => "Full-Height Left of Screen",
            Self::FullHeightRight => "Full-Height Right of Screen",
            Self::Top => "Top of Screen",
            Self::Bottom => "Bottom of Screen",
            Self::Left => "Left of Screen",
            Self::Right => "Right of Screen",
        }
    }
}

/// The slug naming a style, for the frontend's Window menu.
pub fn slug_of(style: WindowStyle) -> String {
    style.slug().to_string()
}

/// A window's frame, as the platform counts pixels.
type Frame = (PhysicalPosition<i32>, PhysicalSize<u32>);

#[derive(Default)]
struct StyleRecord {
    style: WindowStyle,
    /// The frame the window had while it was Normal, restored when it returns.
    normal: Option<Frame>,
}

/// The style each window is in. Tauri-managed state.
#[derive(Clone, Default)]
pub struct WindowStyles(Arc<RwLock<HashMap<String, StyleRecord>>>);

impl WindowStyles {
    /// The style a window is in — `Normal` for one nobody has restyled.
    pub fn of(&self, label: &str) -> WindowStyle {
        self.0
            .read()
            .ok()
            .and_then(|g| g.get(label).map(|r| r.style))
            .unwrap_or_default()
    }
}

/// Put a window into a style, remembering the frame it had while Normal.
pub fn apply(window: &WebviewWindow, style: WindowStyle) -> tauri::Result<()> {
    let styles = window.state::<WindowStyles>().inner().clone();
    let label = window.label().to_string();

    // Capture the Normal frame on the way out of Normal, once: a second style
    // change must not record the docked frame as the one to restore.
    let frame = current_frame(window);
    let remembered = match styles.0.write() {
        Ok(mut guard) => {
            let record = guard.entry(label.clone()).or_default();
            if record.style == WindowStyle::Normal && record.normal.is_none() {
                record.normal = frame;
            }
            let remembered = record.normal;
            record.style = style;
            remembered
        }
        Err(_) => None,
    };

    // A style is a whole shape, so every one of them starts from a plain
    // window: leaving full screen or a maximized frame first, and giving the
    // title bar back unless the style is the one that takes it away.
    window.set_fullscreen(false)?;
    if window.is_maximized()? {
        window.unmaximize()?;
    }
    window.set_decorations(style != WindowStyle::NoTitleBar)?;

    match style {
        WindowStyle::Normal => {
            if let Some((position, size)) = remembered {
                window.set_position(position)?;
                window.set_size(size)?;
            }
            if let Ok(mut guard) = styles.0.write() {
                if let Some(record) = guard.get_mut(&label) {
                    record.normal = None;
                }
            }
        }
        WindowStyle::FullScreen => window.set_fullscreen(true)?,
        WindowStyle::Maximized => window.maximize()?,
        // The title bar is the only thing this one changes; `set_decorations`
        // above has already done it.
        WindowStyle::NoTitleBar => {}
        docked => {
            if let Some((position, size)) = docked_frame(window, docked)? {
                window.set_size(size)?;
                window.set_position(position)?;
            }
        }
    }
    Ok(())
}

fn current_frame(window: &WebviewWindow) -> Option<Frame> {
    Some((window.outer_position().ok()?, window.outer_size().ok()?))
}

/// Where a docked style puts the window, within the monitor's work area.
///
/// `None` when the platform cannot say which monitor the window is on, which is
/// the one case where guessing a frame would throw the window across displays.
fn docked_frame(window: &WebviewWindow, style: WindowStyle) -> tauri::Result<Option<Frame>> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(None);
    };
    let area = monitor.work_area();
    let size = window.outer_size()?;
    Ok(Some(dock(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        (size.width, size.height),
        style,
    )))
}

/// The frame arithmetic, free of any window: work-area origin and size, the
/// window's current size, and the style it is being docked to.
///
/// The full-width and full-height styles stretch along their edge and keep the
/// window's other dimension; the four plain edge styles keep both dimensions and
/// centre along the edge, which is how a window "on" an edge stays the size the
/// user gave it.
fn dock(
    (area_x, area_y): (i32, i32),
    (area_w, area_h): (u32, u32),
    (win_w, win_h): (u32, u32),
    style: WindowStyle,
) -> Frame {
    let far_x = |w: u32| area_x + (area_w.saturating_sub(w)) as i32;
    let far_y = |h: u32| area_y + (area_h.saturating_sub(h)) as i32;
    let mid_x = |w: u32| area_x + (area_w.saturating_sub(w) / 2) as i32;
    let mid_y = |h: u32| area_y + (area_h.saturating_sub(h) / 2) as i32;

    let (x, y, w, h) = match style {
        WindowStyle::FullWidthTop => (area_x, area_y, area_w, win_h),
        WindowStyle::FullWidthBottom => (area_x, far_y(win_h), area_w, win_h),
        WindowStyle::FullHeightLeft => (area_x, area_y, win_w, area_h),
        WindowStyle::FullHeightRight => (far_x(win_w), area_y, win_w, area_h),
        WindowStyle::Top => (mid_x(win_w), area_y, win_w, win_h),
        WindowStyle::Bottom => (mid_x(win_w), far_y(win_h), win_w, win_h),
        WindowStyle::Left => (area_x, mid_y(win_h), win_w, win_h),
        WindowStyle::Right => (far_x(win_w), mid_y(win_h), win_w, win_h),
        // Not docked styles; the caller handles these.
        _ => (area_x, area_y, win_w, win_h),
    };
    (PhysicalPosition::new(x, y), PhysicalSize::new(w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A work area inset like a Mac's: menu bar on top, dock at the bottom.
    const AREA_POS: (i32, i32) = (100, 25);
    const AREA_SIZE: (u32, u32) = (1000, 500);
    const WINDOW: (u32, u32) = (400, 200);

    fn frame(style: WindowStyle) -> (i32, i32, u32, u32) {
        let (p, s) = dock(AREA_POS, AREA_SIZE, WINDOW, style);
        (p.x, p.y, s.width, s.height)
    }

    #[test]
    fn a_full_width_style_spans_the_work_area_and_keeps_its_height() {
        assert_eq!(frame(WindowStyle::FullWidthTop), (100, 25, 1000, 200));
        // Bottom-aligned: the far edge of the work area, not of the screen —
        // a window under the dock is a window the user cannot reach.
        assert_eq!(frame(WindowStyle::FullWidthBottom), (100, 325, 1000, 200));
    }

    #[test]
    fn a_full_height_style_spans_the_work_area_and_keeps_its_width() {
        assert_eq!(frame(WindowStyle::FullHeightLeft), (100, 25, 400, 500));
        assert_eq!(frame(WindowStyle::FullHeightRight), (700, 25, 400, 500));
    }

    #[test]
    fn a_plain_edge_style_keeps_the_size_and_centres_along_the_edge() {
        assert_eq!(frame(WindowStyle::Top), (400, 25, 400, 200));
        assert_eq!(frame(WindowStyle::Bottom), (400, 325, 400, 200));
        assert_eq!(frame(WindowStyle::Left), (100, 175, 400, 200));
        assert_eq!(frame(WindowStyle::Right), (700, 175, 400, 200));
    }

    #[test]
    fn a_window_larger_than_the_screen_is_pinned_to_the_near_edge() {
        // saturating_sub, not a negative offset: a window wider than the work
        // area would otherwise be placed off the left of the display.
        let (p, _) = dock(AREA_POS, (300, 100), WINDOW, WindowStyle::Right);
        assert_eq!((p.x, p.y), (100, 25));
    }

    #[test]
    fn every_style_round_trips_through_its_menu_id() {
        for style in ALL {
            assert_eq!(WindowStyle::from_id(&style.id()), Some(style));
        }
        assert_eq!(WindowStyle::from_id("window-new"), None);
    }
}
