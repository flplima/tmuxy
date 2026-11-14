//! The grid a float's window is sized to, from its `@tmuxy-float-*` tags.
//!
//! The UI draws a float that many cells wide and tall over its tab, and the
//! pane is the window's only one, so the window takes the same size: by the
//! command list that makes the float (`crate::float`) and by the client-size
//! pass that keeps it there (`control_mode::monitor_core::sizing`).

/// `(cols, rows)`, with `None` for a side the viewport decides. A centred
/// float is its tags on both sides. A drawer (`@tmuxy-float-drawer`) runs
/// the length of the edge it is docked to, so only the side it docks by
/// is its own: the width for `left` and `right`, the height for `top` and
/// `bottom`.
pub fn size(
    width: Option<u32>,
    height: Option<u32>,
    drawer: Option<&str>,
) -> (Option<u32>, Option<u32>) {
    match drawer {
        Some("left" | "right") => (width, None),
        Some("top" | "bottom") => (None, height),
        _ => (width, height),
    }
}
