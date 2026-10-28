import { DEFAULT_FONT_SIZE, smallFontSize } from '../../utils/fontSizeManager';
import { sidebarCellMetrics } from '../../utils/cellMetrics';
import { CHAR_HEIGHT } from '../../constants/layout';
import type { AppMachineContext } from '../types/context';
import type { TmuxPane } from '../../domain/client';
import { createMemoizedSelector } from '../../utils/memoize';
import type { TabDrop } from '../../utils/tabStripDrop';
import type { GroupDrop } from '../../utils/groupDrop';
import { dragCells, resizedBand } from '../resize/limits';
import { DEFAULT_CHAR_WIDTH } from '../constants';

// ============================================
// Pane Selectors
// ============================================

/**
 * Select panes for display with resize preview.
 * During resize: pane sizes follow cursor position exactly (local preview)
 * During drag: dragged pane stays at original position (before any swaps)
 * After resize: pane sizes match actual tmux state
 *
 * Only returns panes from the active window - panes in hidden group windows
 * are not rendered.
 */
function selectPreviewPanesUncached(context: AppMachineContext): TmuxPane[] {
  const { panes, resize, drag, charWidth, charHeight, activeWindowId, activePaneId } = context;

  // Group-switch geometry pinning lives in the GroupSwitch op's optimistic
  // patch (store/ops.ts) — by the time panes reach context they already
  // reflect the swap, so no per-selector override pass is needed here.

  // Single pass: filter to active window + apply active/drag transforms
  const activePanes: TmuxPane[] = [];
  for (const pane of panes) {
    if (activeWindowId && pane.windowId !== activeWindowId) continue;

    let result = pane;
    const shouldBeActive = pane.tmuxId === activePaneId;
    const needsActiveUpdate = pane.active !== shouldBeActive;
    const needsDragOverride = drag && pane.tmuxId === drag.draggedPaneId;

    if (needsActiveUpdate || needsDragOverride) {
      result = { ...pane };
      if (needsActiveUpdate) result.active = shouldBeActive;
      if (needsDragOverride) {
        result.x = drag!.originalX;
        result.y = drag!.originalY;
        result.width = drag!.originalWidth;
        result.height = drag!.originalHeight;
      }
    }
    activePanes.push(result);
  }

  // If not resizing, return (potentially drag-adjusted) panes
  if (!resize) {
    return activePanes;
  }

  // During resize: reconstruct the affected BAND from the FROZEN start geometry
  // (resize.originalGeometry), never the live server panes. Dragging one divider
  // resizes every pane that shares the target's dragged edge (they grow/shrink
  // together) plus every pane directly across the line (they move and shrink);
  // all other panes hold exactly still. tmux's intermediate %layout-change
  // events during a resize are internally inconsistent — a pane it isn't
  // resizing briefly reports y=0, which computePaneBox turns into a dropped
  // header row and a 1-row content jump — so rendering them is what caused the
  // wobble. Rebuilding from the snapshot keeps everything stable and monotonic.
  const { paneId, handle, originalGeometry, bandGeometry } = resize;

  if (!activePanes.some((p) => p.tmuxId === paneId)) {
    return activePanes;
  }

  // The same clamp the machine puts on the commands, so the drawn band and
  // the layout tmux is being asked for are the same thing. Without it the
  // pane on the near side kept growing under the pointer while the one across
  // the line bottomed out at a single cell, and they overlapped.
  const band = resizedBand(bandGeometry, paneId, handle, dragCells(resize, charWidth, charHeight));

  return activePanes.map((pane) => {
    const frozen = originalGeometry[pane.tmuxId];
    if (!frozen) return pane; // pane appeared mid-resize; leave as-is
    return { ...pane, ...(band[pane.tmuxId] ?? frozen) };
  });
}

/** Everything the preview panes are computed from: the memo key of every selector built on them. */
export const previewInputs = (ctx: AppMachineContext) => ({
  panes: ctx.panes,
  resize: ctx.resize,
  drag: ctx.drag,
  charWidth: ctx.charWidth,
  charHeight: ctx.charHeight,
  activeWindowId: ctx.activeWindowId,
  activePaneId: ctx.activePaneId,
});

