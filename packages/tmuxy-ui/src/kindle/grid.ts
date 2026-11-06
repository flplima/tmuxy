/**
 * The e-ink page's picture of a session: the tabs, and the active tab drawn as
 * one character grid — every pane at its place, the dividers between them as
 * box-drawing lines, the cursor as an inverted cell. Plain data, so the page
 * only turns it into text and a test can read it without a browser.
 *
 * Colour is dropped: an e-ink screen has none, and grey on grey is unreadable.
 * What survives is what carries meaning without it — bold, underline, inverse,
 * faint.
 */
import type { ClientState, TmuxPane, TmuxWindow } from '../domain/client';
import { isTabWindow } from '../domain/client';
import type { PaneId, WindowId } from '../domain/ids';
import type { TerminalCell } from '../domain/wireCells';
import { isWideChar } from '../components/terminalShared';

/** A stretch of one row drawn in one style. */
export interface Run {
  readonly text: string;
  readonly bold: boolean;
  readonly underline: boolean;
  readonly inverse: boolean;
  readonly dim: boolean;
}

export interface KindleTab {
  readonly id: WindowId;
  readonly label: string;
  readonly active: boolean;
}

/** A pane's rectangle on the grid, for turning a tap into the pane under it. */
export interface PaneBox {
  readonly id: PaneId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface KindleView {
  readonly tabs: readonly KindleTab[];
  /** The pane keys and text go to: the active tab's active pane. */
  readonly target: PaneId | null;
  readonly panes: readonly PaneBox[];
  readonly rows: readonly (readonly Run[])[];
}

interface Cell {
  c: string;
  bold: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
}

const blank = (): Cell => ({ c: ' ', bold: false, underline: false, inverse: false, dim: false });

function styled(cell: TerminalCell): Cell {
  const s = cell.s;
  return {
    c: cell.c === '' ? ' ' : cell.c,
    bold: s?.bold === true,
    underline: s?.underline === true,
    inverse: s?.inverse === true,
    dim: s?.dim === true,
  };
}

/** The tab on screen: tmux's active window when it is a tab, else the first tab. */
function shownWindow(state: ClientState, tabs: readonly TmuxWindow[]): TmuxWindow | null {
  return tabs.find((w) => w.id === state.activeWindowId) ?? tabs[0] ?? null;
}

/** The panes the tab draws: all of them, or only the zoomed one. */
function shownPanes(window: TmuxWindow, panes: readonly TmuxPane[]): TmuxPane[] {
  const inWindow = panes.filter((p) => p.windowId === window.id);
  if (!window.zoomed) return inWindow;
  const zoomed = inWindow.find((p) => p.active) ?? inWindow[0];
  return zoomed ? [{ ...zoomed, x: 0, y: 0 }] : [];
}

function paint(grid: Cell[][], pane: TmuxPane, showCursor: boolean): void {
  for (let row = 0; row < pane.height; row++) {
    const line = pane.content[row] ?? [];
    const out = grid[pane.y + row];
    if (!out) continue;
    for (let col = 0, src = 0; col < pane.width && src < line.length; col++, src++) {
      const cell = line[src];
      out[pane.x + col] = styled(cell);
      // A wide glyph advances two columns in a monospace font on its own; the
      // blank cell tmux reserves after it would push the rest of the row right.
      if (isWideChar(cell.c) && line[src + 1]?.c.trim() === '') {
        src++;
        col++;
        if (pane.x + col < out.length) out[pane.x + col] = { ...blank(), c: '' };
      }
    }
  }
  if (!showCursor || pane.cursorHidden || pane.inMode) return;
  const cursor = grid[pane.y + pane.cursorY]?.[pane.x + pane.cursorX];
  if (cursor) cursor.inverse = !cursor.inverse;
}

/** Dividers along each pane's right and bottom edge, joined where they cross. */
function divide(grid: Cell[][], panes: readonly TmuxPane[]): void {
  const mark = (y: number, x: number, line: '│' | '─') => {
    const cell = grid[y]?.[x];
    if (!cell) return;
    cell.c = cell.c === ' ' || cell.c === line ? line : '┼';
  };
  for (const p of panes) {
    for (let y = p.y; y < p.y + p.height; y++) mark(y, p.x + p.width, '│');
    for (let x = p.x; x < p.x + p.width; x++) mark(p.y + p.height, x, '─');
  }
}

function toRuns(row: readonly Cell[]): Run[] {
  const runs: Run[] = [];
  let current: (Run & { text: string }) | null = null;
  for (const cell of row) {
    if (
      current &&
      current.bold === cell.bold &&
      current.underline === cell.underline &&
      current.inverse === cell.inverse &&
      current.dim === cell.dim
    ) {
      current.text += cell.c;
    } else {
      current = {
        text: cell.c,
        bold: cell.bold,
        underline: cell.underline,
        inverse: cell.inverse,
        dim: cell.dim,
      };
      runs.push(current);
    }
  }
  return runs;
}

export function kindleView(state: ClientState): KindleView {
  const tabWindows = state.windows.filter(isTabWindow);
  const window = shownWindow(state, tabWindows);
  const tabs = tabWindows.map((w) => ({
    id: w.id,
    label: `${w.index}:${w.name}`,
    active: w.id === window?.id,
  }));
  if (!window) return { tabs, target: null, panes: [], rows: [] };

  const panes = shownPanes(window, state.panes);
  const target = panes.find((p) => p.active) ?? panes[0] ?? null;
  const width = Math.max(0, ...panes.map((p) => p.x + p.width));
  const height = Math.max(0, ...panes.map((p) => p.y + p.height));
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, blank));
  for (const pane of panes) paint(grid, pane, pane === target);
  divide(grid, panes);

  return {
    tabs,
    target: target?.tmuxId ?? null,
    panes: panes.map((p) => ({ id: p.tmuxId, x: p.x, y: p.y, width: p.width, height: p.height })),
    rows: grid.map(toRuns),
  };
}
