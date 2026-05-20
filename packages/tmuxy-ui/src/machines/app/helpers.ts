/**
 * Helper functions for the app machine
 */

import type { ServerState } from '../../tmux/types';
import type { TmuxPane, TmuxWindow } from '../types';

/**
 * Parse a `command-prompt` command and extract -I (initial value), -p (prompt), and template.
 * Expands tmux format strings (#W, #S) from context.
 */
export function parseCommandPrompt(
  command: string,
  context: {
    windows: { id: string; name: string }[];
    activeWindowId: string | null;
    sessionName: string;
  },
): { prompt: string; initialValue: string; template: string | null } {
  let prompt = ':';
  let initialValue = '';
  let template: string | null = null;

  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }

  let i = tokens[0] === 'command-prompt' ? 1 : 0;
  while (i < tokens.length) {
    if (tokens[i] === '-I' && i + 1 < tokens.length) {
      initialValue = tokens[++i];
      i++;
    } else if (tokens[i] === '-p' && i + 1 < tokens.length) {
      prompt = tokens[++i];
      i++;
    } else if (tokens[i].startsWith('-')) {
      const flag = tokens[i];
      i++;
      if (/^-[tTFN]$/.test(flag) && i < tokens.length) {
        i++;
      }
    } else {
      template = tokens[i];
      i++;
    }
  }

  const activeWindow = context.windows.find((w) => w.id === context.activeWindowId);
  const windowName = activeWindow?.name ?? '';
  const expand = (s: string) => s.replace(/#W/g, windowName).replace(/#S/g, context.sessionName);

  initialValue = expand(initialValue);
  prompt = expand(prompt);

  return { prompt, initialValue, template };
}

/**
 * Parse a `display-message` command and extract the message text.
 * Returns null if -p flag is present (output mode — should go to tmux).
 */
export function parseDisplayMessage(command: string): string | null {
  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }

  let i = tokens[0] === 'display-message' ? 1 : 0;
  let hasOutputFlag = false;

  while (i < tokens.length) {
    if (tokens[i] === '-p') {
      hasOutputFlag = true;
      i++;
    } else if (tokens[i].startsWith('-')) {
      const flag = tokens[i];
      i++;
      if (/^-[tFc]$/.test(flag) && i < tokens.length) {
        i++;
      }
    } else {
      if (hasOutputFlag) return null;
      return tokens[i];
    }
  }

  return null;
}

export const STATUS_MESSAGE_DURATION = 5000;

/**
 * Convert snake_case object keys to camelCase
 */
export function camelize<T>(obj: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = obj[key];
    if (Array.isArray(value)) {
      result[camelKey] = value.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? camelize(item as Record<string, unknown>)
          : item,
      );
    } else if (value && typeof value === 'object') {
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
    windows: payload.windows
      .map((w) => normalizeWindow(camelize<TmuxWindow>(w as unknown as Record<string, unknown>)))
      .sort((a, b) => a.index - b.index),
    totalWidth: payload.total_width,
    totalHeight: payload.total_height,
    statusLine: payload.status_line,
  };
}

/**
 * Build pane groups from windows.
 *
 * Group windows carry @tmuxy-window-type=group plus a pane membership list
 * in @tmuxy-group-panes (e.g., ["%4","%6","%7"]). The membership list is the
 * group identity; multiple windows can mirror the same group.
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
    if (window.windowType !== 'group') continue;
    if (!window.groupPanes || window.groupPanes.length < 2) continue;

    const key = window.groupPanes.slice().sort().join(',');
    if (!seenGroups.has(key)) {
      seenGroups.set(key, window.groupPanes);
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
 * Normalize a window record decoded from the server: turn undefined optionals
 * into null, ensure booleans are booleans, and coerce string drawer/bg into
 * narrowed unions for downstream readers.
 */
function normalizeWindow(w: TmuxWindow): TmuxWindow {
  return {
    ...w,
    windowType: w.windowType ?? null,
    groupPanes: w.groupPanes ?? null,
    floatParent: w.floatParent ?? null,
    floatWidth: w.floatWidth ?? null,
    floatHeight: w.floatHeight ?? null,
    floatDrawer: w.floatDrawer ?? null,
    floatBg: w.floatBg ?? null,
    floatNoheader: Boolean(w.floatNoheader),
  };
}

/**
 * Build float pane states from float-typed windows.
 * Float metadata (drawer, backdrop, no-header) is sourced from @tmuxy-float-*
 * options on the window; each float window contains exactly one pane.
 */

import type { DrawerDirection, FloatBackdrop, FloatPaneState } from '../types';

export function buildFloatPanesFromWindows(
  windows: TmuxWindow[],
  panes: TmuxPane[],
  existingFloats: Record<string, FloatPaneState>,
  containerWidth: number,
  containerHeight: number,
  charWidth: number,
  charHeight: number,
): Record<string, FloatPaneState> {
  const floatPanes: Record<string, FloatPaneState> = {};

  for (const window of windows) {
    if (window.windowType !== 'float') continue;

    // A float window contains exactly one pane.
    const pane = panes.find((p) => p.windowId === window.id);
    if (!pane) continue;
    const paneId = pane.tmuxId;

    const drawer = (window.floatDrawer as DrawerDirection | null) ?? undefined;
    const backdrop = (window.floatBg as FloatBackdrop | null) ?? undefined;
    const hideHeader = window.floatNoheader || undefined;
    const existing = existingFloats[paneId];

    if (existing) {
      // Preserve existing dimensions but update flags from window options
      floatPanes[paneId] = { ...existing, drawer, backdrop, hideHeader };
    } else {
      // Default dimensions: use the pane's actual size (set by float-create
      // via resize-pane). Cap to leave margin around the container edges.
      const isHorizontalDrawer = drawer === 'left' || drawer === 'right';
      const isVerticalDrawer = drawer === 'top' || drawer === 'bottom';
      const defaultWidth = isVerticalDrawer
        ? containerWidth
        : Math.min(pane.width * charWidth, containerWidth - 100);
      const defaultHeight = isHorizontalDrawer
        ? containerHeight
        : Math.min(pane.height * charHeight, containerHeight - 100);
      floatPanes[paneId] = {
        paneId,
        width: defaultWidth,
        height: defaultHeight,
        drawer,
        backdrop,
        hideHeader,
      };
    }
  }

  return floatPanes;
}
