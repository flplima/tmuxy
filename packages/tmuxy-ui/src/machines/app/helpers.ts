/**
 * Helper functions for the app machine
 */

import type { ServerState, ServerPopup } from '../../tmux/types';
import type { TmuxPane, TmuxWindow, TmuxPopup, PaneGroupTransition } from '../types';
import { PANE_GROUP_TRANSITION_TIMEOUT } from '../types';
import {
  type TmuxyGroupsEnv,
  type PaneGroupData,
  parseGroupsEnv,
  reconcileGroups,
  isGroupWindow,
  parseGroupWindowName,
  generateGroupId,
  makeGroupWindowName,
  buildSaveGroupsCommand,
  toUIGroups,
} from './groupState';

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
 *
 * Supports two window naming patterns:
 * 1. Legacy: __%{pane_id}_group_{n} - old pattern keyed by pane ID
 * 2. New: __group_{uuid}_{n} - UUID-based pattern for stable group identity
 *
 * After a swap, the "parent" pane may be in a hidden window, so we need to
 * determine which pane is actually visible (in the active window).
 *
 * @param existingGroups - Previous groups to preserve paneIds from (handles swap case)
 * @param pendingTransitions - In-flight optimistic tab switches to respect
 * @param groupsEnv - Stored group state from tmux environment (UUID-based groups)
 */
