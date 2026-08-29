import type {
  AppMachineContext,
  LogEntry,
  TmuxPane,
  PaneGroup,
  KeyBindings,
  SessionTreeNode,
} from './types';
import { createMemoizedSelector, createMemoizedSelectorWithArg } from '../utils/memoize';

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
  const { paneId, handle, pixelDelta, originalPane, originalGeometry } = resize;

  if (!activePanes.some((p) => p.tmuxId === paneId)) {
    return activePanes;
  }

  const deltaCols = Math.round(pixelDelta.x / charWidth);
  const deltaRows = Math.round(pixelDelta.y / charHeight);
  const og = originalGeometry;
  const t = og[paneId] ?? {
    x: originalPane.x,
    y: originalPane.y,
    width: originalPane.width,
    height: originalPane.height,
  };
  // The coordinate of the dragged edge at the start of the resize.
  const edge =
    handle === 'e' ? t.x + t.width : handle === 'w' ? t.x : handle === 's' ? t.y + t.height : t.y; // 'n'

  return activePanes.map((pane) => {
    const o = og[pane.tmuxId];
    if (!o) return pane; // pane appeared mid-resize; leave as-is
    const p = { ...pane, x: o.x, y: o.y, width: o.width, height: o.height };
    const right = o.x + o.width;
    const bottom = o.y + o.height;

    if (handle === 'e') {
      if (right === edge)
        p.width = Math.max(1, o.width + deltaCols); // grower
      else if (o.x === edge + 1) {
        p.x = o.x + deltaCols; // shrinker to the right
        p.width = Math.max(1, o.width - deltaCols);
      }
    } else if (handle === 'w') {
      if (o.x === edge) {
        p.x = o.x + deltaCols; // grower (moves right edge = left, shrinks)
        p.width = Math.max(1, o.width - deltaCols);
      } else if (right === edge - 1) {
        p.width = Math.max(1, o.width + deltaCols); // shrinker to the left
      }
    } else if (handle === 's') {
      if (bottom === edge)
        p.height = Math.max(1, o.height + deltaRows); // grower row
      else if (o.y === edge + 1 || o.y === edge + 2) {
        p.y = o.y + deltaRows; // shrinker row below
        p.height = Math.max(1, o.height - deltaRows);
      }
    } else if (handle === 'n') {
      if (o.y === edge) {
        p.y = o.y + deltaRows; // grower (top edge moves, shrinks)
        p.height = Math.max(1, o.height - deltaRows);
      } else if (bottom === edge - 1 || bottom === edge - 2) {
        p.height = Math.max(1, o.height + deltaRows); // shrinker row above
      }
    }
    return p;
  });
}

/**
 * Memoized version of selectPreviewPanes.
 * Only recomputes when panes, resize state, drag state, char dimensions, or active window change.
 */
export const selectPreviewPanes = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    panes: ctx.panes,
    resize: ctx.resize,
    drag: ctx.drag,
    charWidth: ctx.charWidth,
    charHeight: ctx.charHeight,
    activeWindowId: ctx.activeWindowId,
    activePaneId: ctx.activePaneId,
  }),
  selectPreviewPanesUncached,
);

/**
 * Select raw panes (unmodified server state)
 */
export function selectPanes(context: AppMachineContext): TmuxPane[] {
  return context.panes;
}

/**
 * Select all sessions on the current server for the sidebar sessions tree.
 * Populated on web + desktop by the `serversActor` poll; empty on the demo/v86
 * sandboxes.
 */
export function selectSessions(context: AppMachineContext): SessionTreeNode[] {
  return context.sessions;
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

// ============================================
// Window/Pane Selectors
// ============================================

/**
 * Windows with `active` derived from context.activeWindowId.
 *
 * The server snapshot also carries an `active` boolean per window, but it
 * lags our optimistic SELECT_TAB flip — a snapshot captured before tmux
 * processed `select-window` still marks the old window active, which would
 * make the tab highlight blink (new → old → new) as those snapshots arrive.
 * Deriving from activeWindowId here makes the UI a single source of truth.
 */
export const selectWindows = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.windows, ctx.activeWindowId] as const,
  (context: AppMachineContext) =>
    context.windows.map((w) => {
      const shouldBeActive = w.id === context.activeWindowId;
      return w.active === shouldBeActive ? w : { ...w, active: shouldBeActive };
    }),
);

/** Windows visible in the status bar. Only tab-typed windows show as tabs;
 *  group and float windows are hidden, and foreign (untagged) windows are
 *  ignored entirely. */
export const selectVisibleWindows = createMemoizedSelector(
  (ctx: AppMachineContext) => [ctx.windows, ctx.activeWindowId] as const,
  (context: AppMachineContext) =>
    selectWindows(context).filter((w) => w.windowType === 'tab' && w.name !== ''),
);

// ============================================
// Connection Selectors
// ============================================

