/** Client-side scrollback views: what a pane in scroll or copy mode is showing. */

import type { CellLine } from './wireCells';

/**
 * Which of the two scrollback views a pane is showing.
 *
 * `scroll` is the native-like one a wheel gesture opens: scrollback rendered
 * and selectable with the browser's own selection, no cursor, no vi keys, and
 * tmux never told anything — the pane is not in `in_mode`, so the application
 * keeps running as if nothing happened.
 *
 * `copy` is tmux's copy mode as reached by `prefix [`: the pane really is in
 * `in_mode`, and the client draws a block cursor and resolves vi motions and
 * cell selection against it.
 *
 * Both share this record, and a pane has at most one, so the two can never be
 * live at once. See docs/COPY-MODE.md.
 */
export type ScrollbackMode = 'scroll' | 'copy';

export interface CopyModeState {
  /** Which view this is — see ScrollbackMode. */
  mode: ScrollbackMode;
  /** Loaded lines of scrollback content, keyed by absolute line index */
  lines: Map<number, CellLine>;
  /** Total lines available (historySize + height) */
  totalLines: number;
  /** Number of history lines above the visible area */
  historySize: number;
  /** Loaded ranges: [startLine, endLine] pairs (inclusive) */
  loadedRanges: Array<[number, number]>;
  /** Whether a chunk is currently being fetched */
  loading: boolean;
  width: number;
  height: number;
  /** Absolute row (0 = first history line) */
  cursorRow: number;
  cursorCol: number;
  selectionMode: 'char' | 'line' | null;
  selectionAnchor: { row: number; col: number } | null;
  /** Absolute row at top of viewport */
  scrollTop: number;
  /** Pending selection to apply on first chunk load (visible-relative row) */
  pendingSelection?: { mode: 'char' | 'line'; row: number; col: number };
  /**
   * A word to select once its row has loaded (visible-relative row): a
   * finger's hold selects the word under it in the same breath as it opens
   * copy mode, before any line is there to read.
   */
  pendingWordSelection?: { row: number; col: number; broad?: boolean };
  /**
   * Select every row once the history lands. A select-all issued as the view
   * opens cannot know where history ends — `totalLines` is the pane's own
   * guess until the first chunk answers with the real `history_size` — so the
   * selection is re-laid over the true extent when it does.
   */
  pendingSelectAll?: boolean;
  /**
   * When the selection was copied, while the view is on its way out. tmux has
   * already left its mode; the view stays for the copy flash (COPY_FLASH_MS)
   * so the copied text blinks where it was, then closes.
   */
  copiedAt?: number;
  /**
   * tmux has reported `in_mode` for THIS record. Set by the reconciliation
   * when a pane snapshot shows the mode on; never set by `ENTER_COPY_MODE`
   * itself, which only asks tmux to enter.
   *
   * What it guards: "tmux left copy mode" is only evidence about this record
   * once tmux has been seen in it. A record opened right after the previous
   * one closed is otherwise killed by the snapshot that merely reports the
   * PREVIOUS exit — the `-X cancel` landing a round trip late — and the view
   * vanishes under the user's hands.
   */
  tmuxSeen?: boolean;
}

// ============================================
// Operations on the copy-mode state
// ============================================

/**
 * The scrollback row a pointer event names. A row inside the viewport is
 * counted from the top of the screen and lands at `scrollTop + row`; one at
 * or past the viewport's height — a row the caller already resolved, a
 * selection carried over from before the history loaded — is absolute as it
 * is. `relative` forces the first reading.
 */
export function toAbsoluteRow(state: CopyModeState, row: number, relative?: boolean): number {
  return relative || row < state.height ? state.scrollTop + row : row;
}

/**
 * `col` held inside the text on `row`, its trailing blanks not counted: the
 * cursor never sits past the last character, and sits at 0 on an empty or
 * unloaded row.
 */
export function clampColToLine(state: CopyModeState, row: number, col: number): number {
  const line = state.lines.get(row);
  const text = line
    ? line
        .map((c) => c.c)
        .join('')
        .trimEnd()
    : '';
  return text.length > 0 ? Math.min(col, text.length - 1) : 0;
}