export function buildGroupsFromWindows(
  windows: TmuxWindow[],
  panes: TmuxPane[],
  activeWindowId: string | null,
  existingGroups: Record<string, { id: string; paneIds: string[]; activeIndex: number }> = {},
  pendingTransitions: PaneGroupTransition[] = [],
  groupsEnv?: TmuxyGroupsEnv
): Record<string, { id: string; paneIds: string[]; activeIndex: number }> {
  const groups: Record<string, { id: string; paneIds: string[]; activeIndex: number }> = {};

  // Map from window to group info (either legacy or UUID-based)
  interface GroupWindowInfo {
    groupId: string;
    index: number;
    isUuidBased: boolean;
  }
  const groupWindowInfoMap = new Map<string, GroupWindowInfo>();

  // Parse all group windows (both legacy and UUID-based)
  for (const window of windows) {
    // Check for UUID-based naming first: __group_{uuid}_{index}
    const uuidMatch = parseGroupWindowName(window.name);
    if (uuidMatch) {
      groupWindowInfoMap.set(window.id, {
        groupId: uuidMatch.groupId,
        index: uuidMatch.index,
        isUuidBased: true,
      });
      continue;
    }

    // Fall back to legacy naming: __%{pane_id}_group_{n}
    if (window.isPaneGroupWindow && window.paneGroupParentPane) {
      groupWindowInfoMap.set(window.id, {
        groupId: window.paneGroupParentPane,
        index: window.paneGroupIndex ?? 0,
        isUuidBased: false,
      });
    }
  }

  // Group windows by groupId
  const windowsByGroup = new Map<string, { window: TmuxWindow; info: GroupWindowInfo }[]>();
  for (const window of windows) {
    const info = groupWindowInfoMap.get(window.id);
    if (info) {
      if (!windowsByGroup.has(info.groupId)) {
        windowsByGroup.set(info.groupId, []);
      }
      windowsByGroup.get(info.groupId)!.push({ window, info });
    }
  }

  // Build groups
  for (const [groupId, groupWindows] of windowsByGroup) {
    // Sort by index to maintain consistent ordering
    groupWindows.sort((a, b) => a.info.index - b.info.index);

    const isUuidBased = groupWindows[0]?.info.isUuidBased ?? false;

    // Get stored group data from groupsEnv if UUID-based
    const storedGroup = isUuidBased && groupsEnv ? groupsEnv.groups[groupId] : null;

    // Get existing UI group to preserve membership across swaps
    const existingGroup = existingGroups[groupId];

    // Collect all panes that should be in this group
    const allPaneIds = new Set<string>();

    // For UUID-based groups, start with stored panes
    if (storedGroup) {
      for (const paneId of storedGroup.paneIds) {
        if (panes.some((p) => p.tmuxId === paneId)) {
          allPaneIds.add(paneId);
        }
      }
    }

    // Preserve existing membership (critical for swap tracking)
    if (existingGroup) {
      for (const paneId of existingGroup.paneIds) {
        if (panes.some((p) => p.tmuxId === paneId)) {
          allPaneIds.add(paneId);
        }
      }
    }

    // Add panes from group windows
    for (const { window } of groupWindows) {
      const paneInWindow = panes.find((p) => p.windowId === window.id);
      if (paneInWindow) {
        allPaneIds.add(paneInWindow.tmuxId);
      }
    }

    // For legacy groups, also add the parent pane
    if (!isUuidBased) {
      if (panes.some((p) => p.tmuxId === groupId)) {
        allPaneIds.add(groupId);
      }
    }

    // Build paneIds in stable order
    const paneIds: string[] = [];

    // For stored groups, use stored order first
    if (storedGroup) {
      for (const paneId of storedGroup.paneIds) {
        if (allPaneIds.has(paneId)) {
          paneIds.push(paneId);
          allPaneIds.delete(paneId);
        }
      }
    }

    // Then existing UI group order
    if (existingGroup) {
      for (const paneId of existingGroup.paneIds) {
        if (allPaneIds.has(paneId)) {
          paneIds.push(paneId);
          allPaneIds.delete(paneId);
        }
      }
    }

    // For legacy groups, add parent pane first if not already added
    if (!isUuidBased && allPaneIds.has(groupId)) {
      paneIds.unshift(groupId);
      allPaneIds.delete(groupId);
    }

    // Add any remaining new panes
    for (const paneId of allPaneIds) {
      paneIds.push(paneId);
    }

    // Only create a group if there are multiple panes
    if (paneIds.length > 1) {
      // Check if there's a pending transition for this group
      const now = Date.now();
      const pendingTransition = pendingTransitions.find(
        (t) => t.groupId === groupId && (now - t.initiatedAt) < PANE_GROUP_TRANSITION_TIMEOUT
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
      // - If no pending transition: use server state (or stored state for UUID-based)
      let activeIndex = serverActiveIndex;

      // For UUID-based groups, prefer stored activeIndex if server hasn't confirmed a change
      if (storedGroup && !pendingTransition) {
        // Use stored activeIndex if it's valid
        if (storedGroup.activeIndex < paneIds.length) {
          activeIndex = storedGroup.activeIndex;
        }
      }

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

      groups[groupId] = {
        id: groupId,
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

// ============================================
// UUID-based Group State Management
// ============================================

/**
 * Migrate legacy window-name-based groups to UUID-based groups.
 * Creates a new TmuxyGroupsEnv from the old-style groups.
 *
 * Old format: window name `__%{paneId}_group_{n}` → group keyed by paneId
 * New format: window name `__group_{uuid}_{n}` → group keyed by UUID
 */
export function migrateGroupsToEnv(
  legacyGroups: Record<string, { id: string; paneIds: string[]; activeIndex: number }>,
  existingEnv: TmuxyGroupsEnv
): TmuxyGroupsEnv {
  const newEnv: TmuxyGroupsEnv = { ...existingEnv };

  for (const [_legacyId, group] of Object.entries(legacyGroups)) {
    // Check if this group is already in the env (by checking if panes match)
    const existingGroup = Object.values(newEnv.groups).find(
      (g) => g.paneIds.length === group.paneIds.length &&
        g.paneIds.every((id) => group.paneIds.includes(id))
    );

    if (!existingGroup) {
      // Create new UUID-based group
      const newGroupId = generateGroupId();
      newEnv.groups[newGroupId] = {
        id: newGroupId,
        paneIds: [...group.paneIds],
        activeIndex: group.activeIndex,
      };
    }
  }

  return newEnv;
}

/**
 * Create a new group with a UUID and return the group ID.
 * This is used when adding a pane to a group.
 */
export function createNewGroup(
  existingEnv: TmuxyGroupsEnv,
  paneId1: string,
  paneId2: string
): { env: TmuxyGroupsEnv; groupId: string; saveCommand: string } {
  const groupId = generateGroupId();
  const newEnv: TmuxyGroupsEnv = {
    ...existingEnv,
    groups: {
      ...existingEnv.groups,
      [groupId]: {
        id: groupId,
        paneIds: [paneId1, paneId2],
        activeIndex: 0,
      },
    },
  };

  return {
    env: newEnv,
    groupId,
    saveCommand: buildSaveGroupsCommand(newEnv),
  };
}

/**
 * Add a pane to an existing group.
 */
export function addPaneToExistingGroup(
  existingEnv: TmuxyGroupsEnv,
  groupId: string,
  newPaneId: string
): { env: TmuxyGroupsEnv; saveCommand: string } {
  const group = existingEnv.groups[groupId];
  if (!group) {
    return { env: existingEnv, saveCommand: '' };
  }

  const newEnv: TmuxyGroupsEnv = {
    ...existingEnv,
    groups: {
      ...existingEnv.groups,
      [groupId]: {
        ...group,
        paneIds: [...group.paneIds, newPaneId],
      },
    },
  };

  return {
    env: newEnv,
    saveCommand: buildSaveGroupsCommand(newEnv),
  };
}

/**
 * Update the active pane in a group.
 */
export function updateGroupActivePane(
  existingEnv: TmuxyGroupsEnv,
  groupId: string,
  activePaneId: string
): { env: TmuxyGroupsEnv; saveCommand: string } {
  const group = existingEnv.groups[groupId];
  if (!group) {
    return { env: existingEnv, saveCommand: '' };
  }

  const newIndex = group.paneIds.indexOf(activePaneId);
  if (newIndex === -1) {
    return { env: existingEnv, saveCommand: '' };
  }

  const newEnv: TmuxyGroupsEnv = {
    ...existingEnv,
    groups: {
      ...existingEnv.groups,
      [groupId]: {
        ...group,
        activeIndex: newIndex,
      },
    },
  };

  return {
    env: newEnv,
    saveCommand: buildSaveGroupsCommand(newEnv),
  };
}

/**
 * Remove a pane from its group.
 * If only one pane remains, the group is deleted.
 */
export function removePaneFromGroup(
  existingEnv: TmuxyGroupsEnv,
  paneId: string
): { env: TmuxyGroupsEnv; saveCommand: string; removedGroupId: string | null } {
  // Find the group containing this pane
  const groupEntry = Object.entries(existingEnv.groups).find(
    ([, group]) => group.paneIds.includes(paneId)
  );

  if (!groupEntry) {
    return { env: existingEnv, saveCommand: '', removedGroupId: null };
  }

  const [groupId, group] = groupEntry;
  const newPaneIds = group.paneIds.filter((id) => id !== paneId);

  // If only 1 pane left, remove the group
  if (newPaneIds.length < 2) {
    const { [groupId]: removed, ...remainingGroups } = existingEnv.groups;
    const newEnv: TmuxyGroupsEnv = {
      ...existingEnv,
      groups: remainingGroups,
    };
    return {
      env: newEnv,
      saveCommand: buildSaveGroupsCommand(newEnv),
      removedGroupId: groupId,
    };
  }

  // Adjust activeIndex if needed
  let newActiveIndex = group.activeIndex;
  const removedIndex = group.paneIds.indexOf(paneId);
  if (removedIndex <= newActiveIndex && newActiveIndex > 0) {
    newActiveIndex--;
  }
  if (newActiveIndex >= newPaneIds.length) {
    newActiveIndex = newPaneIds.length - 1;
  }

  const newEnv: TmuxyGroupsEnv = {
    ...existingEnv,
    groups: {
      ...existingEnv.groups,
      [groupId]: {
        ...group,
        paneIds: newPaneIds,
        activeIndex: newActiveIndex,
      },
    },
  };

  return {
    env: newEnv,
    saveCommand: buildSaveGroupsCommand(newEnv),
    removedGroupId: null,
  };
}

/**
 * Find the group containing a specific pane.
 */
export function findGroupForPane(
  env: TmuxyGroupsEnv,
  paneId: string
): PaneGroupData | null {
  for (const group of Object.values(env.groups)) {
    if (group.paneIds.includes(paneId)) {
      return group;
    }
  }
  return null;
}

/**
 * Reconcile stored groups with actual tmux state.
 * Removes references to panes that no longer exist.
 */
export function reconcileGroupsWithPanes(
  env: TmuxyGroupsEnv,
  existingPaneIds: string[]
): { env: TmuxyGroupsEnv; changed: boolean; saveCommand: string } {
  const paneIdSet = new Set(existingPaneIds);
  const reconciledEnv = reconcileGroups(env, paneIdSet);

  // Check if anything changed
  const changed = JSON.stringify(env.groups) !== JSON.stringify(reconciledEnv.groups);

  return {
    env: reconciledEnv,
    changed,
    saveCommand: changed ? buildSaveGroupsCommand(reconciledEnv) : '',
  };
}

// Re-export types and functions from groupState
export { parseGroupsEnv, toUIGroups, makeGroupWindowName, isGroupWindow, parseGroupWindowName };
export type { TmuxyGroupsEnv, PaneGroupData };
