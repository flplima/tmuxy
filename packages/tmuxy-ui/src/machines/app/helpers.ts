/**
 * Helper functions for the app machine
 */

import type { ServerState, ServerPopup } from '../../tmux/types';
import type { TmuxPane, TmuxWindow, TmuxPopup } from '../types';

/**
 * Convert snake_case object keys to camelCase
 */
export function camelize<T>(obj: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[camelKey] = camelize(value as Record<string, unknown>);
    } else {
      result[camelKey] = value;
    }
  }
  return result as T;
}

/**
 * Transform server popup to client format
 */
export function transformServerPopup(popup: ServerPopup | null | undefined): TmuxPopup | null {
  if (!popup) return null;
  return {
    id: popup.id,
    content: popup.content,
    cursorX: popup.cursor_x,
    cursorY: popup.cursor_y,
    width: popup.width,
    height: popup.height,
    x: popup.x,
    y: popup.y,
    active: popup.active,
    command: popup.command,
  };
}

/**
 * Transform server state to client format
 */
export function transformServerState(payload: ServerState): {
  sessionName: string;
  activeWindowId: string | null;
  activePaneId: string | null;
  panes: TmuxPane[];
  windows: TmuxWindow[];
  totalWidth: number;
  totalHeight: number;
  statusLine: string;
  popup: TmuxPopup | null;
} {
  return {
    sessionName: payload.session_name,
    activeWindowId: payload.active_window_id,
    activePaneId: payload.active_pane_id,
    panes: payload.panes.map((p) => camelize<TmuxPane>(p as unknown as Record<string, unknown>)),
    windows: payload.windows.map((w) => camelize<TmuxWindow>(w as unknown as Record<string, unknown>)),
    totalWidth: payload.total_width,
    totalHeight: payload.total_height,
    statusLine: payload.status_line,
    popup: transformServerPopup(payload.popup),
  };
}

/**
 * Build stacks from window names.
 * Stack windows have the pattern: __%{pane_id}_stack_{n}
 * After a swap, the "parent" pane may be in a hidden window, so we need to
 * determine which pane is actually visible (in the active window).
 *
 * @param existingStacks - Previous stacks to preserve paneIds from (handles swap case)
 */
export function buildStacksFromWindows(
  windows: TmuxWindow[],
  panes: TmuxPane[],
  activeWindowId: string | null,
  existingStacks: Record<string, { id: string; paneIds: string[]; activeIndex: number }> = {}
): Record<string, { id: string; paneIds: string[]; activeIndex: number }> {
  const stacks: Record<string, { id: string; paneIds: string[]; activeIndex: number }> = {};

  // Find all stack windows and group by parent pane
  const stackWindowsByParent = new Map<string, TmuxWindow[]>();
  for (const window of windows) {
    if (window.isStackWindow && window.stackParentPane) {
      const parentId = window.stackParentPane;
      if (!stackWindowsByParent.has(parentId)) {
        stackWindowsByParent.set(parentId, []);
      }
      stackWindowsByParent.get(parentId)!.push(window);
    }
  }

  // Build stacks from grouped windows
  for (const [parentPaneId, stackWindows] of stackWindowsByParent) {
    // Sort by stack index
    stackWindows.sort((a, b) => (a.stackIndex ?? 0) - (b.stackIndex ?? 0));

    // Get existing stack paneIds if available (preserves membership across swaps)
    const existingStack = existingStacks[parentPaneId];
    const existingPaneIds = existingStack?.paneIds || [];

    // Collect ALL panes that are part of this stack
    // Sources: existing membership + parent + panes in stack windows
    const allStackPaneIds = new Set<string>(existingPaneIds);
    allStackPaneIds.add(parentPaneId);

    for (const stackWindow of stackWindows) {
      const paneInWindow = panes.find((p) => p.windowId === stackWindow.id);
      if (paneInWindow) {
        allStackPaneIds.add(paneInWindow.tmuxId);
      }
    }

    // Remove any panes that no longer exist
    const validPaneIds = [...allStackPaneIds].filter((id) => panes.some((p) => p.tmuxId === id));

    // Find which pane is currently visible (in the active window)
    let visiblePaneId: string | null = null;
    for (const paneId of validPaneIds) {
      const pane = panes.find((p) => p.tmuxId === paneId);
      if (pane && pane.windowId === activeWindowId) {
        visiblePaneId = paneId;
        break;
      }
    }

    // Build paneIds array: visible pane first, then hidden panes
    const paneIds: string[] = [];

    // First, add the visible pane (the one in active window)
    if (visiblePaneId) {
      paneIds.push(visiblePaneId);
    } else if (validPaneIds.length > 0) {
      // Fallback: use first valid pane
      paneIds.push(validPaneIds[0]);
    }

    // Then add the rest (hidden panes), avoiding duplicates
    for (const paneId of validPaneIds) {
      if (!paneIds.includes(paneId)) {
        paneIds.push(paneId);
      }
    }

    // Only create a stack if there are multiple panes
    if (paneIds.length > 1) {
      // The visible pane is always at index 0 (we put it first)
      stacks[parentPaneId] = {
        id: parentPaneId,
        paneIds,
        activeIndex: 0,
      };
    }
  }

  return stacks;
}

/**
 * Build float pane states from windows.
 * Float windows have the pattern: __float_{pane_num}
 * Preserves existing float positions/state for panes that are still float windows.
 *
 * @param existingFloats - Previous float states to preserve positions from
 */
export function buildFloatPanesFromWindows(
  windows: TmuxWindow[],
  panes: TmuxPane[],
  existingFloats: Record<string, { paneId: string; x: number; y: number; width: number; height: number; pinned: boolean }> = {},
  containerWidth: number,
  containerHeight: number,
  charWidth: number,
  charHeight: number
): Record<string, { paneId: string; x: number; y: number; width: number; height: number; pinned: boolean }> {
  const floatPanes: Record<string, { paneId: string; x: number; y: number; width: number; height: number; pinned: boolean }> = {};

  for (const window of windows) {
    if (!window.isFloatWindow || !window.floatPaneId) continue;

    const paneId = window.floatPaneId;
    const pane = panes.find((p) => p.tmuxId === paneId);

    // Check if we have existing state for this float
    const existing = existingFloats[paneId];

    if (existing) {
      // Preserve existing position and state
      floatPanes[paneId] = existing;
    } else if (pane) {
      // Initialize new float with default position
      floatPanes[paneId] = {
        paneId,
        x: 100,
        y: 100,
        width: Math.min(pane.width * charWidth, containerWidth - 200),
        height: Math.min(pane.height * charHeight, containerHeight - 200),
        pinned: false,
      };
    }
  }

  return floatPanes;
}
