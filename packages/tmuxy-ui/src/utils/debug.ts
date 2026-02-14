/**
 * Debug utilities - getSnapshot() and getTmuxSnapshot() for comparing UI vs tmux content
 */

import type { TmuxPane, TmuxWindow } from '../tmux/types';
import type { PaneGroup, FloatPaneState } from '../machines/types';

interface AppState {
  panes: TmuxPane[];
  windows: TmuxWindow[];
  paneGroups: Record<string, PaneGroup>;
  floatPanes: Record<string, FloatPaneState>;
  activeWindowId: string | null;
  totalWidth: number;
  totalHeight: number;
  statusLine: string;
}

// Extend window with debug helpers
declare global {
  interface Window {
    getSnapshot: () => string[];
    getTmuxSnapshot: () => Promise<string[]>;
    // XState actor reference (dev mode only, set in AppContext.tsx)
    app?: {
      getSnapshot: () => { context: AppState };
      send: (event: unknown) => void;
      subscribe: (callback: (snapshot: { context: AppState }) => void) => { unsubscribe: () => void };
    };
  }
}

/**
 * Extract text lines from a pane's DOM terminal-line elements.
 * Returns array of strings, one per line.
 */
function extractPaneLines(paneId: string): string[] {
  const paneEl = document.querySelector(`[data-pane-id="${paneId}"]`);
  if (!paneEl) return [];

  const terminalContent = paneEl.querySelector('.terminal-content');
  if (!terminalContent) return [];

  const lineElements = terminalContent.querySelectorAll('.terminal-line');
  const lines: string[] = [];

  lineElements.forEach((lineEl) => {
    let lineText = '';
    const spans = lineEl.querySelectorAll('span');
    if (spans.length > 0) {
      spans.forEach((span) => {
        lineText += span.textContent || '';
      });
    } else {
      lineText = lineEl.textContent || '';
    }
    lines.push(lineText);
  });

  return lines;
}

/**
 * Extract status line text from DOM (strips ANSI by reading textContent)
 */
function extractStatusLineFromDom(): string {
  const el = document.querySelector('.tmux-status-bar-content');
  return el?.textContent || '';
}

/**
 * Format a pane border header line: ─ + borderTitle + ─ padding to fill width
 */
function formatBorderHeader(borderTitle: string, width: number): string {
  // tmux trims trailing spaces only when keeping them would leave fewer than 2
  // trailing ─ characters. This ensures at least ── at the end of the header.
  let title = borderTitle;
  const remainingWithSpaces = width - 2 - title.length;
  if (remainingWithSpaces < 2) {
    title = title.trimEnd();
  }
  // tmux renders: two ─, then the title, then at least 2 trailing ─ to fill width
  const minTrailing = 2;
  const maxTitleLen = width - 2 - minTrailing;
  if (maxTitleLen <= 0) {
    return '─'.repeat(width);
  }
  if (title.length > maxTitleLen) {
    title = title.slice(0, maxTitleLen);
  }
  const remaining = width - 2 - title.length;
  return '──' + title + '─'.repeat(remaining);
}

/**
 * Build a full-screen snapshot from the UI DOM, matching tmux's rendered output.
 * Returns an array of strings where each string is one full row.
 *
 * The tmux coordinate system (with pane-border-status top):
 *   Row 0: pane border header (panes start at y=1)
 *   Rows 1..N: pane content with │ at vertical dividers
 *   Horizontal divider rows (between stacked panes) with ├/┤/┼ junctions
 *   Last row: status line (appended after totalHeight)
 */
