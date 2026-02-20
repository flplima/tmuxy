/**
 * Helper functions for the app machine
 */

import type { ServerState } from '../../tmux/types';
import type { TmuxPane, TmuxWindow } from '../types';
import {
  isGroupWindow,
  parseGroupWindowName,
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
  };
}

/**
 * Build pane groups from window names.
 *
 * New window naming: __group_{paneNum1}-{paneNum2}-{paneNum3}
 * Example: __group_4-6-7 means group with panes %4, %6, %7
 *
 * Groups are derived entirely from window names — no env var needed.
 * The pane list in the name IS the group identity.
 */
export function buildGroupsFromWindows(
  windows: TmuxWindow[],
  panes: TmuxPane[],
  _activeWindowId: string | null,
): Record<string, { id: string; paneIds: string[] }> {
  const groups: Record<string, { id: string; paneIds: string[] }> = {};
  const existingPaneIds = new Set(panes.map((p) => p.tmuxId));

  // Track which groups we've already seen (by sorted key for dedup)
  const seenGroups = new Map<string, string[]>(); // sorted key -> ordered paneIds

  for (const window of windows) {
    if (!isGroupWindow(window.name)) continue;

    // Try new format: parse pane IDs from window name
    const parsed = parseGroupWindowName(window.name);
    if (parsed) {
      const key = parsed.paneIds.slice().sort().join(',');
      if (!seenGroups.has(key)) {
        // Preserve order from window name (= tab display order)
        seenGroups.set(key, parsed.paneIds);
      }
      continue;
    }

    // Try server-provided paneGroupPaneIds (for new-format windows)
    if (window.paneGroupPaneIds && window.paneGroupPaneIds.length >= 2) {
      const key = window.paneGroupPaneIds.slice().sort().join(',');
      if (!seenGroups.has(key)) {
        seenGroups.set(key, window.paneGroupPaneIds);
      }
    }
  }

  // Build groups, filtering dead panes
  for (const [key, orderedPaneIds] of seenGroups) {
    const validPaneIds = orderedPaneIds.filter((id) => existingPaneIds.has(id));

    if (validPaneIds.length >= 2) {
      groups[key] = {
        id: key,
        paneIds: validPaneIds,
      };
    }
  }

  return groups;
}


/**
 * Build float pane states from windows.
 * Float windows have the pattern: __float_{pane_num}
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
  existingFloats: Record<string, { paneId: string; width: number; height: number }>,
  containerWidth: number,
  containerHeight: number,
  charWidth: number,
  charHeight: number
): Record<string, { paneId: string; width: number; height: number }> {
  const floatPanes: Record<string, { paneId: string; width: number; height: number }> = {};

  for (const window of windows) {
    if (!window.isFloatWindow) continue;

    const paneId = parseFloatWindowPaneId(window.name);
    if (!paneId) continue;

    const pane = panes.find((p) => p.tmuxId === paneId);
    const existing = existingFloats[paneId];

    if (existing) {
      floatPanes[paneId] = existing;
    } else if (pane) {
      floatPanes[paneId] = {
        paneId,
        width: Math.min(pane.width * charWidth, containerWidth - 200),
        height: Math.min(pane.height * charHeight, containerHeight - 200),
      };
    }
  }

  return floatPanes;
}