export function selectError(context: AppMachineContext): string | null {
  return context.error;
}

export function selectFatalError(context: AppMachineContext): string | null {
  return context.fatalError;
}

export function selectReconnectAttempt(context: AppMachineContext): number {
  return context.reconnectAttempt;
}

export function selectLog(context: AppMachineContext): LogEntry[] {
  return context.log;
}

// ============================================
// Container Size Selector
// ============================================

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
// Grid Dimension Selectors
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

// ============================================
// Pane Pixel Dimension Selectors
// ============================================

// ============================================
// Pane Group Selectors
// ============================================

/**
 * Get the active pane ID in a group (derived from which pane is in the active window)
 */
export function getActivePaneInGroup(context: AppMachineContext, group: PaneGroup): string | null {
  for (const paneId of group.paneIds) {
    const pane = context.panes.find((p) => p.tmuxId === paneId);
    if (pane?.windowId === context.activeWindowId) {
      return paneId;
    }
  }
  return null;
}

/**
 * Select visible panes - filters out hidden group panes
 * For groups, only the pane in the active window is visible.
 */
function selectVisiblePanesUncached(context: AppMachineContext): TmuxPane[] {
  let previewPanes = selectPreviewPanes(context);

  // Filter out panes that belong to float windows (prevents split blink
  // when float-create.sh does split-window + break-pane — briefly the new
  // pane exists in the current window before being moved)
  const floatPaneIds = context.floatPanes;
  if (Object.keys(floatPaneIds).length > 0) {
    previewPanes = previewPanes.filter((p) => !floatPaneIds[p.tmuxId]);
  }

  const groupsArray = Object.values(context.paneGroups);

  let result: TmuxPane[];
  if (groupsArray.length === 0) {
    result = previewPanes;
  } else {
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

    result = previewPanes.filter((pane) => !hiddenPaneIds.has(pane.tmuxId));
  }

  // Sort by tmuxId for stable DOM order. Panes are absolutely positioned so
  // DOM order has no visual effect, but a stable sort prevents React from
  // physically moving DOM nodes when positions change (layout cycle, resize).
  // Uses code-point comparison (not localeCompare) because ICU collation
  // sorts __placeholder_* before %NNN, but code-point order puts % (U+0025)
  // before _ (U+005F). This keeps DOM order stable across the optimistic
  // placeholder→real pane transition, preventing React from reordering nodes.
  // Spread first — result may alias the memoized selectPreviewPanes cache.
  return [...result].sort((a, b) => (a.tmuxId < b.tmuxId ? -1 : a.tmuxId > b.tmuxId ? 1 : 0));
}

export const selectVisiblePanes = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    panes: ctx.panes,
    paneGroups: ctx.paneGroups,
    resize: ctx.resize,
    drag: ctx.drag,
    charWidth: ctx.charWidth,
    charHeight: ctx.charHeight,
    activeWindowId: ctx.activeWindowId,
    activePaneId: ctx.activePaneId,
    floatPanes: ctx.floatPanes,
  }),
  selectVisiblePanesUncached,
);

/**
 * Panes that belong to non-active, non-float windows. PaneLayout renders these
 * with `display: none` so their <TerminalPane> instances stay mounted across
 * tab switches — eliminates the empty-pane flash on window change (the new
 * window's panes already have their DOM + content in place).
 *
 * Float panes and group-hidden panes are excluded because they have their own
 * rendering paths (floats) or are intentionally suppressed (group siblings).
 */
function selectHiddenWindowPanesUncached(context: AppMachineContext): TmuxPane[] {
  const { panes, activeWindowId, floatPanes, paneGroups } = context;
  if (!activeWindowId) return [];

  const hiddenGroupPaneIds = new Set<string>();
  for (const group of Object.values(paneGroups)) {
    const activeGroupPaneId = getActivePaneInGroup(context, group);
    for (const id of group.paneIds) {
      if (id !== activeGroupPaneId) hiddenGroupPaneIds.add(id);
    }
  }

  const result: TmuxPane[] = [];
  for (const pane of panes) {
    if (pane.windowId === activeWindowId) continue;
    if (floatPanes[pane.tmuxId]) continue;
    if (hiddenGroupPaneIds.has(pane.tmuxId)) continue;
    result.push(pane);
  }
  return result.sort((a, b) => (a.tmuxId < b.tmuxId ? -1 : a.tmuxId > b.tmuxId ? 1 : 0));
}

export const selectHiddenWindowPanes = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    panes: ctx.panes,
    paneGroups: ctx.paneGroups,
    activeWindowId: ctx.activeWindowId,
    floatPanes: ctx.floatPanes,
    windows: ctx.windows,
  }),
  selectHiddenWindowPanesUncached,
);

/**
 * Find the group that contains a given pane (if any)
 */
