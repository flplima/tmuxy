import type {
  AppMachineContext,
  LogEntry,
  TmuxPane,
  PaneGroup,
  ResizeState,
  FloatPaneState,
  KeyBindings,
  SessionTreeNode,
  ServerInfo,
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

  // During resize: apply local preview based on pixelDelta
  const { paneId, handle, pixelDelta, originalPane, originalNeighbors } = resize;

  // Find the target pane in active window
  const targetPane = activePanes.find((p) => p.tmuxId === paneId);
  if (!targetPane) {
    return activePanes;
  }

  // Build a set of neighbor IDs for quick lookup
  const neighborIds = new Set(originalNeighbors.map((n) => n.tmuxId));
  // Map from neighbor ID to its original state
  const originalNeighborMap = new Map(originalNeighbors.map((n) => [n.tmuxId, n]));

  // Calculate delta in character units from pixel offset
  const deltaCols = Math.round(pixelDelta.x / charWidth);
  const deltaRows = Math.round(pixelDelta.y / charHeight);

  // Apply preview transformations to active window panes only
  return activePanes.map((pane) => {
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
 * Select all sessions on the current server for the sidebar sessions tree.
 * Populated on web + desktop by the `serversActor` poll; empty on the demo/v86
 * sandboxes.
 */
export function selectSessions(context: AppMachineContext): SessionTreeNode[] {
  return context.sessions;
}

/** Saved servers for the sidebar picker (desktop-only; empty on web). */
export function selectServerList(context: AppMachineContext): ServerInfo[] {
  return context.serverList;
}

/** Id of the server the desktop app is currently attached to. */
export function selectCurrentServerId(context: AppMachineContext): string {
  return context.currentServerId;
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

export function selectResize(context: AppMachineContext): ResizeState | null {
  return context.resize;
}

export function selectResizePixelDelta(context: AppMachineContext): { x: number; y: number } {
  return context.resize?.pixelDelta ?? { x: 0, y: 0 };
}

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
function selectPanePixelDimensionsUncached(
  context: AppMachineContext,
): Map<string, PanePixelDimensions> {
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
  selectPanePixelDimensionsUncached,
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
    const pane = context.panes.find((p) => p.tmuxId === paneId);
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

export function selectFloatPanes(context: AppMachineContext): FloatPaneState[] {
  return Object.values(context.floatPanes);
}

export function selectFloatPaneState(
  context: AppMachineContext,
  paneId: string,
): FloatPaneState | undefined {
  return context.floatPanes[paneId];
}

/**
 * Get all float panes (visible whenever they exist)
 */
export function selectVisibleFloatPanes(context: AppMachineContext): FloatPaneState[] {
  return Object.values(context.floatPanes);
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

export function selectBaseFontSize(context: AppMachineContext): number {
  return context.baseFontSize;
}