/**
 * Memoized version of selectPreviewPanes.
 * Only recomputes when panes, resize state, drag state, char dimensions, or active window change.
 */
export const selectPreviewPanes = createMemoizedSelector(previewInputs, selectPreviewPanesUncached);

/**
 * Select raw panes (unmodified server state)
 */
export function selectPanes(context: AppMachineContext): TmuxPane[] {
  return context.panes;
}

/**
 * Select the ghost position showing where the dragged pane currently lives in the grid.
 * Starts at the dragged pane's original position, moves to target position on each swap.
 */
export function selectDropTarget(context: AppMachineContext): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (!context.drag) return null;

  return {
    x: context.drag.ghostX,
    y: context.drag.ghostY,
    width: context.drag.ghostWidth,
    height: context.drag.ghostHeight,
  };
}

// ============================================
// Drag Selectors
// ============================================

export function selectDraggedPaneId(context: AppMachineContext): string | null {
  return context.drag?.draggedPaneId ?? null;
}

/** Where a pane being dragged over the tab strip would land, if it is there. */
export function selectTabDrop(context: AppMachineContext): TabDrop | null {
  return context.drag?.tabDrop ?? null;
}

/** Where in a pane group a pane being dragged over a header would go, if anywhere. */
export function selectGroupDrop(context: AppMachineContext): GroupDrop | null {
  return context.drag?.groupDrop ?? null;
}

export function selectDragOffsetX(context: AppMachineContext): number {
  if (!context.drag) return 0;
  return context.drag.currentX - context.drag.startX;
}

export function selectDragOffsetY(context: AppMachineContext): number {
  if (!context.drag) return 0;
  return context.drag.currentY - context.drag.startY;
}

// ============================================
// Container Size Selectors
// ============================================

/** The content box the pane area lays itself out in. */
export const selectContainerSize = createMemoizedSelector(
  (context: AppMachineContext) => ({
    width: context.containerWidth,
    height: context.containerHeight,
  }),
  (context: AppMachineContext): { width: number; height: number } => ({
    width: context.containerWidth,
    height: context.containerHeight,
  }),
);

// ============================================
// Grid Dimension & Cell Metric Selectors
// ============================================

export const selectGridDimensions = createMemoizedSelector(
  (context: AppMachineContext) => ({
    totalWidth: context.totalWidth,
    totalHeight: context.totalHeight,
    charWidth: context.charWidth,
    charHeight: context.charHeight,
  }),
  (context: AppMachineContext) => ({
    totalWidth: context.totalWidth,
    totalHeight: context.totalHeight,
    charWidth: context.charWidth,
    charHeight: context.charHeight,
  }),
);

/**
 * The dock's cell grid and font: the sidebar font (80% of the pane font,
 * rounded — see fontSizeManager) with the cell width the pane grid's advance
 * scales to. The right column is drawn and its tmux pane sized in these cells.
 */
export const selectSidebarCellMetrics = createMemoizedSelector(
  (context: AppMachineContext) => [context.measuredCell, context.baseFontSize] as const,
  (context: AppMachineContext) => {
    const fontSize = smallFontSize(context.baseFontSize);
    const { charWidth, cellGap } = context.measuredCell;
    const metrics = sidebarCellMetrics(
      { charWidth: charWidth || DEFAULT_CHAR_WIDTH, cellGap },
      context.baseFontSize,
      fontSize,
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    );
    // Rows scale with the font too; whole pixels keep the grid crisp.
    const lineHeight = Math.max(
      1,
      Math.round((CHAR_HEIGHT * fontSize) / (context.baseFontSize || 1)),
    );
    return { fontSize, cellWidth: metrics.cellWidth, cellGap: metrics.cellGap, lineHeight };
  },
);

/** The phone's dock runs in the chrome's small type, whatever the terminal's cell shrank to. */
export const PHONE_DOCK_FONT_PX = 12;

