import type { AppMachineContext, TmuxPane, PaneGroup, ResizeState, FloatPaneState } from './types';
import { createMemoizedSelector, createMemoizedSelectorWithArg } from '../utils/memoize';

// ============================================
// Pane Selectors
// ============================================

/**
 * Select panes for display with resize preview.
 * During resize: pane sizes follow cursor position exactly (local preview)
 * After resize: pane sizes match actual tmux state
 *
 * Only returns panes from the active window - panes in hidden group windows
 * are not rendered.
 */
function selectPreviewPanesUncached(context: AppMachineContext): TmuxPane[] {
  const { panes, resize, charWidth, charHeight, activeWindowId } = context;

  // Filter to only panes in the active window
  const activePanes = activeWindowId
    ? panes.filter(p => p.windowId === activeWindowId)
    : panes;

  // If not resizing, return active window panes
  if (!resize) {
    return activePanes;
  }

  // During resize: apply local preview based on pixelDelta
  const { paneId, handle, pixelDelta, originalPane, originalNeighbors } = resize;

  // Find the target pane in active window
  const targetPane = activePanes.find(p => p.tmuxId === paneId);
  if (!targetPane) {
    return activePanes;
  }

  // Build a set of neighbor IDs for quick lookup
  const neighborIds = new Set(originalNeighbors.map(n => n.tmuxId));
  // Map from neighbor ID to its original state
  const originalNeighborMap = new Map(originalNeighbors.map(n => [n.tmuxId, n]));

  // Calculate delta in character units from pixel offset
  const deltaCols = Math.round(pixelDelta.x / charWidth);
  const deltaRows = Math.round(pixelDelta.y / charHeight);

  // Apply preview transformations to active window panes only
  return activePanes.map(pane => {
    if (pane.tmuxId === paneId) {
      // Target pane: adjust size based on handle
      const newPane = { ...pane };
      if (handle === 'e') {
        newPane.width = Math.max(1, originalPane.width + deltaCols);
      } else if (handle === 'w') {
        newPane.x = originalPane.x + deltaCols;
        newPane.width = Math.max(1, originalPane.width - deltaCols);
      } else if (handle === 's') {
        newPane.height = Math.max(1, originalPane.height + deltaRows);
      } else if (handle === 'n') {
        newPane.y = originalPane.y + deltaRows;
        newPane.height = Math.max(1, originalPane.height - deltaRows);
      }
      return newPane;
    } else if (neighborIds.has(pane.tmuxId)) {
      // Neighbor pane: adjust position and size inversely
      const originalNeighbor = originalNeighborMap.get(pane.tmuxId)!;
      const newPane = { ...pane };
      if (handle === 'e') {
        newPane.x = originalNeighbor.x + deltaCols;
        newPane.width = Math.max(1, originalNeighbor.width - deltaCols);
      } else if (handle === 'w') {
        newPane.width = Math.max(1, originalNeighbor.width + deltaCols);
      } else if (handle === 's') {
        newPane.y = originalNeighbor.y + deltaRows;
        newPane.height = Math.max(1, originalNeighbor.height - deltaRows);
      } else if (handle === 'n') {
        newPane.height = Math.max(1, originalNeighbor.height + deltaRows);
      }
      return newPane;
    }
    return pane;
  });
}

/**
 * Memoized version of selectPreviewPanes.
 * Only recomputes when panes, resize state, char dimensions, or active window change.
 */
export const selectPreviewPanes = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    panes: ctx.panes,
    resize: ctx.resize,
    charWidth: ctx.charWidth,
    charHeight: ctx.charHeight,
    activeWindowId: ctx.activeWindowId,
  }),
  selectPreviewPanesUncached
);

/**
 * Get the original position of the dragged pane (before any swaps).
 * Used to keep the dragged pane visually stable during real-time swaps.
 */
export function selectDragOriginalPosition(context: AppMachineContext): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (!context.drag) return null;
  return {
    x: context.drag.originalX,
    y: context.drag.originalY,
    width: context.drag.originalWidth,
    height: context.drag.originalHeight,
  };
}

/**
 * Select raw panes (unmodified server state)
 */
export function selectPanes(context: AppMachineContext): TmuxPane[] {
  return context.panes;
}

/**
 * Select the drop target position for drag preview indicator.
 * Uses the ORIGINAL position when the target was first detected,
 * so the indicator stays stable during real-time swaps.
 */