function buildSnapshot(): string[] {
  const state = window.app?.getSnapshot()?.context;
  if (!state) return ['Error: No app state available (window.app not set)'];

  const { panes, paneGroups, floatPanes, activeWindowId, totalWidth, totalHeight, statusLine } = state;
  if (!panes || panes.length === 0) return ['Error: No panes'];

  // Filter to visible panes in the active window
  const winId = activeWindowId || panes.find(p => p.active)?.windowId || panes[0]?.windowId;
  let visiblePanes = panes.filter(p => p.windowId === winId);

  // Exclude float panes (they're rendered in separate modal overlay)
  if (floatPanes && Object.keys(floatPanes).length > 0) {
    const floatPaneIds = new Set(Object.keys(floatPanes));
    visiblePanes = visiblePanes.filter(p => !floatPaneIds.has(p.tmuxId));
  }

  // Exclude non-active group members (active = in active window)
  if (paneGroups) {
    const hiddenGroupPaneIds = new Set<string>();
    for (const group of Object.values(paneGroups)) {
      // Find which group pane is in the active window
      const activePaneId = group.paneIds.find(paneId => {
        const pane = panes.find(p => p.tmuxId === paneId);
        return pane?.windowId === winId;
      });
      for (const paneId of group.paneIds) {
        if (paneId !== activePaneId) {
          hiddenGroupPaneIds.add(paneId);
        }
      }
    }
    if (hiddenGroupPaneIds.size > 0) {
      visiblePanes = visiblePanes.filter(p => !hiddenGroupPaneIds.has(p.tmuxId));
    }
  }

  if (visiblePanes.length === 0) return ['Error: No visible panes after filtering'];

  // Grid: totalHeight rows for pane area + 1 row for status line
  const gridHeight = totalHeight + 1;
  const grid: string[][] = Array.from({ length: gridHeight }, () =>
    Array(totalWidth).fill(' ')
  );

  // Check if cell (r, c) is covered by any pane
  function findPane(r: number, c: number): TmuxPane | undefined {
    return visiblePanes.find(p =>
      c >= p.x && c < p.x + p.width && r >= p.y && r < p.y + p.height
    );
  }

  // Check if cell (r, c) is a vertical divider (panes on both sides in the same row)
  function isVerticalDivider(r: number, c: number): boolean {
    const hasLeft = visiblePanes.some(p =>
      p.x + p.width === c && r >= p.y && r < p.y + p.height
    );
    const hasRight = visiblePanes.some(p =>
      p.x === c + 1 && r >= p.y && r < p.y + p.height
    );
    return hasLeft && hasRight;
  }

  // Find the pane that starts just below a divider row
  function findPaneBelowDivider(r: number, c: number): TmuxPane | undefined {
    return visiblePanes.find(p =>
      c >= p.x && c < p.x + p.width && p.y === r + 1
    );
  }

  // Extract pane content from DOM
  const paneContentMap = new Map<string, string[]>();
  for (const pane of visiblePanes) {
    paneContentMap.set(pane.tmuxId, extractPaneLines(pane.tmuxId));
  }

  // --- Build all rows 0..totalHeight-1 ---
  for (let r = 0; r < totalHeight; r++) {
    for (let c = 0; c < totalWidth; c++) {
      const pane = findPane(r, c);
      if (pane) {
        // Pane content cell
        const lines = paneContentMap.get(pane.tmuxId) || [];
        const lineIdx = r - pane.y;
        const colIdx = c - pane.x;
        const line = lines[lineIdx] || '';
        grid[r][c] = colIdx < line.length ? line[colIdx] : ' ';
      } else if (isVerticalDivider(r, c)) {
        // Vertical divider - check for horizontal junctions
        const hLeft = c > 0 && !findPane(r, c - 1) && !isVerticalDivider(r, c - 1);
        const hRight = c < totalWidth - 1 && !findPane(r, c + 1) && !isVerticalDivider(r, c + 1);

        if (hLeft || hRight) {
          // Junction with horizontal divider
          const hasAbove = r > 0 && isVerticalDivider(r - 1, c);
          const hasBelow = r < totalHeight - 1 && isVerticalDivider(r + 1, c);
          if (!hasAbove && hasBelow) grid[r][c] = '┬';
          else if (hasAbove && !hasBelow) grid[r][c] = '┴';
          else if (hLeft && hRight) grid[r][c] = '┼';
          else if (hRight) grid[r][c] = '├';
          else grid[r][c] = '┤';
        } else {
          grid[r][c] = '│';
        }
      } else {
        // Check if this is a junction point: a vertical divider exists at adjacent rows
        const vAbove = r > 0 && isVerticalDivider(r - 1, c);
        const vBelow = r < totalHeight - 1 && isVerticalDivider(r + 1, c);

        if (vAbove || vBelow) {
          // Junction character at a horizontal/vertical divider intersection
          // Check for horizontal dividers on left and right
          const hOnLeft = c > 0 && !findPane(r, c - 1) && !isVerticalDivider(r, c - 1);
          const hOnRight = c < totalWidth - 1 && !findPane(r, c + 1) && !isVerticalDivider(r, c + 1);
          if (!vAbove && vBelow) grid[r][c] = '┬';
          else if (vAbove && !vBelow) grid[r][c] = '┴';
          else if (hOnLeft && hOnRight) grid[r][c] = '┼';
          else if (hOnRight) grid[r][c] = '├';
          else if (hOnLeft) grid[r][c] = '┤';
          else grid[r][c] = '┼';
        } else {
          // Pure horizontal divider - render border header
          const paneBelow = findPaneBelowDivider(r, c);
          if (paneBelow) {
            const header = formatBorderHeader(paneBelow.borderTitle, paneBelow.width);
            const offset = c - paneBelow.x;
            grid[r][c] = offset < header.length ? header[offset] : '─';
          } else {
            grid[r][c] = '─';
          }
        }
      }
    }
  }

  // --- Last row: Status line ---
  const statusText = extractStatusLineFromDom() || statusLine || '';
  const cleanStatus = statusText.replace(/\x1b\[[0-9;]*m/g, '');
  for (let c = 0; c < totalWidth && c < cleanStatus.length; c++) {
    grid[gridHeight - 1][c] = cleanStatus[c];
  }

  return grid.map(row => row.join(''));
}

/**
 * Fetch tmux snapshot from the API endpoint.
 * Returns an array of strings where each string is one full row.
 */
async function fetchTmuxSnapshot(): Promise<string[]> {
  try {
    const session = new URL(window.location.href).searchParams.get('session');
    const url = session ? `/api/snapshot?session=${encodeURIComponent(session)}` : '/api/snapshot';
    const response = await fetch(url);
    const data = await response.json() as { rows: number; cols: number; lines: string[] } | { error: string };
    if ('error' in data) {
      return [`Error: ${data.error}`];
    }
    return data.lines;
  } catch (error) {
    return [`Fetch error: ${error}`];
  }
}

export function initDebugHelpers(): void {
  window.getSnapshot = buildSnapshot;
  window.getTmuxSnapshot = fetchTmuxSnapshot;
}
