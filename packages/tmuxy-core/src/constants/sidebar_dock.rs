//! Geometry of the two docked sidebars (`WindowType::SidebarLeft` /
//! `SidebarRight`).
//!
//! A sidebar window gets its own fixed width, not the viewport's; its rows are
//! the viewport's, since both columns run the full height of the app body with
//! no header of their own.
//!
//! The frontend draws each column at exactly these widths (generated into
//! `tmuxyConstants.gen.ts` as `SIDEBAR_DOCK`), so the rendered terminal and
//! the tmux pane agree on where lines wrap.

use crate::WindowType;

/// Width of the left column (the tree widget), in terminal columns.
pub const LEFT_COLS: u32 = 30;

/// Width of the right column (the pinned terminal), in terminal columns.
pub const RIGHT_COLS: u32 = 35;

/// Narrowest and widest a column may be dragged to. The floor keeps a tree
/// row or shell prompt legible; the ceiling stops a drag from squeezing the
/// pane grid down to nothing.
pub const MIN_COLS: u32 = 16;
pub const MAX_COLS: u32 = 120;

/// Column width for a sidebar window, `None` for any other type (sized to
/// the viewport). `user_cols` is the window's `@tmuxy-sidebar-cols`.
pub fn cols(window_type: WindowType, user_cols: Option<u32>) -> Option<u32> {
    let default = match window_type {
        WindowType::SidebarLeft => LEFT_COLS,
        WindowType::SidebarRight => RIGHT_COLS,
        _ => return None,
    };
    Some(user_cols.map_or(default, |c| c.clamp(MIN_COLS, MAX_COLS)))
}

/// The tmux size for a sidebar window, given the client's viewport rows.
pub fn size(
    window_type: WindowType,
    user_cols: Option<u32>,
    client_rows: u32,
) -> Option<(u32, u32)> {
    cols(window_type, user_cols).map(|c| (c, client_rows.max(1)))
}
