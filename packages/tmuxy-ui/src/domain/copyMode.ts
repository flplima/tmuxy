import type { CellLine } from './wireCells';

/**
 * `scroll`: the view a wheel gesture opens, with the browser's own selection.
 * tmux is told nothing — the pane is not `in_mode` — so the application keeps
 * running.
 *
 * `copy`: tmux's copy mode (`prefix [`), the pane really `in_mode`; the client
 * draws the cursor and resolves vi motions against it. See docs/COPY-MODE.md.
 */
export type ScrollbackMode = 'scroll' | 'copy';

export interface CopyModeState {
  mode: ScrollbackMode;
  /** Keyed by absolute row. */
  lines: Map<number, CellLine>;
  /** historySize + height */
  totalLines: number;
  historySize: number;
  /** [startRow, endRow] pairs, inclusive. */
  loadedRanges: Array<[number, number]>;
  loading: boolean;
  width: number;
  height: number;
  /** Absolute row (0 = first history line). */
  cursorRow: number;
  cursorCol: number;
  selectionMode: 'char' | 'line' | null;
  selectionAnchor: { row: number; col: number } | null;
  /** Absolute row at the top of the viewport. */
  scrollTop: number;
  /** Applied on the first chunk load; visible-relative row. */
  pendingSelection?: { mode: 'char' | 'line'; row: number; col: number };
  /**
   * A word to select once its row has loaded (visible-relative row): a finger's
   * hold selects the word under it as it opens copy mode, before any line is
   * there to read.
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
   * When the selection was copied. tmux has already left its mode; the view
   * stays for the copy flash (COPY_FLASH_MS) so the copied text blinks where it
   * was, then closes.
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

/** As vi does, the cursor never sits past a row's last character (0 on an empty row). */
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

export interface CellPos {
  row: number;
  col: number;
}

function orderedEnds(a: CellPos, b: CellPos): [CellPos, CellPos] {
  return a.row > b.row || (a.row === b.row && a.col > b.col) ? [b, a] : [a, b];
}

/** The inclusive columns a selection covers on each row; null for a row outside it. */
export function selectionColumns(
  anchor: CellPos,
  cursor: CellPos,
  width: number,
  lineMode = false,
): (row: number) => { startCol: number; endCol: number } | null {
  const [start, end] = orderedEnds(anchor, cursor);
  return (row) => {
    if (row < start.row || row > end.row) return null;
    if (lineMode) return { startCol: 0, endCol: width - 1 };
    return {
      startCol: row === start.row ? start.col : 0,
      endCol: row === end.row ? end.col : width - 1,
    };
  };
}

/**
 * Rows that wrapped are joined to the next without a newline, so a selection
 * spanning a wrapped logical line copies as one line.
 */
export function extractSelectedText(state: CopyModeState): string {
  const { selectionAnchor, selectionMode, cursorRow, cursorCol, lines, width } = state;

  if (!selectionAnchor || !selectionMode) return '';

  const [start, end] = orderedEnds(selectionAnchor, { row: cursorRow, col: cursorCol });
  const { row: startRow, col: startCol } = start;
  const { row: endRow, col: endCol } = end;

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

    if (row < endRow && isWrappedRow(line, width)) {
      output += segment;
    } else {
      output += segment.trimEnd();
      if (row < endRow) output += '\n';
    }
  }

  return output;
}

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

  // tmux offsets: negative = history, 0 = first visible line. Absolute rows:
  // 0 = first history line. tmux clamps -S to the start of history, so the
  // actual start may differ from the requested one.
  const actualTmuxStart = Math.max(tmuxStart, -(historySize as number));
  for (let i = 0; i < cells.length; i++) {
    const tmuxOffset = actualTmuxStart + i;
    const absoluteRow = historySize + tmuxOffset;
    if (absoluteRow >= 0) {
      newLines.set(absoluteRow, cells[i]);
    }
  }

  const absStart = Math.max(0, historySize + actualTmuxStart);
  const absEnd = Math.min(historySize + tmuxEnd, absStart + cells.length - 1);

  const newRanges = mergeRanges([...existingRanges, [absStart, absEnd]]);

  return { lines: newLines, loadedRanges: newRanges };
}

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

export function isRowLoaded(ranges: Array<[number, number]>, row: number): boolean {
  return ranges.some(([start, end]) => row >= start && row <= end);
}

/**
 * Re-key loaded rows after tmux reports a different `history_size`. A row's
 * absolute index is `history_size + <tmux offset>`, and a view opened before
 * `history_size` finished syncing keyed its rows against nearly zero.
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
 * The first span of rows in `0..totalLines-1` no loaded range covers, or null.
 * Select-all keeps asking until there is none: a selection over the whole
 * scrollback has to be backed by rows everywhere, or the copy loses its middle.
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

/** The tmux start/end offsets of the chunk to fetch next, or null. */
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

  // A viewport in an unloaded gap (the scrollbar dragged to the middle).
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

  if (loadedRanges.length > 0) {
    const firstLoaded = loadedRanges[0][0];
    if (scrollTop < firstLoaded + THRESHOLD && firstLoaded > 0) {
      const newStart = Math.max(0, firstLoaded - chunkSize);
      const newEnd = firstLoaded - 1;
      return {
        start: newStart - historySize,
        end: newEnd - historySize,
      };
    }

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

function isViewportLoaded(
  loadedRanges: Array<[number, number]>,
  viewStart: number,
  viewEnd: number,
): boolean {
  if (loadedRanges.length === 0) return false;
  let cursor = viewStart;
  for (const [start, end] of loadedRanges) {
    if (start > cursor) return false;
    if (end >= viewEnd) return true;
    if (end >= cursor) cursor = end + 1;
  }
  return cursor > viewEnd;
}
