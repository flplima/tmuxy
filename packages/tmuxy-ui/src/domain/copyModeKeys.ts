import type { CopyModeState } from './copyMode';
import type { CellLine } from './wireCells';

export type CopyModeAction = 'yank' | 'exit' | null;

interface CopyModeKeyResult {
  state: Partial<CopyModeState>;
  action: CopyModeAction;
}

function lineText(line: CellLine | undefined): string {
  if (!line) return '';
  return line.map((c) => c.c).join('');
}

function isWordChar(ch: string): boolean {
  return /\w/.test(ch);
}

function getLineLength(lines: Map<number, CellLine>, row: number): number {
  const line = lines.get(row);
  if (!line || line.length === 0) return 0;
  const text = line.map((c) => c.c).join('');
  return text.trimEnd().length;
}

function findNextWord(
  lines: Map<number, CellLine>,
  row: number,
  col: number,
  totalLines: number,
): { row: number; col: number } {
  let r = row;
  let c = col;
  const text = lineText(lines.get(r));

  while (c < text.length && isWordChar(text[c])) c++;
  while (c < text.length && !isWordChar(text[c])) c++;

  if (c < text.length) return { row: r, col: c };

  r++;
  while (r < totalLines) {
    const nextText = lineText(lines.get(r));
    const firstWord = nextText.search(/\w/);
    if (firstWord >= 0) return { row: r, col: firstWord };
    r++;
  }

  return { row, col };
}

function findPrevWord(
  lines: Map<number, CellLine>,
  row: number,
  col: number,
): { row: number; col: number } {
  let r = row;
  let c = col - 1;

  if (c < 0) {
    r--;
    if (r < 0) return { row: 0, col: 0 };
    const text = lineText(lines.get(r));
    c = text.length - 1;
  }

  const text = lineText(lines.get(r));

  while (c >= 0 && !isWordChar(text[c])) c--;
  while (c > 0 && isWordChar(text[c - 1])) c--;

  if (c >= 0) return { row: r, col: c };

  return { row: r, col: 0 };
}

function findWordEnd(
  lines: Map<number, CellLine>,
  row: number,
  col: number,
  totalLines: number,
): { row: number; col: number } {
  let r = row;
  let c = col + 1;
  const text = lineText(lines.get(r));

  while (c < text.length && !isWordChar(text[c])) c++;
  while (c < text.length - 1 && isWordChar(text[c + 1])) c++;

  if (c < text.length) return { row: r, col: c };

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

let lastKeyWasG = false;

export function handleCopyModeKey(
  key: string,
  ctrlKey: boolean,
  shiftKey: boolean,
  state: CopyModeState,
): CopyModeKeyResult {
  // Browsers may send a lowercase key with shiftKey (key='v' for 'V').
  const effectiveKey = shiftKey && key.length === 1 && /[a-z]/.test(key) ? key.toUpperCase() : key;

  const {
    cursorRow,
    cursorCol,
    width,
    totalLines,
    scrollTop,
    height,
    selectionMode,
    selectionAnchor,
    lines,
  } = state;
  let newRow = cursorRow;
  let newCol = cursorCol;
  let newScrollTop = scrollTop;
  let newSelectionMode = selectionMode;
  let newSelectionAnchor = selectionAnchor;
  let action: CopyModeAction = null;

  const wasG = lastKeyWasG;
  lastKeyWasG = false;

  if (ctrlKey) {
    switch (effectiveKey) {
      case 'u':
        newRow = Math.max(0, cursorRow - Math.floor(height / 2));
        break;
      case 'd':
        newRow = Math.min(totalLines - 1, cursorRow + Math.floor(height / 2));
        break;
      case 'b':
        newRow = Math.max(0, cursorRow - height);
        break;
      case 'f':
        newRow = Math.min(totalLines - 1, cursorRow + height);
        break;
      default:
        return { state: {}, action: null };
    }
  } else {
    switch (effectiveKey) {
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

      case '0':
      case 'Home':
        newCol = 0;
        break;
      case '$':
      case 'End': {
        const len = getLineLength(lines, cursorRow);
        newCol = len > 0 ? len - 1 : 0;
        break;
      }

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

      // Space starts a char selection, as in tmux's vi copy mode.
      case ' ':
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

      case 'y':
        if (selectionMode) {
          action = 'yank';
        }
        break;
      // tmux's Enter is copy-selection-and-cancel.
      case 'Enter':
        action = selectionMode ? 'yank' : 'exit';
        break;

      case 'g':
        if (wasG) {
          newRow = 0;
          newCol = 0;
        } else {
          lastKeyWasG = true;
          return { state: {}, action: null };
        }
        break;
      case 'G':
        newRow = totalLines - 1;
        newCol = 0;
        break;

      case 'H':
        newRow = scrollTop;
        break;
      case 'M':
        newRow = scrollTop + Math.floor(height / 2);
        break;
      case 'L':
        newRow = scrollTop + height - 1;
        break;

      case 'q':
      case 'Escape':
        action = 'exit';
        break;

      default:
        return { state: {}, action: null };
    }
  }

  // As in tmux, the cursor is clamped to the terminal, not the content: it moves
  // freely across empty lines and trailing whitespace.
  newRow = Math.max(0, Math.min(totalLines - 1, newRow));
  newCol = Math.max(0, Math.min(width - 1, newCol));

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
