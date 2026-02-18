/**
 * copyModeKeys - Pure function for client-side vi keybindings in copy mode
 *
 * Returns updated state and an optional action ('yank' | 'exit' | null).
 */

import type { CopyModeState, CellLine } from '../tmux/types';

export type CopyModeAction = 'yank' | 'exit' | null;

interface CopyModeKeyResult {
  state: Partial<CopyModeState>;
  action: CopyModeAction;
}

/** Get the text content of a cell line (for word motion scanning) */
function lineText(line: CellLine | undefined): string {
  if (!line) return '';
  return line.map(c => c.c).join('');
}

/** Check if character is a word character (non-whitespace, non-punctuation) */
function isWordChar(ch: string): boolean {
  return /\w/.test(ch);
}

/** Find next word start position */
function findNextWord(lines: Map<number, CellLine>, row: number, col: number, totalLines: number): { row: number; col: number } {
  let r = row;
  let c = col;
  const text = lineText(lines.get(r));

  // Skip current word
  while (c < text.length && isWordChar(text[c])) c++;
  // Skip whitespace/punctuation
  while (c < text.length && !isWordChar(text[c])) c++;

  if (c < text.length) return { row: r, col: c };

  // Move to next line
  r++;
  while (r < totalLines) {
    const nextText = lineText(lines.get(r));
    const firstWord = nextText.search(/\w/);
    if (firstWord >= 0) return { row: r, col: firstWord };
    r++;
  }

  return { row, col };
}

/** Find previous word start position */
function findPrevWord(lines: Map<number, CellLine>, row: number, col: number): { row: number; col: number } {
  let r = row;
  let c = col - 1;

  if (c < 0) {
    r--;
    if (r < 0) return { row: 0, col: 0 };
    const text = lineText(lines.get(r));
    c = text.length - 1;
  }

  const text = lineText(lines.get(r));

  // Skip whitespace/punctuation backward
  while (c >= 0 && !isWordChar(text[c])) c--;
  // Skip word chars backward
  while (c > 0 && isWordChar(text[c - 1])) c--;

  if (c >= 0) return { row: r, col: c };

  return { row: r, col: 0 };
}

/** Find end of current word */
function findWordEnd(lines: Map<number, CellLine>, row: number, col: number, totalLines: number): { row: number; col: number } {
  let r = row;
  let c = col + 1;
  const text = lineText(lines.get(r));

  // Skip whitespace
  while (c < text.length && !isWordChar(text[c])) c++;
  // Go to end of word
  while (c < text.length - 1 && isWordChar(text[c + 1])) c++;

  if (c < text.length) return { row: r, col: c };

  // Move to next line
  r++;
  while (r < totalLines) {
    const nextText = lineText(lines.get(r));
    const firstWord = nextText.search(/\w/);
    if (firstWord >= 0) {
      c = firstWord;
      while (c < nextText.length - 1 && isWordChar(nextText[c + 1])) c++;
      return { row: r, col: c };
    }
    r++;
  }

  return { row, col };
}

// Track 'g' key for 'gg' sequence
let lastKeyWasG = false;

