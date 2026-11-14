/**
 * A pane's shell prompts in its scrollback (OSC 133): the rows they start
 * on, and the move from one to the next. The host reads the rows from tmux
 * (`tmuxy-core/src/host/prompt_marks.rs`); here they are only rows, ascending,
 * counted like every other scrollback row.
 */

import type { CopyModeState } from './copyMode';

export type PromptDirection = 'previous' | 'next';

/** The nearest prompt above `row`, or below it; null when there is none that way. */
export function promptFrom(
  rows: readonly number[],
  row: number,
  direction: PromptDirection,
): number | null {
  if (direction === 'next') return rows.find((prompt) => prompt > row) ?? null;
  const above = rows.filter((prompt) => prompt < row);
  return above.length > 0 ? above[above.length - 1] : null;
}

/**
 * Rows moved by `diff`: read at one history size and placed in a view that
 * holds another, or re-keyed with the view's own rows when a chunk corrects
 * its history size. A row moved above the top is gone.
 */
export function shiftPromptRows(rows: readonly number[], diff: number): number[] {
  if (diff === 0) return [...rows];
  return rows.map((row) => row + diff).filter((row) => row >= 0);
}

/** Where a jump takes a view: its new place, back to the live screen, or nowhere. */
type PromptJump =
  | { kind: 'move'; state: Pick<CopyModeState, 'scrollTop'> & Partial<CopyModeState> }
  | { kind: 'leave' }
  | null;

/**
 * Go to the previous or next prompt. Copy mode moves its cursor there, from
 * where the cursor is. The scroll view has no cursor: it goes from its top
 * row, and a next prompt that is on the live screen is the live screen.
 * Either way the prompt lands on the top row when the history is long enough.
 */
export function jumpToPrompt(state: CopyModeState, direction: PromptDirection): PromptJump {
  const rows = state.promptRows ?? [];
  const bottom = Math.max(0, state.totalLines - state.height);
  if (state.mode === 'copy') {
    const target = promptFrom(rows, state.cursorRow, direction);
    if (target === null) return null;
    return {
      kind: 'move',
      state: { cursorRow: target, cursorCol: 0, scrollTop: Math.min(target, bottom) },
    };
  }
  const target = promptFrom(rows, state.scrollTop, direction);
  if (target === null) return direction === 'next' ? { kind: 'leave' } : null;
  if (target >= bottom) return { kind: 'leave' };
  return { kind: 'move', state: { scrollTop: target } };
}

/** What the snackbar says once "Copy Last Output" has an answer. */
export function lastOutputNotice(text: string | null): string {
  if (text === null) return 'No command output to copy: this shell marks none';
  if (text === '') return 'The last command printed nothing';
  const count = [...text].length;
  return `Copied the last output: ${count} character${count === 1 ? '' : 's'}`;
}