/**
 * Whether a physical row is a wrapped continuation of a logical line.
 *
 * The backend trims trailing blank cells from each row, so only a line whose
 * content reached the last column keeps all `width` cells. A row that fills
 * the full width therefore wrapped onto the next row with no logical line
 * break — the same notion tmux tracks with its per-line wrapped flag.
 */
export function isWrappedRow(line: CellLine | undefined, width: number): boolean {
  return !!line && line.length >= width;
}

/**
 * Extract selected text from copy mode state.
 * For char mode: first line from anchor col, last line to cursor col, middle lines full.
 * For line mode: all selected lines are full width (trailing spaces trimmed).
 *
 * Rows that wrapped (filled the full width) are joined to the next row without
 * a newline, so a selection spanning a wrapped logical line copies as one line.
 */
export function extractSelectedText(state: CopyModeState): string {
  const { selectionAnchor, selectionMode, cursorRow, cursorCol, lines, width } = state;

  if (!selectionAnchor || !selectionMode) return '';

  // Normalize: start before end
  let startRow = selectionAnchor.row;
  let startCol = selectionAnchor.col;
  let endRow = cursorRow;
  let endCol = cursorCol;

  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    [startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol];
  }

  let output = '';

  for (let row = startRow; row <= endRow; row++) {
    const line = lines.get(row);
    const lineText = line ? line.map((c) => c.c).join('') : '';

    let segment: string;
    if (selectionMode === 'line' || (row !== startRow && row !== endRow)) {
      segment = lineText;
    } else if (startRow === endRow) {
      segment = lineText.slice(startCol, endCol + 1);
    } else if (row === startRow) {
      segment = lineText.slice(startCol);
    } else {
      segment = lineText.slice(0, endCol + 1);
    }

    // A wrapped row continues onto the next with no line break; trim trailing
    // blanks and emit a newline only at a true logical line boundary.
    if (row < endRow && isWrappedRow(line, width)) {
      output += segment;
    } else {
      output += segment.trimEnd();
      if (row < endRow) output += '\n';
    }
  }

  return output;
}

/**
 * Merge a loaded chunk of cells into the copy mode lines map.
 * Returns a new Map with the merged data and updated loadedRanges.
 */
export function mergeScrollbackChunk(
  existingLines: Map<number, import('./wireCells').CellLine>,
  existingRanges: Array<[number, number]>,
  cells: import('./wireCells').PaneContent,
  historySize: number,
  tmuxStart: number,
  tmuxEnd: number,
): {
  lines: Map<number, import('./wireCells').CellLine>;
  loadedRanges: Array<[number, number]>;
} {
  const newLines = new Map(existingLines);

  // Convert tmux line offsets to absolute line indices
  // tmux uses: negative = history (from visible top), 0 = first visible line
  // Our absolute: 0 = first history line, historySize = first visible line
  // tmux clamps -S to the start of history, so actual start may differ from requested
  const actualTmuxStart = Math.max(tmuxStart, -(historySize as number));
  for (let i = 0; i < cells.length; i++) {
    const tmuxOffset = actualTmuxStart + i;
    const absoluteRow = historySize + tmuxOffset;
    if (absoluteRow >= 0) {
      newLines.set(absoluteRow, cells[i]);
    }
  }

  // Compute the absolute range we just loaded
  const absStart = Math.max(0, historySize + actualTmuxStart);
  const absEnd = Math.min(historySize + tmuxEnd, absStart + cells.length - 1);

  // Merge into loadedRanges
  const newRanges = mergeRanges([...existingRanges, [absStart, absEnd]]);

  return { lines: newLines, loadedRanges: newRanges };
}

/** Merge overlapping/adjacent ranges */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1] + 1) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }

  return merged;
}

/**
 * Check if a row is within any loaded range.
 */
export function isRowLoaded(ranges: Array<[number, number]>, row: number): boolean {
  return ranges.some(([start, end]) => row >= start && row <= end);
}

/**
 * Re-key loaded rows after tmux reports a different `history_size`.
 *
 * A row's absolute index is `history_size + <tmux offset>`, so everything
 * already merged was keyed against the size known at the time. When that size
 * turns out to be larger — a view opened before `history_size` finished syncing
 * starts at nearly zero — every stored row belongs `diff` rows further down. Left
 * unshifted, the screen rows sit on top of the oldest history and a copy of the
 * whole scrollback comes back with the tail at the front.
 */