export function handleCopyModeKey(
  key: string,
  ctrlKey: boolean,
  shiftKey: boolean,
  state: CopyModeState,
): CopyModeKeyResult {
  // Browsers may send lowercase key with shiftKey=true (e.g. key='v', shiftKey=true for 'V')
  // Normalize to uppercase for single-letter keys when shift is held
  const effectiveKey = (shiftKey && key.length === 1 && /[a-z]/.test(key)) ? key.toUpperCase() : key;

  const { cursorRow, cursorCol, width, totalLines, scrollTop, height, selectionMode, selectionAnchor, lines } = state;
  let newRow = cursorRow;
  let newCol = cursorCol;
  let newScrollTop = scrollTop;
  let newSelectionMode = selectionMode;
  let newSelectionAnchor = selectionAnchor;
  let action: CopyModeAction = null;

  // Handle 'gg' sequence
  const wasG = lastKeyWasG;
  lastKeyWasG = false;

  // Ctrl key combos
  if (ctrlKey) {
    switch (effectiveKey) {
      case 'u': // Half page up
        newRow = Math.max(0, cursorRow - Math.floor(height / 2));
        break;
      case 'd': // Half page down
        newRow = Math.min(totalLines - 1, cursorRow + Math.floor(height / 2));
        break;
      case 'b': // Full page up
        newRow = Math.max(0, cursorRow - height);
        break;
      case 'f': // Full page down
        newRow = Math.min(totalLines - 1, cursorRow + height);
        break;
      default:
        return { state: {}, action: null };
    }
  } else {
    switch (effectiveKey) {
      // Cursor movement
      case 'h':
      case 'ArrowLeft':
        newCol = Math.max(0, cursorCol - 1);
        break;
      case 'j':
      case 'ArrowDown':
        newRow = Math.min(totalLines - 1, cursorRow + 1);
        break;
      case 'k':
      case 'ArrowUp':
        newRow = Math.max(0, cursorRow - 1);
        break;
      case 'l':
      case 'ArrowRight':
        newCol = Math.min(width - 1, cursorCol + 1);
        break;

      // Line start/end
      case '0':
      case 'Home':
        newCol = 0;
        break;
      case '$':
      case 'End':
        newCol = width - 1;
        break;

      // Word motions
      case 'w': {
        const pos = findNextWord(lines, cursorRow, cursorCol, totalLines);
        newRow = pos.row;
        newCol = pos.col;
        break;
      }
      case 'b': {
        const pos = findPrevWord(lines, cursorRow, cursorCol);
        newRow = pos.row;
        newCol = pos.col;
        break;
      }
      case 'e': {
        const pos = findWordEnd(lines, cursorRow, cursorCol, totalLines);
        newRow = pos.row;
        newCol = pos.col;
        break;
      }

      // Selection
      case 'v':
        if (selectionMode === 'char') {
          newSelectionMode = null;
          newSelectionAnchor = null;
        } else {
          newSelectionMode = 'char';
          newSelectionAnchor = { row: cursorRow, col: cursorCol };
        }
        break;
      case 'V':
        if (selectionMode === 'line') {
          newSelectionMode = null;
          newSelectionAnchor = null;
        } else {
          newSelectionMode = 'line';
          newSelectionAnchor = { row: cursorRow, col: cursorCol };
        }
        break;

      // Yank
      case 'y':
        if (selectionMode) {
          action = 'yank';
        }
        break;

      // Go to top/bottom
      case 'g':
        if (wasG) {
          // gg - go to top
          newRow = 0;
          newCol = 0;
        } else {
          lastKeyWasG = true;
          return { state: {}, action: null };
        }
        break;
      case 'G':
        // Go to bottom
        newRow = totalLines - 1;
        newCol = 0;
        break;

      // Viewport relative
      case 'H':
        newRow = scrollTop;
        break;
      case 'M':
        newRow = scrollTop + Math.floor(height / 2);
        break;
      case 'L':
        newRow = scrollTop + height - 1;
        break;

      // Exit
      case 'q':
      case 'Escape':
        action = 'exit';
        break;

      default:
        return { state: {}, action: null };
    }
  }

  // Clamp cursor
  newRow = Math.max(0, Math.min(totalLines - 1, newRow));
  newCol = Math.max(0, Math.min(width - 1, newCol));

  // Auto-scroll to keep cursor visible
  if (newRow < newScrollTop) {
    newScrollTop = newRow;
  } else if (newRow >= newScrollTop + height) {
    newScrollTop = newRow - height + 1;
  }
  newScrollTop = Math.max(0, Math.min(totalLines - height, newScrollTop));

  return {
    state: {
      cursorRow: newRow,
      cursorCol: newCol,
      scrollTop: newScrollTop,
      selectionMode: newSelectionMode,
      selectionAnchor: newSelectionAnchor,
    },
    action,
  };
}
