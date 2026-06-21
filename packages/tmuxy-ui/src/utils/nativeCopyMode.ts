/**
 * nativeCopyMode - Command builders for driving tmux's NATIVE copy mode.
 *
 * tmuxy speaks to tmux only through control-mode commands; there is no path for
 * raw mouse events to reach tmux's mouse layer. So mouse gestures and wheel
 * scrolling are translated into `send-keys -X` copy-mode commands here. tmux
 * owns the cursor, selection, and scrollback; the frontend just renders what
 * tmux reports (copy cursor + selection coords from `list-panes`) and mirrors
 * yanked text to the clipboard via the backend %paste-buffer-changed bridge.
 *
 * Every builder returns an array of plain tmux command strings (one tmux command
 * each) so callers can dispatch them as ordered SEND_COMMAND events without
 * worrying about `;` separator escaping.
 *
 * Cell coordinates are VISIBLE-viewport relative: (0, 0) is the top-left visible
 * cell, matching `copy_cursor_x` / `copy_cursor_y` from tmux.
 */

/** Enter copy mode. `-e` makes tmux auto-exit when scrolled back to the bottom. */
export function enterCopyMode(paneId: string, exitOnBottom = false): string {
  return `copy-mode${exitOnBottom ? ' -e' : ''} -t ${paneId}`;
}

/**
 * Move tmux's copy cursor to a visible cell. Built from absolute primitives so
 * the result is independent of the current cursor position: jump to the top
 * visible line, step down to the target row, reset to column 0, step right to
 * the target column. cursor-right clamps at end-of-line (tmux behavior), so
 * clicks past a line's content land on its last cell.
 */
export function gotoCellCommands(paneId: string, col: number, row: number): string[] {
  const cmds = [`send-keys -t ${paneId} -X top-line`];
  if (row > 0) cmds.push(`send-keys -t ${paneId} -N ${row} -X cursor-down`);
  cmds.push(`send-keys -t ${paneId} -X start-of-line`);
  if (col > 0) cmds.push(`send-keys -t ${paneId} -N ${col} -X cursor-right`);
  return cmds;
}

/** Scroll the copy-mode viewport by N lines (no copy-mode entry). Negative lines
 *  = scroll up (into history). */
export function scrollViewportCommand(paneId: string, lines: number): string | null {
  if (lines === 0) return null;
  const n = Math.abs(lines);
  const direction = lines < 0 ? 'scroll-up' : 'scroll-down';
  return `send-keys -t ${paneId} -N ${n} -X ${direction}`;
}

/** Enter copy mode (if needed) and scroll. Used by the touch path, which has no
 *  per-gesture copy-mode bookkeeping; the wheel path enters once and then only
 *  scrolls (see usePaneMouse). */
export function scrollCommands(paneId: string, lines: number): string[] {
  const scroll = scrollViewportCommand(paneId, lines);
  if (!scroll) return [];
  return [enterCopyMode(paneId, true), scroll];
}

/** Begin a character-wise selection at the current cursor position. */
export function beginSelectionCommand(paneId: string): string {
  return `send-keys -t ${paneId} -X begin-selection`;
}

/** Clear any active selection without leaving copy mode. */
export function clearSelectionCommand(paneId: string): string {
  return `send-keys -t ${paneId} -X clear-selection`;
}

/** Copy the active selection to a tmux buffer and exit copy mode. The resulting
 *  %paste-buffer-changed event mirrors the text to the system clipboard. */
export function copySelectionAndCancelCommand(paneId: string): string {
  return `send-keys -t ${paneId} -X copy-selection-and-cancel`;
}

/**
 * Select the word under a visible cell and copy it. Approximates word selection
 * with tmux's word motions (tmux has no select-word-at-point command): jump to
 * the cell, back up to the word start, select forward to the word end.
 */
export function selectWordCommands(paneId: string, col: number, row: number): string[] {
  return [
    enterCopyMode(paneId),
    ...gotoCellCommands(paneId, col, row),
    `send-keys -t ${paneId} -X previous-word`,
    beginSelectionCommand(paneId),
    `send-keys -t ${paneId} -X next-word-end`,
    copySelectionAndCancelCommand(paneId),
  ];
}

/** Select the whole line under a visible row and copy it. */
export function selectLineCommands(paneId: string, row: number): string[] {
  return [
    enterCopyMode(paneId),
    ...gotoCellCommands(paneId, 0, row),
    beginSelectionCommand(paneId),
    `send-keys -t ${paneId} -X end-of-line`,
    copySelectionAndCancelCommand(paneId),
  ];
}