/**
 * The cell the phone's bottom view draws the dock in (App.tsx): the chrome's
 * small font, derived from the measured cell the way the sidebar's is — the
 * measured cell on a phone is the one cut to fit 80 columns, at its own
 * font size, so the advance is scaled from that size rather than the chrome's.
 */
export const selectPhoneDockCellMetrics = createMemoizedSelector(
  (context: AppMachineContext) => [context.measuredCell, context.baseFontSize] as const,
  (context: AppMachineContext) => {
    const { charWidth, cellGap, gridFontSize } = context.measuredCell;
    const metrics = sidebarCellMetrics(
      { charWidth: charWidth || DEFAULT_CHAR_WIDTH, cellGap },
      gridFontSize ?? context.baseFontSize,
      PHONE_DOCK_FONT_PX,
      typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    );
    const lineHeight = Math.max(
      1,
      Math.round((CHAR_HEIGHT * PHONE_DOCK_FONT_PX) / DEFAULT_FONT_SIZE),
    );
    return {
      fontSize: PHONE_DOCK_FONT_PX,
      cellWidth: metrics.cellWidth,
      cellGap: metrics.cellGap,
      lineHeight,
    };
  },
);

/** The phone's browser-side zoom, if on (the `phone` slice). */
export function selectPhoneZoom(context: AppMachineContext): AppMachineContext['phoneZoom'] {
  return context.phoneZoom;
}

/** What the phone shows under the keys: the tree or the dock. */
export function selectPhoneBottomView(context: AppMachineContext): 'tree' | 'dock' {
  return context.phoneBottomView;
}

/**
 * Rows the dock's pane should have: the column runs the app body's height in
 * the sidebar font's shorter rows, so it holds more of them than the pane
 * grid. 0 before the body has been measured.
 */
export function selectDockRows(context: AppMachineContext): number {
  if (context.containerHeight <= 0) return 0;
  return Math.max(
    1,
    Math.floor(context.containerHeight / selectSidebarCellMetrics(context).lineHeight),
  );
}

/**
 * The cell the font measures, before the grid is fitted to the window
 * (utils/gridFit.ts): what the sidebar columns are laid out in.
 */
export function selectMeasuredCell(context: AppMachineContext) {
  return context.measuredCell;
}

export const selectCharSize = createMemoizedSelector(
  (context: AppMachineContext) => ({
    charWidth: context.charWidth,
    charHeight: context.charHeight,
  }),
  (context: AppMachineContext) => ({
    charWidth: context.charWidth,
    charHeight: context.charHeight,
  }),
);

/** The phone layout: the whole 80 × 25 terminal, a key row and the tree. */
export function selectPhoneLayout(context: AppMachineContext): boolean {
  return context.phoneLayout;
}

/** The phone layout held sideways. */
export function selectPhoneLandscape(context: AppMachineContext): boolean {
  return context.phoneLandscape;
}

/**
 * The pane grid's own type when it is not the chrome's: on a phone, the font
 * size and row height that fit 80 columns across; under a `@tmuxy-size` other
 * than `smallest`, the ones that fit the window tmux was given. Null otherwise.
 */
export const selectGridType = createMemoizedSelector(
  (context: AppMachineContext) => ({
    fontSize: context.gridFontSize,
    rowHeight: context.charHeight,
  }),
  (context: AppMachineContext) =>
    context.gridFontSize === null
      ? null
      : { fontSize: context.gridFontSize, rowHeight: context.charHeight },
);

/**
 * The cell grid published to CSS: `--cell-w` / `--cell-gap` on the app root.
 * See utils/cellMetrics.ts.
 */
export const selectCellMetrics = createMemoizedSelector(
  (context: AppMachineContext) => ({
    cellWidth: context.charWidth,
    cellGap: context.cellGap,
  }),
  (context: AppMachineContext) => ({
    cellWidth: context.charWidth,
    cellGap: context.cellGap,
  }),
);
