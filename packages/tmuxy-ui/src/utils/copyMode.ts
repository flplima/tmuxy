/**
 * copyMode - Text extraction utilities for client-side copy mode
 */

import type { CopyModeState } from '../tmux/types';

/**
 * Extract selected text from copy mode state.
 * For char mode: first line from anchor col, last line to cursor col, middle lines full.
 * For line mode: all selected lines are full width (trailing spaces trimmed).
 */
export function extractSelectedText(state: CopyModeState): string {
  const { selectionAnchor, selectionMode, cursorRow, cursorCol, lines } = state;

  if (!selectionAnchor || !selectionMode) return '';

  // Normalize: start before end
  let startRow = selectionAnchor.row;
  let startCol = selectionAnchor.col;
  let endRow = cursorRow;
  let endCol = cursorCol;

  if (startRow > endRow || (startRow === endRow && startCol > endCol)) {
    [startRow, startCol, endRow, endCol] = [endRow, endCol, startRow, startCol];
  }

  const result: string[] = [];

  for (let row = startRow; row <= endRow; row++) {
    const line = lines.get(row);
    if (!line) {
      result.push('');
      continue;
    }

    const lineText = line.map((c) => c.c).join('');

    if (selectionMode === 'line') {
      result.push(lineText.trimEnd());
    } else {
      // char mode
      if (startRow === endRow) {
        result.push(lineText.slice(startCol, endCol + 1).trimEnd());
      } else if (row === startRow) {
        result.push(lineText.slice(startCol).trimEnd());
      } else if (row === endRow) {
        result.push(lineText.slice(0, endCol + 1).trimEnd());
      } else {
        result.push(lineText.trimEnd());
      }
    }
  }

  return result.join('\n');
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