export function shiftScrollbackRows(
  lines: Map<number, CellLine>,
  loadedRanges: Array<[number, number]>,
  diff: number,
): { lines: Map<number, CellLine>; loadedRanges: Array<[number, number]> } {
  if (diff === 0) return { lines, loadedRanges };
  const shifted = new Map<number, CellLine>();
  for (const [row, line] of lines) {
    const moved = row + diff;
    if (moved >= 0) shifted.set(moved, line);
  }
  const ranges = loadedRanges
    .map(([start, end]): [number, number] => [start + diff, end + diff])
    .filter(([, end]) => end >= 0)
    .map(([start, end]): [number, number] => [Math.max(0, start), end]);
  return { lines: shifted, loadedRanges: ranges };
}

/**
 * The first span of rows in `0..totalLines-1` that no loaded range covers, or
 * null when every row is loaded.
 *
 * Lazy loading leaves holes on purpose — chunks are fetched around the viewport
 * — but a selection over the whole scrollback has to be backed by rows
 * everywhere, or the copy comes back with the middle missing. Select-all uses
 * this to keep asking until there are no holes left.
 */
export function firstUnloadedGap(
  loadedRanges: Array<[number, number]>,
  totalLines: number,
): [number, number] | null {
  if (totalLines <= 0) return null;
  const sorted = [...loadedRanges].sort((a, b) => a[0] - b[0]);
  let row = 0;
  for (const [start, end] of sorted) {
    if (start > row) return [row, Math.min(start - 1, totalLines - 1)];
    row = Math.max(row, end + 1);
    if (row >= totalLines) return null;
  }
  return row <= totalLines - 1 ? [row, totalLines - 1] : null;
}

/**
 * Check if we need to load more content based on scroll position.
 * Returns the tmux start/end offsets to fetch, or null if no fetch needed.
 */
export function getNeededChunk(
  scrollTop: number,
  height: number,
  loadedRanges: Array<[number, number]>,
  historySize: number,
  totalLines: number,
  chunkSize: number = 200,
): { start: number; end: number } | null {
  const THRESHOLD = 50;
  const viewStart = scrollTop;
  const viewEnd = scrollTop + height - 1;

  // Check if the current viewport is in an unloaded gap (e.g. user dragged
  // scrollbar to middle). Load a chunk centered on the viewport.
  if (!isViewportLoaded(loadedRanges, viewStart, viewEnd)) {
    const center = Math.floor((viewStart + viewEnd) / 2);
    const halfChunk = Math.floor(chunkSize / 2);
    const newStart = Math.max(0, center - halfChunk);
    const newEnd = Math.min(totalLines - 1, center + halfChunk);
    return {
      start: newStart - historySize,
      end: newEnd - historySize,
    };
  }

  // Check if we're near the top of loaded content
  if (loadedRanges.length > 0) {
    const firstLoaded = loadedRanges[0][0];
    if (scrollTop < firstLoaded + THRESHOLD && firstLoaded > 0) {
      // Need to load above
      const newStart = Math.max(0, firstLoaded - chunkSize);
      const newEnd = firstLoaded - 1;
      // Convert back to tmux offsets
      return {
        start: newStart - historySize,
        end: newEnd - historySize,
      };
    }

    // Check if we're near the bottom of loaded content
    const lastLoaded = loadedRanges[loadedRanges.length - 1][1];
    if (scrollTop + height > lastLoaded - THRESHOLD && lastLoaded < totalLines - 1) {
      const newStart = lastLoaded + 1;
      const newEnd = Math.min(totalLines - 1, lastLoaded + chunkSize);
      return {
        start: newStart - historySize,
        end: newEnd - historySize,
      };
    }
  }

  return null;
}

/** Check if the entire viewport range [viewStart, viewEnd] is covered by loaded ranges */
function isViewportLoaded(
  loadedRanges: Array<[number, number]>,
  viewStart: number,
  viewEnd: number,
): boolean {
  if (loadedRanges.length === 0) return false;
  // Walk through sorted ranges and check full coverage
  let cursor = viewStart;
  for (const [start, end] of loadedRanges) {
    if (start > cursor) return false; // gap before this range
    if (end >= viewEnd) return true; // this range covers the rest
    if (end >= cursor) cursor = end + 1; // advance past this range
  }
  return cursor > viewEnd;
}
