/**
 * Scrollback and copy-mode state construction, chunk merging, and pane-mode
 * reconciliation helpers.
 */

import { assign, sendTo } from 'xstate';
import type { Ctx, Enqueue, EnqueueAction } from './actionTypes';
import type { CopyModeState, ScrollbackMode } from '../../domain/copyMode';
import type { TmuxPane } from '../../domain/client';
import type { CellLine } from '../../domain/wire';
import type { PaneId } from '../../domain/ids';
import { TmuxOp } from '../../domain/commands';
import { COPY_FLASH_MS } from '../../utils/copyFlash';
import {
  firstUnloadedGap,
  getNeededChunk,
  shiftScrollbackRows,
  mergeScrollbackChunk,
} from '../../utils/copyMode';

/**
 * Ask for the rows the view at `updated.scrollTop` is missing, when any are
 * and no chunk is already on its way: the record is marked loading and the
 * tmux actor is sent for them. A chunk's arrival (`applyScrollbackChunk`)
 * clears the mark and asks for the next gap itself.
 */
export function fetchNeededChunk(
  enqueue: Enqueue,
  context: Ctx,
  paneId: PaneId,
  updated: CopyModeState,
): void {
  const needed = getNeededChunk(
    updated.scrollTop,
    updated.height,
    updated.loadedRanges,
    updated.historySize,
    updated.totalLines,
  );
  if (!needed || updated.loading) return;
  enqueue(
    assign({
      copyModeStates: { ...context.copyModeStates, [paneId]: { ...updated, loading: true } },
    }),
  );
  enqueue(
    sendTo('tmux', {
      type: 'FETCH_SCROLLBACK_CELLS' as const,
      paneId,
      start: needed.start,
      end: needed.end,
    }),
  );
}

/**
 * Every row of a pane's scrollback selected: a line selection from the first row
 * of history to the last row on screen.
 */
/**
 * The word under `(absoluteRow, col)` as a selection — the cells matching
 * `\w` around it, or every non-space cell with `broad` — or null while the
 * row is not loaded. On a cell with no word the selection is that one cell.
 */
export function selectWordAt(
  state: CopyModeState,
  absoluteRow: number,
  col: number,
  broad: boolean,
): Pick<CopyModeState, 'selectionMode' | 'selectionAnchor' | 'cursorRow' | 'cursorCol'> | null {
  const line = state.lines.get(absoluteRow);
  if (!line) return null;

  const text = line.map((c) => c.c).join('');
  let wordStart = col;
  let wordEnd = col;

  const isWord = broad
    ? (i: number) => i >= 0 && i < text.length && text[i] !== ' '
    : (i: number) => i >= 0 && i < text.length && /\w/.test(text[i]);
  if (isWord(col)) {
    while (wordStart > 0 && isWord(wordStart - 1)) wordStart--;
    while (wordEnd < text.length - 1 && isWord(wordEnd + 1)) wordEnd++;
  }

  return {
    selectionMode: 'char',
    selectionAnchor: { row: absoluteRow, col: wordStart },
    cursorRow: absoluteRow,
    cursorCol: wordEnd,
  };
}

export function selectEveryRow(state: CopyModeState): CopyModeState {
  return {
    ...state,
    selectionMode: 'line',
    selectionAnchor: { row: 0, col: 0 },
    cursorRow: Math.max(0, state.totalLines - 1),
    cursorCol: Math.max(0, state.width - 1),
  };
}

/**
 * Build the per-pane scrollback record both views share.
 *
 * Everything here is identical for the two modes — the loaded lines seeded
 * from what is already on screen, the totals, the initial scroll position —
 * so the only thing the callers decide is `mode`, whether tmux has already
 * been seen in it (`tmuxSeen`, for a copy mode tmux entered on its own) and
 * what they tell tmux afterwards.
 */
export function buildScrollbackState(
  pane: TmuxPane,
  mode: ScrollbackMode,
  options: { scrollLines?: number; nativeScrollTop?: number; tmuxSeen?: boolean },
): CopyModeState {
  const historySize = pane.historySize ?? 0;
  const totalLines = historySize + pane.height;
  const bottom = Math.max(0, totalLines - pane.height);

  const lines = new Map<number, CellLine>();
  for (let i = 0; i < pane.content.length; i++) {
    lines.set(historySize + i, pane.content[i]);
  }

  const loadedRanges: Array<[number, number]> =
    pane.content.length > 0 ? [[historySize, historySize + pane.content.length - 1]] : [];

  let scrollTop = bottom;
  if (options.nativeScrollTop !== undefined) {
    scrollTop = Math.max(0, Math.min(options.nativeScrollTop, bottom));
  } else if (options.scrollLines) {
    scrollTop = Math.max(0, bottom + options.scrollLines);
  }

  const initRow = historySize + pane.cursorY;
  const initLine = lines.get(initRow);
  const initLineText = initLine
    ? initLine
        .map((c) => c.c)
        .join('')
        .trimEnd()
    : '';
  const initCol = initLineText.length > 0 ? Math.min(pane.cursorX, initLineText.length - 1) : 0;

  return {
    mode,
    lines,
    totalLines,
    historySize,
    loadedRanges,
    loading: true,
    width: pane.width,
    height: pane.height,
    cursorRow: initRow,
    cursorCol: initCol,
    selectionMode: null,
    selectionAnchor: null,
    scrollTop,
    ...(options.tmuxSeen ? { tmuxSeen: true } : {}),
  };
}

/**
 * The fetch that backs a view just opened on `record`: the pane's whole
 * history up to its last row on screen, so nothing is truncated to a fixed
 * slab and scrolling never finds placeholders above the first page.
 */
