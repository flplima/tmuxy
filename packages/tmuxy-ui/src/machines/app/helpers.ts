/**
 * Helper functions for the app machine
 */

import type { ServerState, ServerPopup } from '../../tmux/types';
import type { TmuxPane, TmuxWindow, TmuxPopup, PaneGroupTransition } from '../types';
import { PANE_GROUP_TRANSITION_TIMEOUT } from '../types';

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
 * Build pane groups from window names.
 * Pane group windows have the pattern: __%{pane_id}_group_{n}
 * After a swap, the "parent" pane may be in a hidden window, so we need to
 * determine which pane is actually visible (in the active window).
 *
 * @param existingGroups - Previous groups to preserve paneIds from (handles swap case)
 * @param pendingTransitions - In-flight optimistic tab switches to respect
 */
export function buildGroupsFromWindows(
  windows: TmuxWindow[],
  panes: TmuxPane[],
  activeWindowId: string | null,
  existingGroups: Record<string, { id: string; paneIds: string[]; activeIndex: number }> = {},
  pendingTransitions: PaneGroupTransition[] = []
): Record<string, { id: string; paneIds: string[]; activeIndex: number }> {
  const groups: Record<string, { id: string; paneIds: string[]; activeIndex: number }> = {};

  // Find all pane group windows and group by parent pane
  const paneGroupWindowsByParent = new Map<string, TmuxWindow[]>();
  for (const window of windows) {
    if (window.isPaneGroupWindow && window.paneGroupParentPane) {
      const parentId = window.paneGroupParentPane;
      if (!paneGroupWindowsByParent.has(parentId)) {
        paneGroupWindowsByParent.set(parentId, []);
      }
      paneGroupWindowsByParent.get(parentId)!.push(window);
    }
  }

  // Build groups from pane group windows
  for (const [parentPaneId, paneGroupWindows] of paneGroupWindowsByParent) {
    // Sort by pane group index to maintain consistent ordering
    paneGroupWindows.sort((a, b) => (a.paneGroupIndex ?? 0) - (b.paneGroupIndex ?? 0));

    // Get existing group to preserve membership across swaps
    const existingGroup = existingGroups[parentPaneId];

    // Collect all panes that should be in this group:
    // 1. From existing group (preserves membership after swaps)
    // 2. Parent pane
    // 3. Panes currently in pane group windows
    const allPaneIds = new Set<string>();

    // Preserve existing membership (critical for swap tracking)
    if (existingGroup) {
      for (const paneId of existingGroup.paneIds) {
        // Only keep panes that still exist
        if (panes.some((p) => p.tmuxId === paneId)) {
          allPaneIds.add(paneId);
        }
      }
    }

    // Add parent pane
    if (panes.some((p) => p.tmuxId === parentPaneId)) {
      allPaneIds.add(parentPaneId);
    }

    // Add panes from pane group windows
    for (const paneGroupWindow of paneGroupWindows) {
      const paneInWindow = panes.find((p) => p.windowId === paneGroupWindow.id);
      if (paneInWindow) {
        allPaneIds.add(paneInWindow.tmuxId);
      }
    }

    // Build paneIds in stable order:
    // Index 0: parent pane (original pane that the group was created from)
    // Index 1+: other panes, using existing order if available
    const paneIds: string[] = [];

    // Add parent pane first (always at index 0)
    if (allPaneIds.has(parentPaneId)) {
      paneIds.push(parentPaneId);
      allPaneIds.delete(parentPaneId);
    }

    // Add remaining panes, preserving existing order when possible
    if (existingGroup) {
      for (const paneId of existingGroup.paneIds) {
        if (allPaneIds.has(paneId)) {
          paneIds.push(paneId);
          allPaneIds.delete(paneId);
        }
      }
    }

    // Add any new panes that weren't in the existing group
    for (const paneId of allPaneIds) {
      paneIds.push(paneId);
    }

    // Only create a group if there are multiple panes
    if (paneIds.length > 1) {
      // Check if there's a pending transition for this group
      const now = Date.now();
      const pendingTransition = pendingTransitions.find(
        (t) => t.groupId === parentPaneId && (now - t.initiatedAt) < PANE_GROUP_TRANSITION_TIMEOUT
      );

      // Find which pane is currently visible in tmux (server state)
      let serverActiveIndex = 0;
      for (let i = 0; i < paneIds.length; i++) {
        const pane = panes.find((p) => p.tmuxId === paneIds[i]);
        if (pane && pane.windowId === activeWindowId) {
          serverActiveIndex = i;
          break;
        }
      }

      // Determine final activeIndex:
      // - If pending transition exists and target matches server: confirmed, use server
      // - If pending transition exists and target differs: still transitioning, use pending target
      // - If no pending transition: use server state
      let activeIndex = serverActiveIndex;
      if (pendingTransition) {
        const pendingTargetIndex = paneIds.indexOf(pendingTransition.targetPaneId);
        if (pendingTargetIndex !== -1) {
          if (serverActiveIndex === pendingTargetIndex) {
            // Server confirmed our transition
            activeIndex = serverActiveIndex;
          } else {
            // Still transitioning, keep optimistic state
            activeIndex = pendingTargetIndex;
          }
        }
      }

      groups[parentPaneId] = {
        id: parentPaneId,
        paneIds,
        activeIndex,
      };
    }
  }

  return groups;
}

/**
 * Reconcile pending group transitions after a state update.
 * Removes transitions that are:
 * - Confirmed: server state matches the target
 * - Timed out: transition took too long
 * - Orphaned: group no longer exists
 *
 * @returns Updated pending transitions array
 */
export function reconcilePendingTransitions(
  pendingTransitions: PaneGroupTransition[],
  groups: Record<string, { id: string; paneIds: string[]; activeIndex: number }>,
  panes: TmuxPane[],
  activeWindowId: string | null
): PaneGroupTransition[] {
  const now = Date.now();

  return pendingTransitions.filter((transition) => {
    // Remove timed out transitions
    if (now - transition.initiatedAt >= PANE_GROUP_TRANSITION_TIMEOUT) {
      return false;
    }

    // Remove if group no longer exists
    const group = groups[transition.groupId];
    if (!group) {
      return false;
    }

    // Remove if target pane no longer in group
    if (!group.paneIds.includes(transition.targetPaneId)) {
      return false;
    }

    // Check if server has confirmed this transition
    // (target pane is now in the active window)
    const targetPane = panes.find((p) => p.tmuxId === transition.targetPaneId);
    if (targetPane && targetPane.windowId === activeWindowId) {
      // Server confirmed - remove the pending transition
      return false;
    }

    // Transition still pending
    return true;
  });
}

/**
 * Build float pane states from windows.
 * Float windows have the pattern: __float_{pane_num}
 * Preserves existing float positions/state for panes that are still float windows.
 *
 * @param existingFloats - Previous float states to preserve positions from
 */
/**
 * Parse pane ID from float window name.
 * Float windows have the pattern: __float_{pane_num}
 * Example: __float_5 -> %5
 */
function parseFloatWindowPaneId(windowName: string): string | null {
  const match = windowName.match(/^__float_(\d+)$/);
  if (match) {
    return `%${match[1]}`;
  }
  return null;
}

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
    if (!window.isFloatWindow) continue;

    // Parse pane ID from window name (e.g., __float_5 -> %5)
    const paneId = parseFloatWindowPaneId(window.name);
    if (!paneId) continue;

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
