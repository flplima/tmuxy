import { DEFAULT_FONT_SIZE, smallFontSize } from '../../infra/fontSizeManager';
import { sidebarCellMetrics } from '../../infra/dom/cellMetrics';
import { CHAR_HEIGHT } from '../../constants/layout';
import type { AppMachineContext } from '../types/context';
import type { BottomView } from '../types/domain';
import type { TmuxPane } from '../../domain/client';
import { createMemoizedSelector } from './memoize';
import type { TabDrop } from '../drag/tabStripDrop';
import type { GroupDrop } from '../drag/groupDrop';
import { dragCells, resizedBand } from '../resize/limits';
import { DEFAULT_CHAR_WIDTH } from '../constants';

/**
 * The active window's panes as they are drawn: a resize in progress shows its
 * local preview, and a dragged pane stays where it started.
 */
function selectPreviewPanesUncached(context: AppMachineContext): TmuxPane[] {
  const { panes, resize, drag, charWidth, charHeight, activeWindowId, activePaneId } = context;

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

  if (!resize) {
    return activePanes;
  }

  // The band is rebuilt from the geometry frozen at the start, never the live
  // panes: tmux's intermediate %layout-change events during a resize are
  // inconsistent (a pane it is not resizing briefly reports y=0, which paneBox
  // turns into a dropped header row), and drawing them made the grid wobble.
  const { paneId, handle, originalGeometry, bandGeometry } = resize;

  if (!activePanes.some((p) => p.tmuxId === paneId)) {
    return activePanes;
  }

  // The same clamp the machine puts on the commands, so the drawn band is the
  // layout tmux is being asked for.
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

export const selectPreviewPanes = createMemoizedSelector(previewInputs, selectPreviewPanesUncached);

export function selectPanes(context: AppMachineContext): TmuxPane[] {
  return context.panes;
}

/**
 * Where the dragged pane's ghost is drawn: its original position at first,
 * the target position after each swap.
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
 * The dock's cell grid and font: the sidebar font (`smallFontSize`) with the
 * cell width the pane grid's advance
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

/** What the phone shows under the keys: the menu, the tree or the dock. */
export function selectPhoneBottomView(context: AppMachineContext): BottomView {
  return context.phoneBottomView;
}

/**
 * The size the dock's pane should have, or null before there is room to
 * measure. On a phone it is the bottom view the dock is drawn in. Beside the
 * desktop's grid it is rows only (the column's width is the user's, dragged):
 * the column runs the app body's height in the sidebar font's shorter rows,
 * so it holds more of them than the pane grid.
 */
export function selectDockSize(
  context: AppMachineContext,
): { cols: number | null; rows: number } | null {
  if (context.phoneLayout) return context.phoneDockView;
  if (context.containerHeight <= 0) return null;
  return {
    cols: null,
    rows: Math.max(
      1,
      Math.floor(context.containerHeight / selectSidebarCellMetrics(context).lineHeight),
    ),
  };
}

/**
 * The cell the font measures, before the grid is fitted to the window
 * (domain/gridFit.ts): what the sidebar columns are laid out in.
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

/** The phone layout (infra/dom/phoneLayout.ts). */
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
 * See infra/dom/cellMetrics.ts.
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
