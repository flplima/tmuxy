/**
 * Pane Group State Management
 *
 * Groups are stored in tmux session environment variable TMUXY_GROUPS as JSON.
 * This provides:
 * - Persistence across app restarts
 * - Stable UUIDs that don't depend on pane IDs
 * - Single source of truth for group membership
 *
 * Window naming: __group_<uuid>_<index>
 * Environment: TMUXY_GROUPS = { groups: { <uuid>: { paneIds, activeIndex } } }
 */

export interface PaneGroupData {
  id: string; // UUID like "g_abc123"
  paneIds: string[]; // Ordered list of pane IDs in group
  activeIndex: number; // Which pane is currently visible
}

export interface TmuxyGroupsEnv {
  version: number; // Schema version for future migrations
  groups: Record<string, PaneGroupData>;
}

const ENV_KEY = 'TMUXY_GROUPS';
const CURRENT_VERSION = 1;

/**
 * Generate a short UUID for group IDs
 */
export function generateGroupId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'g_';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * Parse window name to extract group info
 * Format: __group_<uuid>_<index>
 */
export function parseGroupWindowName(name: string): { groupId: string; index: number } | null {
  const match = name.match(/^__group_([a-z0-9_]+)_(\d+)$/);
  if (!match) return null;
  return {
    groupId: match[1],
    index: parseInt(match[2], 10),
  };
}

/**
 * Generate window name for a group pane
 */
export function makeGroupWindowName(groupId: string, index: number): string {
  return `__group_${groupId}_${index}`;
}

/**
 * Check if a window name is a group window
 */
export function isGroupWindow(name: string): boolean {
  return name.startsWith('__group_');
}

/**
 * Parse TMUXY_GROUPS environment variable
 */
export function parseGroupsEnv(envValue: string | null): TmuxyGroupsEnv {
  if (!envValue) {
    return { version: CURRENT_VERSION, groups: {} };
  }

  try {
    const parsed = JSON.parse(envValue);
    // Validate and migrate if needed
    if (typeof parsed !== 'object' || !parsed.groups) {
      return { version: CURRENT_VERSION, groups: {} };
    }
    return {
      version: parsed.version || CURRENT_VERSION,
      groups: parsed.groups || {},
    };
  } catch {
    return { version: CURRENT_VERSION, groups: {} };
  }
}

/**
 * Serialize groups to JSON for tmux environment
 */
export function serializeGroupsEnv(data: TmuxyGroupsEnv): string {
  return JSON.stringify(data);
}

/**
 * Build tmux command to save groups to environment
 */
export function buildSaveGroupsCommand(data: TmuxyGroupsEnv): string {
  const json = serializeGroupsEnv(data);
  // Escape for tmux command - double quotes and backslashes
  const escaped = json.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `set-environment ${ENV_KEY} "${escaped}"`;
}

/**
 * Build tmux command to delete groups environment (for cleanup)
 */
export function buildDeleteGroupsCommand(): string {
  return `set-environment -u ${ENV_KEY}`;
}

/**
 * Build tmux command to read groups from environment
 */
export function buildLoadGroupsCommand(): string {
  return `show-environment ${ENV_KEY}`;
}

/**
 * Parse output from show-environment command
 */
export function parseShowEnvironmentOutput(output: string): string | null {
  // Output format: "TMUXY_GROUPS={...}" or "-TMUXY_GROUPS" if unset
  if (output.startsWith('-')) {
    return null;
  }
  const eqIndex = output.indexOf('=');
  if (eqIndex === -1) {
    return null;
  }
  return output.slice(eqIndex + 1).trim();
}

/**
 * Reconcile stored groups with actual tmux state
 * Removes references to panes that no longer exist
 */