export function selectDropTarget(context: AppMachineContext): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (!context.drag?.targetPaneId) return null;

  // Use stored original position for stable drop indicator
  const { targetOriginalX, targetOriginalY, targetOriginalWidth, targetOriginalHeight } = context.drag;

  if (
    targetOriginalX !== null &&
    targetOriginalY !== null &&
    targetOriginalWidth !== null &&
    targetOriginalHeight !== null
  ) {
    return {
      x: targetOriginalX,
      y: targetOriginalY,
      width: targetOriginalWidth,
      height: targetOriginalHeight,
    };
  }

  // Fallback to current position (shouldn't happen normally)
  const target = context.panes.find((p) => p.tmuxId === context.drag!.targetPaneId);
  if (!target) return null;

  return {
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
  };
}

// ============================================
// Drag Selectors
// ============================================

export function selectDraggedPaneId(context: AppMachineContext): string | null {
  return context.drag?.draggedPaneId ?? null;
}

export function selectDragTargetNewWindow(context: AppMachineContext): boolean {
  return context.drag?.targetNewWindow === true;
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
// Resize Selectors
// ============================================

export function selectResize(context: AppMachineContext): ResizeState | null {
  return context.resize;
}

export function selectResizePixelDelta(context: AppMachineContext): { x: number; y: number } {
  return context.resize?.pixelDelta ?? { x: 0, y: 0 };
}

// ============================================
// Window/Pane Selectors
// ============================================

export function selectWindows(context: AppMachineContext) {
  return context.windows;
}

export function selectActiveWindowId(context: AppMachineContext): string | null {
  return context.activeWindowId;
}

// ============================================
// Connection Selectors
// ============================================

export function selectIsConnected(context: AppMachineContext): boolean {
  return context.connected;
}

export function selectError(context: AppMachineContext): string | null {
  return context.error;
}

// ============================================
// Container Size Selector
// ============================================

export function selectContainerSize(context: AppMachineContext): { width: number; height: number } {
  return {
    width: context.containerWidth,
    height: context.containerHeight,
  };
}

// ============================================
// Grid Dimension Selectors
// ============================================

export function selectGridDimensions(context: AppMachineContext) {
  return {
    totalWidth: context.totalWidth,
    totalHeight: context.totalHeight,
    charWidth: context.charWidth,
    charHeight: context.charHeight,
  };
}

export function selectCharSize(context: AppMachineContext) {
  return {
    charWidth: context.charWidth,
    charHeight: context.charHeight,
  };
}

// ============================================
// Pane Pixel Dimension Selectors
// ============================================

export interface PanePixelDimensions {
  paneId: string;
  pixelX: number;
  pixelY: number;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * Get pixel dimensions for all panes (computed from char dimensions)
 * Useful for resize preview and layout calculations
 */
function selectPanePixelDimensionsUncached(context: AppMachineContext): Map<string, PanePixelDimensions> {
  const { charWidth, charHeight } = context;
  const result = new Map<string, PanePixelDimensions>();

  for (const pane of context.panes) {
    result.set(pane.tmuxId, {
      paneId: pane.tmuxId,
      pixelX: pane.x * charWidth,
      pixelY: pane.y * charHeight,
      pixelWidth: pane.width * charWidth,
      pixelHeight: pane.height * charHeight,
    });
  }

  return result;
}

export const selectPanePixelDimensions = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    panes: ctx.panes,
    charWidth: ctx.charWidth,
    charHeight: ctx.charHeight,
  }),
  selectPanePixelDimensionsUncached
);

// ============================================
// Pane Group Selectors
// ============================================

export function selectPaneGroups(context: AppMachineContext): Record<string, PaneGroup> {
  return context.paneGroups;
}

/**
 * Get the active pane ID in a group (derived from which pane is in the active window)
 */
export function getActivePaneInGroup(context: AppMachineContext, group: PaneGroup): string | null {
  for (const paneId of group.paneIds) {
    const pane = context.panes.find(p => p.tmuxId === paneId);
    if (pane?.windowId === context.activeWindowId) {
      return paneId;
    }
  }
  return null;
}

/**
 * Get the active index in a group (derived from which pane is in the active window)
 */
export function getActiveIndexInGroup(context: AppMachineContext, group: PaneGroup): number {
  const activePaneId = getActivePaneInGroup(context, group);
  return activePaneId ? group.paneIds.indexOf(activePaneId) : 0;
}

