/** Client-side scrollback views: what a pane in scroll or copy mode is showing. */

import type { CellLine } from './wire';

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
