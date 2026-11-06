/**
 * The pane grid in pixels: where a pane, a divider and the grid itself sit,
 * from tmux's cell geometry. Every surface that draws or hit-tests the grid
 * (PaneLayout and its morph, the dividers, the status line, the zoom
 * observer, the drag machine) takes the convention from here.
 *
 * Mosaic invariant — every pane occupies one extra cell in each axis beyond
 * its tmux content size; that extra cell is the border, split into two halves
 * shared with the neighbour on each side (or with the grid edge):
 *
 *   width  = charWidth  * (pane.width  + 1)
 *   height = charHeight * (pane.height + 1)   // the +1 row is the header
 *
 * Each pane is shifted half a cell left (for the shared vertical border) and
 * one full cell up (the header row, which under `pane-border-status top` lives
 * in tmux's separator row at y-1). Adjacent panes' rectangles therefore meet
 * exactly — left.right === right.left and top.bottom === bottom.top — so their
 * 1px outlines coincide and the grid reads as a single connected frame with no
 * gaps between panes.
 */

export interface PaneBoxInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point in the pane container, in pixels. */
export interface GridOffset {
  x: number;
  y: number;
}

/**
 * The outline every pane draws outside its own box (`.pane-layout-item`'s
 * `outline` in styles/pane-layout.css); the grid hangs this far down so the
 * top edge's outline is on screen.
 */
export const PANE_OUTLINE_PX = 1;

/**
 * A pane's pixel rectangle in the layout (see the module note).
 *
 * The topmost pane can report y=0 (no separator row above it — some tiled
 * layouts do this). Such a pane has no header row to hoist, so the vertical
 * shift is clamped to 0; otherwise it would render a full cell above the grid.
 */
export function paneBox(
  pane: PaneBoxInput,
  charWidth: number,
  charHeight: number,
  offsetX = 0,
  offsetY = 0,
): PaneBox {
  // Header row only exists when there's a separator above the pane (y > 0).
  const headerRows = pane.y > 0 ? 1 : 0;
  return {
    left: offsetX + (pane.x - 0.5) * charWidth,
    top: offsetY + (pane.y - headerRows) * charHeight,
    width: (pane.width + 1) * charWidth,
    height: (pane.height + headerRows) * charHeight,
  };
}

/**
 * A pane's content padding on each side: the half cell each pane reaches into
 * the tmux separator column, which centres the terminal text in its
 * +1-cell-wide box.
 */
export function paneContentPadding(charWidth: number): number {
  return charWidth / 2;
}

/** Horizontal inset the drag machine hit-tests a pane with: half a cell, to whole pixels. */
export function paneInsetX(charWidth: number): number {
  return Math.round(charWidth / 2);
}

/** A pane is collapsed in a stack when tmux has shrunk it to a single row. */
export function isCollapsedPane(pane: { height: number }): boolean {
  return pane.height <= 1;
}

/** The grid's pixel size: its extent in cells at the cell size. */
export function gridPixelSize(
  cols: number,
  rows: number,
  charWidth: number,
  charHeight: number,
): { width: number; height: number } {
  return { width: cols * charWidth, height: rows * charHeight };
}

/**
 * Where the grid's origin sits in the container: centred across it, never
 * past its right edge (a transient tmux width wider than the container), and
 * hung from the top one outline down. The rows fill the height in whole
 * cells, and what is left over — up to a row — goes below the grid: split
 * above and below, it was a band of empty ground between the tab strip and
 * the panes.
 */
export function centeringOffset(containerWidth: number, gridWidth: number): GridOffset {
  const ideal = (containerWidth - gridWidth) / 2;
  return { x: Math.max(0, Math.min(ideal, containerWidth - gridWidth)), y: PANE_OUTLINE_PX };
}

/** A divider between panes, in cells: `axisPos` is its row (`h`) or column (`v`). */
export interface DividerSpan {
  orientation: 'h' | 'v';
  axisPos: number;
  start: number;
  end: number;
}

/**
 * A divider's hit area, `thickness` pixels across, centred on the separator.
 * A horizontal one runs along the header row it borders; a vertical one is
 * centred in the 1-charWidth separator column (its visible line sits at the
 * column's midpoint) and reaches up through the header row above it.
 */
export function dividerBox(
  div: DividerSpan,
  charWidth: number,
  charHeight: number,
  offset: GridOffset,
  thickness: number,
): PaneBox {
  if (div.orientation === 'h') {
    return {
      left: offset.x + div.start * charWidth,
      top: offset.y + div.axisPos * charHeight - thickness / 2,
      width: (div.end - div.start) * charWidth,
      height: thickness,
    };
  }
  const top = Math.max(0, div.start - 1);
  return {
    left: offset.x + div.axisPos * charWidth + charWidth / 2 - thickness / 2,
    top: offset.y + top * charHeight,
    width: thickness,
    height: (div.end - top) * charHeight,
  };
}
