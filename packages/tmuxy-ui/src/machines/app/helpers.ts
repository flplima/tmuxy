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

// Shared id for the delayed CLEAR_STATUS_MESSAGE raise. Re-scheduling with the
// same id (after cancel) means a newer status message restarts the window
// instead of the previous message's timer clearing it early — the actor owns
// the timer, so it is cancelled automatically when the machine stops.
export const STATUS_MESSAGE_CLEAR_ID = 'statusMessageClear';

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
 * Build pane groups from panes.
 *
 * Group membership is intrinsic to each pane via `@tmuxy-group-id` (e.g. `g5`) —
 * the visible member (a real pane in the active session) and each hidden member
 * (a stub emitted from the stash session) all carry the same id. A group is any
 * id shared by two or more panes; members are ordered by pane-id number so the
 * tab order is stable and matches the shell navigation helpers.
 */
export function buildGroupsFromPanes(
  panes: TmuxPane[],
): Record<string, { id: string; paneIds: string[] }> {
  const byGroup = new Map<string, string[]>();
  for (const pane of panes) {
    if (!pane.groupId) continue;
    const list = byGroup.get(pane.groupId) ?? [];
    list.push(pane.tmuxId);
    byGroup.set(pane.groupId, list);
  }

  const paneNumber = (id: string) => parseInt(id.replace(/^%/, ''), 10) || 0;

  const groups: Record<string, { id: string; paneIds: string[] }> = {};
  for (const [gid, paneIds] of byGroup) {
    if (paneIds.length < 2) continue;
    groups[gid] = {
      id: gid,
      paneIds: paneIds.slice().sort((a, b) => paneNumber(a) - paneNumber(b)),
    };
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
    floatParent: w.floatParent ?? null,
    floatWidth: w.floatWidth ?? null,
    floatHeight: w.floatHeight ?? null,
    floatDrawer: w.floatDrawer ?? null,
    floatBg: w.floatBg ?? null,
    floatNoheader: Boolean(w.floatNoheader),
    zoomed: Boolean(w.zoomed),
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
    // @tmuxy-float-width/height (in cells) are the float's REQUESTED size —
    // authoritative when present. The pane's tmux size is only a fallback: a
    // single-pane float window can't be shrunk by resize-pane, so on some
    // backends the pane stays session-sized even though the user asked for a
    // 40-col float.
    const metaWidth = window.floatWidth ? window.floatWidth * charWidth : null;
    const metaHeight = window.floatHeight ? window.floatHeight * charHeight : null;
    const existing = existingFloats[paneId];

    if (existing) {
      // Preserve pane-derived dimensions (avoids churn as the underlying pane
      // resizes) but let explicit size metadata and flags win.
      floatPanes[paneId] = {
        ...existing,
        width: metaWidth ?? existing.width,
        height: metaHeight ?? existing.height,
        drawer,
        backdrop,
        hideHeader,
      };
    } else {
      // Default dimensions: requested size, else the pane's actual size. Cap
      // to leave margin around the container edges.
      const isHorizontalDrawer = drawer === 'left' || drawer === 'right';
      const isVerticalDrawer = drawer === 'top' || drawer === 'bottom';
      const defaultWidth = isVerticalDrawer
        ? containerWidth
        : (metaWidth ?? Math.min(pane.width * charWidth, containerWidth - 100));
      const defaultHeight = isHorizontalDrawer
        ? containerHeight
        : (metaHeight ?? Math.min(pane.height * charHeight, containerHeight - 100));
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
