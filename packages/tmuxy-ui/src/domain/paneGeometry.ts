/**
 * Where the pane grid sits in its container, in pixels: one answer for the
 * drawing (PaneLayout) and the hit test (the drag machine).
 */

/** The outline every pane draws outside its own box (`.pane-layout-item`). */
const PANE_OUTLINE_PX = 1;

/**
 * The grid's top-left corner in the pane container: centred across (clamped so
 * a grid wider than the container, a transient tmux size, starts at the left
 * edge), and hung from the top one pixel down for the outline. The rows fill
 * the height in whole cells and what is left over goes below the grid.
 */
export function gridOrigin(
  gridCols: number,
  charWidth: number,
  containerWidth: number,
): { x: number; y: number } {
  const width = gridCols * charWidth;
  return {
    x: Math.max(0, Math.min((containerWidth - width) / 2, containerWidth - width)),
    y: PANE_OUTLINE_PX,
  };
}