/**
 * Select visible panes - filters out hidden group panes
 * For groups, only the pane in the active window is visible.
 */
function selectVisiblePanesUncached(context: AppMachineContext): TmuxPane[] {
  const previewPanes = selectPreviewPanes(context);
  const groupsArray = Object.values(context.paneGroups);

  if (groupsArray.length === 0) return previewPanes;

  // Build a Set of hidden pane IDs for O(1) lookup
  const hiddenPaneIds = new Set<string>();

  for (const group of groupsArray) {
    // The active pane is whichever one is in the active window
    const activePaneId = getActivePaneInGroup(context, group);

    // Hide all group panes except the one in the active window
    for (const paneId of group.paneIds) {
      if (paneId !== activePaneId) {
        hiddenPaneIds.add(paneId);
      }
    }
  }

  return previewPanes.filter((pane) => !hiddenPaneIds.has(pane.tmuxId));
}

export const selectVisiblePanes = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    panes: ctx.panes,
    paneGroups: ctx.paneGroups,
    resize: ctx.resize,
    charWidth: ctx.charWidth,
    charHeight: ctx.charHeight,
    activeWindowId: ctx.activeWindowId,
  }),
  selectVisiblePanesUncached
);

/**
 * Find the group that contains a given pane (if any)
 */
export const selectPaneGroupForPane = createMemoizedSelectorWithArg(
  (ctx: AppMachineContext, _paneId: string) => ctx.paneGroups,
  (context: AppMachineContext, paneId: string): PaneGroup | undefined => {
    return Object.values(context.paneGroups).find((group) => group.paneIds.includes(paneId));
  }
);

/**
 * Get all panes in a group (resolved from pane IDs)
 */
export function selectPaneGroupPanes(
  context: AppMachineContext,
  group: PaneGroup
): TmuxPane[] {
  return group.paneIds
    .map((id) => context.panes.find((p) => p.tmuxId === id))
    .filter((p): p is TmuxPane => p !== undefined);
}

// ============================================
// Float Selectors
// ============================================

export function selectFloatViewVisible(context: AppMachineContext): boolean {
  return context.floatViewVisible;
}

export function selectFloatPanes(context: AppMachineContext): FloatPaneState[] {
  return Object.values(context.floatPanes);
}

export function selectFloatPaneState(context: AppMachineContext, paneId: string): FloatPaneState | undefined {
  return context.floatPanes[paneId];
}

/**
 * Get all visible float panes (visible when float view is shown, or pinned)
 */
export function selectVisibleFloatPanes(context: AppMachineContext): FloatPaneState[] {
  const floats = Object.values(context.floatPanes);
  if (context.floatViewVisible) {
    return floats;
  }
  // Only pinned floats are visible when float view is hidden
  return floats.filter((f) => f.pinned);
}

/**
 * Get float pane IDs (for filtering from tiled panes)
 */
export function selectFloatPaneIds(context: AppMachineContext): string[] {
  return Object.keys(context.floatPanes);
}

// ============================================
// Status Line Selector
// ============================================

export function selectStatusLine(context: AppMachineContext): string {
  return context.statusLine;
}

// ============================================
// Single Pane Selector
// ============================================

/**
 * Select a single pane by ID from preview panes (includes resize preview)
 */
export const selectPaneById = createMemoizedSelectorWithArg(
  (ctx: AppMachineContext, _paneId: string) => ({
    panes: ctx.panes,
    resize: ctx.resize,
    charWidth: ctx.charWidth,
    charHeight: ctx.charHeight,
  }),
  (context: AppMachineContext, paneId: string): TmuxPane | undefined => {
    const previewPanes = selectPreviewPanes(context);
    return previewPanes.find((p) => p.tmuxId === paneId);
  }
);

/**
 * Check if a specific pane is in the active window
 */
export function selectIsPaneInActiveWindow(context: AppMachineContext, paneId: string): boolean {
  const pane = context.panes.find((p) => p.tmuxId === paneId);
  return pane?.windowId === context.activeWindowId;
}

// ============================================
// Single Pane Count Selector
// ============================================

export function selectIsSinglePane(context: AppMachineContext): boolean {
  return selectVisiblePanes(context).length === 1;
}

// ============================================
// Animation Selectors
// ============================================

/**
 * Select whether browser-side animations are enabled
 */
export function selectEnableAnimations(context: AppMachineContext): boolean {
  return context.enableAnimations;
}
