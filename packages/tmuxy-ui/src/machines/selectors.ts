import type { AppMachineContext, TmuxPane, PaneStack, ResizeState } from './types';

// ============================================
// Pane Selectors
// ============================================

/**
 * Select preview panes (already computed in context during drag/resize)
 */
export function selectPreviewPanes(context: AppMachineContext): TmuxPane[] {
  return context.previewPanes;
}

/**
 * Select raw panes (unmodified server state)
 */
export function selectPanes(context: AppMachineContext): TmuxPane[] {
  return context.panes;
}

/**
 * Select the drop target position for drag preview indicator
 */
export function selectDropTarget(context: AppMachineContext): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (!context.drag?.targetPaneId) return null;

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

export function selectResizePaneId(context: AppMachineContext): string | null {
  return context.resize?.paneId ?? null;
}

export function selectResizePixelDelta(context: AppMachineContext): { x: number; y: number } {
  return context.resize?.pixelDelta ?? { x: 0, y: 0 };
}

export function selectResizeHandle(context: AppMachineContext): 'n' | 's' | 'e' | 'w' | null {
  return context.resize?.handle ?? null;
}

// ============================================
// Window/Pane Selectors
// ============================================

export function selectWindows(context: AppMachineContext) {
  return context.windows;
}

export function selectActivePane(context: AppMachineContext): TmuxPane | undefined {
  return context.panes.find((p) => p.active);
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
// Command Mode Selector
// ============================================

export function selectCommandInput(context: AppMachineContext): string {
  return context.commandInput;
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
export function selectPanePixelDimensions(context: AppMachineContext): Map<string, PanePixelDimensions> {
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

/**
 * Get pixel dimensions for a single pane
 */
export function selectPanePixelDimensionsById(
  context: AppMachineContext,
  paneId: string
): PanePixelDimensions | null {
  const pane = context.panes.find(p => p.tmuxId === paneId);
  if (!pane) return null;

  const { charWidth, charHeight } = context;
  return {
    paneId: pane.tmuxId,
    pixelX: pane.x * charWidth,
    pixelY: pane.y * charHeight,
    pixelWidth: pane.width * charWidth,
    pixelHeight: pane.height * charHeight,
  };
}

export function selectTargetDimensions(context: AppMachineContext) {
  return {
    targetCols: context.targetCols,
    targetRows: context.targetRows,
    charWidth: context.charWidth,
    charHeight: context.charHeight,
  };
}

// ============================================
// Stack Selectors
// ============================================

export function selectStacks(context: AppMachineContext): Record<string, PaneStack> {
  return context.stacks;
}

/**
 * Find the stack that contains a given pane (if any)
 */
export function selectStackForPane(
  context: AppMachineContext,
  paneId: string
): PaneStack | undefined {
  return Object.values(context.stacks).find((stack) => stack.paneIds.includes(paneId));
}
