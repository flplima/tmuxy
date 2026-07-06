/**
 * copyMode - Text extraction utilities for client-side copy mode
 */

import type { CopyModeState, CellLine } from '../tmux/types';

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
  existingLines: Map<number, import('../tmux/types').CellLine>,
  existingRanges: Array<[number, number]>,
  cells: import('../tmux/types').PaneContent,
  historySize: number,
  tmuxStart: number,
  tmuxEnd: number,
): { lines: Map<number, import('../tmux/types').CellLine>; loadedRanges: Array<[number, number]> } {
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