export function reconcileGroups(
  stored: TmuxyGroupsEnv,
  existingPaneIds: Set<string>
): TmuxyGroupsEnv {
  const reconciled: TmuxyGroupsEnv = {
    version: stored.version,
    groups: {},
  };

  for (const [groupId, group] of Object.entries(stored.groups)) {
    // Filter to only panes that still exist
    const validPaneIds = group.paneIds.filter((id) => existingPaneIds.has(id));

    // Only keep group if it has 2+ panes
    if (validPaneIds.length >= 2) {
      // Adjust activeIndex if needed
      let activeIndex = group.activeIndex;
      if (activeIndex >= validPaneIds.length) {
        activeIndex = validPaneIds.length - 1;
      }

      reconciled.groups[groupId] = {
        id: groupId,
        paneIds: validPaneIds,
        activeIndex,
      };
    }
  }

  return reconciled;
}

/**
 * Find group containing a specific pane
 */
export function findGroupByPane(
  groups: TmuxyGroupsEnv,
  paneId: string
): PaneGroupData | null {
  for (const group of Object.values(groups.groups)) {
    if (group.paneIds.includes(paneId)) {
      return group;
    }
  }
  return null;
}

/**
 * Create a new group with two panes
 */
export function createGroup(
  groups: TmuxyGroupsEnv,
  paneId1: string,
  paneId2: string
): { groups: TmuxyGroupsEnv; groupId: string } {
  const groupId = generateGroupId();
  const newGroups: TmuxyGroupsEnv = {
    ...groups,
    groups: {
      ...groups.groups,
      [groupId]: {
        id: groupId,
        paneIds: [paneId1, paneId2],
        activeIndex: 0, // First pane is active
      },
    },
  };
  return { groups: newGroups, groupId };
}

/**
 * Add a pane to an existing group
 */
export function addPaneToGroup(
  groups: TmuxyGroupsEnv,
  groupId: string,
  paneId: string
): TmuxyGroupsEnv {
  const group = groups.groups[groupId];
  if (!group) return groups;

  // Don't add duplicates
  if (group.paneIds.includes(paneId)) return groups;

  return {
    ...groups,
    groups: {
      ...groups.groups,
      [groupId]: {
        ...group,
        paneIds: [...group.paneIds, paneId],
      },
    },
  };
}

/**
 * Remove a pane from its group
 */
export function removePaneFromGroup(
  groups: TmuxyGroupsEnv,
  paneId: string
): TmuxyGroupsEnv {
  const group = findGroupByPane(groups, paneId);
  if (!group) return groups;

  const newPaneIds = group.paneIds.filter((id) => id !== paneId);

  // If only 1 pane left, remove the group entirely
  if (newPaneIds.length < 2) {
    const { [group.id]: removed, ...remainingGroups } = groups.groups;
    return { ...groups, groups: remainingGroups };
  }

  // Adjust activeIndex if needed
  let activeIndex = group.activeIndex;
  const removedIndex = group.paneIds.indexOf(paneId);
  if (removedIndex <= activeIndex && activeIndex > 0) {
    activeIndex--;
  }
  if (activeIndex >= newPaneIds.length) {
    activeIndex = newPaneIds.length - 1;
  }

  return {
    ...groups,
    groups: {
      ...groups.groups,
      [group.id]: {
        ...group,
        paneIds: newPaneIds,
        activeIndex,
      },
    },
  };
}

/**
 * Set the active pane in a group
 */
export function setGroupActivePane(
  groups: TmuxyGroupsEnv,
  groupId: string,
  paneId: string
): TmuxyGroupsEnv {
  const group = groups.groups[groupId];
  if (!group) return groups;

  const index = group.paneIds.indexOf(paneId);
  if (index === -1) return groups;

  return {
    ...groups,
    groups: {
      ...groups.groups,
      [groupId]: {
        ...group,
        activeIndex: index,
      },
    },
  };
}

/**
 * Convert stored groups to the format used by the UI
 */
export function toUIGroups(
  stored: TmuxyGroupsEnv
): Record<string, { id: string; paneIds: string[]; activeIndex: number }> {
  const result: Record<string, { id: string; paneIds: string[]; activeIndex: number }> = {};

  for (const [groupId, group] of Object.entries(stored.groups)) {
    result[groupId] = {
      id: groupId,
      paneIds: group.paneIds,
      activeIndex: group.activeIndex,
    };
  }

  return result;
}