export const selectPaneGroupForPane = createMemoizedSelectorWithArg(
  (ctx: AppMachineContext, _paneId: string) => ctx.paneGroups,
  (context: AppMachineContext, paneId: string): PaneGroup | undefined => {
    return Object.values(context.paneGroups).find((group) => group.paneIds.includes(paneId));
  },
);

/**
 * Get all panes in a group (resolved from pane IDs)
 */
export function selectPaneGroupPanes(context: AppMachineContext, group: PaneGroup): TmuxPane[] {
  return group.paneIds
    .map((id) => context.panes.find((p) => p.tmuxId === id))
    .filter((p): p is TmuxPane => p !== undefined);
}

// ============================================
// Float Selectors
// ============================================

// ============================================
// Status Line Selector
// ============================================

// ============================================
// Single Pane Selector
// ============================================

/**
 * Select a single pane by ID from preview panes (includes resize preview)
 */
/**
 * Memoized Map for O(1) pane lookup from preview panes.
 */
const selectPreviewPaneMap = createMemoizedSelector(
  (ctx: AppMachineContext) => ({
    panes: ctx.panes,
    resize: ctx.resize,
    drag: ctx.drag,
    charWidth: ctx.charWidth,
    charHeight: ctx.charHeight,
    activeWindowId: ctx.activeWindowId,
    activePaneId: ctx.activePaneId,
  }),
  (context: AppMachineContext): Map<string, TmuxPane> => {
    const previewPanes = selectPreviewPanes(context);
    const map = new Map<string, TmuxPane>();
    for (const pane of previewPanes) {
      map.set(pane.tmuxId, pane);
    }
    return map;
  },
);

export const selectPaneById = createMemoizedSelectorWithArg(
  (ctx: AppMachineContext, _paneId: string) => ({
    panes: ctx.panes,
    resize: ctx.resize,
    drag: ctx.drag,
    charWidth: ctx.charWidth,
    charHeight: ctx.charHeight,
    activeWindowId: ctx.activeWindowId,
    activePaneId: ctx.activePaneId,
  }),
  (context: AppMachineContext, paneId: string): TmuxPane | undefined => {
    const paneMap = selectPreviewPaneMap(context);
    return paneMap.get(paneId) ?? context.panes.find((p) => p.tmuxId === paneId);
  },
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
// Group Switch Selectors
// ============================================

/**
 * Pane IDs touched by an in-flight GroupSwitch op — disables CSS transitions
 * on those panes so they don't animate position/size during the swap.
 * Derived from the store's op log (mirrored into context on every
 * TMUX_MODEL_UPDATE); clears itself when the op confirms or rolls back.
 */
export function selectGroupSwitchPaneIds(context: AppMachineContext): Set<string> | null {
  const ids = context.groupSwitchPaneIds;
  if (ids.length === 0) return null;
  return new Set(ids);
}

// ============================================
// Session Selectors
// ============================================

export function selectSessionName(context: AppMachineContext): string {
  return context.sessionName;
}

// ============================================
// Keybindings Selector
// ============================================

export function selectKeyBindings(context: AppMachineContext): KeyBindings | null {
  return context.keybindings;
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

/**
 * Select whether layout transitions should be suppressed (command-based resize)
 */
export function selectSuppressLayoutTransition(context: AppMachineContext): boolean {
  return context.suppressLayoutTransition;
}

/**
 * Select stable React key overrides for panes.
 * Maps real pane tmuxId → placeholder ID it morphed from, so PaneLayout
 * can reuse the placeholder's React key and avoid unmount/remount flicker.
 */
export function selectPaneKeyOverrides(context: AppMachineContext): Record<string, string> {
  return context.paneKeyOverrides;
}

// Optimistic operations live in the TmuxStore (Tier 3) now. The `derived`
// snapshot already includes pending op patches, so selectors over
// `context.panes` / `context.windows` see optimistic state without any
// dedicated query. A "has pending op" flag is no longer needed by any UI
// component; if one is wanted later, expose it via the store's getModel().

// ============================================
// Command Mode Selectors
// ============================================

export function selectCommandMode(context: AppMachineContext) {
  return context.commandMode;
}

export function selectStatusMessage(context: AppMachineContext) {
  return context.statusMessage;
}

export function selectPrefixActive(context: AppMachineContext): boolean {
  return context.prefixActive;
}

export function selectActivePaneCopyMode(context: AppMachineContext): boolean {
  if (!context.activePaneId) return false;
  const pane = context.panes.find((p) => p.tmuxId === context.activePaneId);
  if (pane?.inMode) return true;
  if (context.copyModeStates[context.activePaneId]) return true;
  return false;
}

// ============================================
// Theme Selectors
// ============================================

export function selectThemeName(context: AppMachineContext): string {
  return context.themeName;
}

export function selectThemeMode(context: AppMachineContext): 'dark' | 'light' {
  return context.themeMode;
}

export function selectAvailableThemes(
  context: AppMachineContext,
): Array<{ name: string; displayName: string }> {
  return context.availableThemes;
}