export function fetchHistory(enqueue: EnqueueAction, paneId: PaneId, record: CopyModeState): void {
  enqueue(
    sendTo('tmux', {
      type: 'FETCH_SCROLLBACK_CELLS' as const,
      paneId,
      start: -record.historySize,
      end: record.height - 1,
    }),
  );
}

export const copyModeExitTimes = new Map<PaneId, number>();

/**
 * Leave copy mode the way a copy does. tmux leaves its mode at once, as its
 * `copy-pipe-and-cancel` would; the client's view stays just long enough for
 * the copied text to blink where it is (`copiedAt`, drawn by the scrollback),
 * then COPY_MODE_COPIED_EXIT closes it.
 */
export function leaveAfterCopy(enqueue: Enqueue, context: Ctx, paneId: PaneId): void {
  const copyState = context.copyModeStates[paneId];
  if (!copyState) return;
  const copiedAt = Date.now();
  copyModeExitTimes.set(paneId, copiedAt);
  enqueue(
    assign({
      copyModeStates: { ...context.copyModeStates, [paneId]: { ...copyState, copiedAt } },
    }),
  );
  enqueue(
    sendTo('tmux', {
      type: 'SEND_OP' as const,
      op: TmuxOp.CancelCopyMode({ paneId: paneId }),
    }),
  );
  enqueue.raise(
    { type: 'COPY_MODE_COPIED_EXIT' as const, paneId, copiedAt },
    { delay: COPY_FLASH_MS },
  );
}

export const COPY_MODE_REENTRY_COOLDOWN = 2000;

/** What a pane snapshot says about the copy-mode record the client holds for it. */
export type PaneModeReconciliation = 'enter' | 'confirm' | 'leave' | 'none';

/**
 * Reconcile one pane snapshot with the client's copy-mode record for it.
 */
export function reconcilePaneMode(
  prevPane: Pick<TmuxPane, 'inMode'> | undefined,
  newPane: Pick<TmuxPane, 'tmuxId' | 'inMode'>,
  record: Pick<CopyModeState, 'copiedAt' | 'tmuxSeen'> | undefined,
  options: { now: number },
): PaneModeReconciliation {
  if (newPane.inMode) {
    if (record) return record.tmuxSeen ? 'none' : 'confirm';
    if (prevPane?.inMode) return 'none';
    const exitTime = copyModeExitTimes.get(newPane.tmuxId);
    if (exitTime !== undefined && options.now - exitTime < COPY_MODE_REENTRY_COOLDOWN) {
      return 'none';
    }
    return 'enter';
  }
  if (record && record.tmuxSeen && prevPane?.inMode && !record.copiedAt) return 'leave';
  return 'none';
}

/**
 * Merge a freshly fetched scrollback chunk into an existing CopyModeState record
 * and schedule any follow-up fetches (top-of-history fill or select-all gap fill).
 */
export function applyScrollbackChunk(
  existing: CopyModeState,
  event: {
    paneId: PaneId;
    start: number;
    end: number;
    cells: CellLine[];
    historySize: number;
    width: number;
  },
  enqueue: EnqueueAction,
): CopyModeState {
  const histDiff = event.historySize - existing.historySize;
  const shifted = shiftScrollbackRows(existing.lines, existing.loadedRanges, histDiff);

  const { lines, loadedRanges } = mergeScrollbackChunk(
    shifted.lines,
    shifted.loadedRanges,
    event.cells,
    event.historySize,
    event.start,
    event.end,
  );

  const totalLines = event.historySize + existing.height;

  const updated: CopyModeState = {
    ...existing,
    lines,
    loadedRanges,
    totalLines,
    historySize: event.historySize,
    width: event.width,
    loading: false,
    scrollTop:
      histDiff !== 0
        ? Math.max(0, Math.min(existing.scrollTop + histDiff, totalLines - existing.height))
        : existing.scrollTop,
    cursorRow:
      histDiff !== 0
        ? Math.max(0, Math.min(existing.cursorRow + histDiff, totalLines - 1))
        : existing.cursorRow,
  };

  if (existing.pendingSelection) {
    const ps = existing.pendingSelection;
    const absoluteRow = event.historySize + ps.row;
    updated.selectionMode = ps.mode;
    updated.selectionAnchor = { row: absoluteRow, col: ps.col };
    updated.cursorRow = absoluteRow;
    updated.cursorCol = ps.col;
    updated.pendingSelection = undefined;
  }

  if (existing.pendingWordSelection) {
    const pw = existing.pendingWordSelection;
    const word = selectWordAt(updated, event.historySize + pw.row, pw.col, pw.broad === true);
    if (word) {
      Object.assign(updated, word);
      updated.pendingWordSelection = undefined;
    }
  }

  const topRow = loadedRanges.length > 0 ? loadedRanges[0][0] : totalLines;
  const selectAllGap = existing.pendingSelectAll
    ? firstUnloadedGap(loadedRanges, totalLines)
    : null;
  if (existing.pendingSelectAll) {
    Object.assign(updated, selectEveryRow(updated));
    updated.pendingSelectAll = selectAllGap ? true : undefined;
    if (selectAllGap) {
      updated.loading = true;
      enqueue(
        sendTo('tmux', {
          type: 'FETCH_SCROLLBACK_CELLS' as const,
          paneId: event.paneId,
          start: selectAllGap[0] - event.historySize,
          end: selectAllGap[1] - event.historySize,
        }),
      );
    }
  }

  if (!existing.pendingSelectAll && topRow > 0) {
    updated.loading = true;
    enqueue(
      sendTo('tmux', {
        type: 'FETCH_SCROLLBACK_CELLS' as const,
        paneId: event.paneId,
        start: -event.historySize,
        end: topRow - event.historySize - 1,
      }),
    );
  }

  return updated;
}
