/**
 * Action implementations for the copyMode state slice.
 *
 * Owns context field: copyModeStates (per-pane CopyModeState records).
 *
 * `reconcilePaneMode`, `buildScrollbackState` and `fetchHistory` are exported
 * because the parent machine's TMUX_MODEL_UPDATE handler in appMachine.ts
 * opens the same record, with the same fetch, for a copy mode tmux entered on
 * its own — and `reconcilePaneMode` suppresses re-entering one the client just
 * exited: tmux takes time to process the `send-keys -X cancel`, so a stale
 * snapshot can still report `in_mode: true`.
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx, type Ctx, type Enqueue, type EnqueueAction } from '../actionTypes';
import type { CopyModeState, ScrollbackMode } from '../../../domain/copyMode';
import type { TmuxPane } from '../../../domain/client';
import type { CellLine } from '../../../domain/wire';
import { handleCopyModeKey } from '../../../utils/copyModeKeys';
import {
  firstUnloadedGap,
  shiftScrollbackRows,
  mergeScrollbackChunk,
  getNeededChunk,
  isWrappedRow,
  extractSelectedText,
} from '../../../utils/copyMode';
import { selectRightSidebarPane } from '../../selectors';
import { COPY_FLASH_MS } from '../../../utils/copyFlash';
import { writeClipboard } from '../../../utils/clipboard';
import type { PaneId } from '../../../domain/ids';
import { TmuxOp } from '../../../domain/commands';

/**
 * Every row of a pane's scrollback selected: a line selection from the first row
 * of history to the last row on screen.
 */
function selectEveryRow(state: CopyModeState): CopyModeState {
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

  // The cursor is copy mode's alone, but it costs nothing to seed and keeps
  // the record one shape: the scroll view simply never draws or moves it.
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
 * then COPY_MODE_COPIED_EXIT closes it. The clipboard write itself happens on
 * the path that copied — the keyboard's native copy event, or the mouse.
 */
function leaveAfterCopy(enqueue: Enqueue, context: Ctx, paneId: PaneId): void {
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
export type PaneModeReconciliation =
  /** tmux entered copy mode on its own and the client has no record: open one. */
  | 'enter'
  /** tmux has reported the mode on for the client's record: remember that. */
  | 'confirm'
  /** tmux left a copy mode it had been seen in: close the record. */
  | 'leave'
  | 'none';

/**
 * Reconcile one pane snapshot with the client's copy-mode record for it.
 *
 * Pure, so the ordering this guards can be written down as a test. The order
 * that matters: the client closes its record and sends `-X cancel`, then opens
 * a new one before tmux has confirmed the cancel. The next snapshot reports the
 * PREVIOUS exit (`inMode` true → false) and used to be read as tmux leaving
 * the NEW record's copy mode — which deleted it, a round trip after it opened.
 * Seen on a loaded CI runner as a `v` keypress landing on no copy mode at all.
 *
 * So "tmux left" only counts against a record tmux has been seen IN
 * (`tmuxSeen`). A record the client opened itself is confirmed by the first
 * snapshot that shows the mode on, and only after that can a snapshot showing
 * it off mean anything about it. The scroll view, which never asks tmux for a
 * mode, is never confirmed and so is never closed by tmux either — which was
 * always the intent, and now holds.
 *
 * Entering stays guarded by the exit cooldown: a snapshot that still shows the
 * mode on right after the client left it is the same stale report in the other
 * direction, and must not reopen what was just closed.
 */
export function reconcilePaneMode(
  prevPane: Pick<TmuxPane, 'inMode'> | undefined,
  newPane: Pick<TmuxPane, 'tmuxId' | 'inMode'>,
  record: Pick<CopyModeState, 'copiedAt' | 'tmuxSeen'> | undefined,
  options: { readOnly: boolean; now: number },
): PaneModeReconciliation {
  if (newPane.inMode) {
    if (record) return record.tmuxSeen ? 'none' : 'confirm';
    if (options.readOnly || prevPane?.inMode) return 'none';
    const exitTime = copyModeExitTimes.get(newPane.tmuxId);
    if (exitTime !== undefined && options.now - exitTime < COPY_MODE_REENTRY_COOLDOWN) {
      return 'none';
    }
    return 'enter';
  }
  // Not a view that is closing after a copy: tmux left on purpose, and the
  // view stays for the copied text's blink (copiedAt).
  if (record && record.tmuxSeen && prevPane?.inMode && !record.copiedAt) return 'leave';
  return 'none';
}

export const copyModeActions = {
  /**
   * Open tmux's copy mode: the pane really enters `in_mode`, so the client can
   * draw its cursor and run vi motions against a viewport tmux agrees is
   * frozen. Reached by `prefix [`, a CLI `copy-mode`, or the reconciliation
   * noticing tmux entered it on its own.
   */
  copyMode_enter: act(({ event, context, enqueue }) => {
    if (event.type !== 'ENTER_COPY_MODE') return;
    // A read-only client cannot put the pane in tmux's copy mode, so the
    // same request opens the scroll view, which tells tmux nothing.
    const mode = context.readOnly ? 'scroll' : 'copy';
    const pane = context.panes.find((p) => p.tmuxId === event.paneId);
    if (!pane) return;
    const record = buildScrollbackState(pane, mode, event);

    enqueue(
      assign({
        copyModeStates: { ...context.copyModeStates, [event.paneId]: record },
      }),
    );

    if (!context.readOnly) {
      enqueue(
        sendTo('tmux', {
          type: 'SEND_OP' as const,
          op: TmuxOp.EnterCopyMode({ paneId: event.paneId }),
        }),
      );
    }

    fetchHistory(enqueue, event.paneId, record);
  }),

  /**
   * Open the native-like scrollback view. Same record, same fetch — and
   * deliberately no `copy-mode -t`: the pane keeps running, tmux never reports
   * `in_mode`, and nothing about the application's own screen changes. That
   * absence is the whole difference a user feels between this and copy mode.
   */
  copyMode_enterScroll: act(({ event, context, enqueue }) => {
    if (event.type !== 'ENTER_SCROLL_MODE') return;

    // A finger keeps sending this until the component has re-rendered with
    // the view open — a swipe is a dozen touchmoves and React is one frame
    // behind the first of them. Rebuilding the record on each would seat the
    // view back at the bottom every time, so a long swipe ended a single row
    // above the live screen. Once the view is open, the event is simply more
    // scrolling.
    const open = context.copyModeStates[event.paneId];
    if (open && open.mode === 'scroll') {
      const bottom = Math.max(0, open.totalLines - open.height);
      const scrollTop = Math.max(0, Math.min(bottom, open.scrollTop + (event.scrollLines ?? 0)));
      if (scrollTop !== open.scrollTop) {
        enqueue(
          assign({
            copyModeStates: {
              ...context.copyModeStates,
              [event.paneId]: { ...open, scrollTop },
            },
          }),
        );
      }
      return;
    }

    const pane = context.panes.find((p) => p.tmuxId === event.paneId);
    if (!pane) return;
    const record = buildScrollbackState(pane, 'scroll', event);

    enqueue(
      assign({
        copyModeStates: { ...context.copyModeStates, [event.paneId]: record },
      }),
    );

    fetchHistory(enqueue, event.paneId, record);
  }),

  /**
   * Select the whole of a pane's scrollback (Cmd+A / Ctrl+Shift+A).
   *
   * A selection over history needs a view that renders history, so a pane with
   * neither view open gets the scroll view — the one that tells tmux nothing and
   * leaves the application running. The selection is the client's, not the
   * browser's: most of the scrollback has no DOM node to select, and the copy is
   * read from the loaded rows (`extractSelectedText`).
   */
  copyMode_selectAll: act(({ event, context, enqueue }) => {
    if (event.type !== 'SELECT_ALL_SCROLLBACK') return;

    const open = context.copyModeStates[event.paneId];
    if (open) {
      enqueue(
        assign({
          copyModeStates: {
            ...context.copyModeStates,
            [event.paneId]: selectEveryRow(open),
          },
        }),
      );
      return;
    }

    // The same gate the wheel uses: a full-screen application's screen is its
    // own, with no scrollback behind it to select, and tmux's own mode owns the
    // pane. Nothing to select all of there.
    const pane = context.panes.find((p) => p.tmuxId === event.paneId);
    if (!pane || pane.alternateOn || pane.inMode) return;

    const record = buildScrollbackState(pane, 'scroll', {});

    enqueue(
      assign({
        copyModeStates: {
          ...context.copyModeStates,
          // The whole backlog is on its way; `pendingSelectAll` re-lays the
          // selection over its real extent when it lands.
          [event.paneId]: { ...selectEveryRow(record), pendingSelectAll: true },
        },
      }),
    );

    fetchHistory(enqueue, event.paneId, record);
  }),

  copyMode_exit: act(({ event, context, enqueue }) => {
    if (event.type !== 'EXIT_COPY_MODE') return;
    copyModeExitTimes.set(event.paneId, Date.now());
    const newStates = { ...context.copyModeStates };
    delete newStates[event.paneId];
    enqueue(assign({ copyModeStates: newStates }));

    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.CancelCopyMode({ paneId: event.paneId }),
      }),
    );
  }),

  /**
   * Leave the native-like view: drop the record and the pane follows live
   * output again.
   *
   * No `send-keys -X cancel` and no exit-time cooldown, both of which exist
   * only for tmux's copy mode — cancel would be sent to a pane that was never
   * in a mode (the application would see the keys), and the cooldown exists to
   * outlast a stale `in_mode` that this view never sets. Recording one here
   * would suppress a real `prefix [` for two seconds after any scroll.
   */
  copyMode_exitScroll: assignCtx(({ context, event }) => {
    if (event.type !== 'EXIT_SCROLL_MODE') return {};
    if (!context.copyModeStates[event.paneId]) return {};
    const newStates = { ...context.copyModeStates };
    delete newStates[event.paneId];
    return { copyModeStates: newStates };
  }),

  copyMode_chunkLoaded: act(({ event, context, enqueue }) => {
    if (event.type !== 'COPY_MODE_CHUNK_LOADED') return;
    const existing = context.copyModeStates[event.paneId];
    if (!existing) return;

    // What is already loaded was keyed against the history size known then.
    // This response may carry a bigger one — a view can open before tmux has
    // reported the pane's real `history_size` — so the stored rows move down
    // by the difference before the new chunk is merged onto them.
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

    // If the merge left the top of history uncovered — which happens when a
    // pane entered copy mode (e.g. server-side, via a CLI `copy-mode` or a
    // custom binding) before `history_size` finished syncing, so the initial
    // fetch asked for a too-small slab and the real (larger) history_size
    // only arrived in this response — fill the uncovered top rows now. This
    // keeps the "entire live history is loaded on entry" guarantee regardless
    // of how copy mode was entered; without it, scrollback above the initial
    // window would render as placeholders until the user scrolled into it.
    const topRow = loadedRanges.length > 0 ? loadedRanges[0][0] : totalLines;

    // Select-all re-lays itself over the real extent every time a chunk
    // widens it, and keeps asking for the next hole until every selected row
    // is backed by loaded cells. Two things make that necessary: the pane's
    // own `history_size` can still be catching up when the view opens, so the
    // first fetch asks for a too-small slab; and lazy loading leaves holes on
    // purpose, which for an ordinary scroll is fine and for a copy of the
    // whole history is a gap in the middle of the text.
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

    // The top fill below covers the same ground for an ordinary view; under a
    // select-all the gap fetch above has it.
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

    enqueue(assign({ copyModeStates: { ...context.copyModeStates, [event.paneId]: updated } }));
  }),

  copyMode_cursorMove: assignCtx(({ event, context }) => {
    if (event.type !== 'COPY_MODE_CURSOR_MOVE') return {};
    const existing = context.copyModeStates[event.paneId];
    if (!existing) return {};

    const isRelative = event.relative === true ? true : event.row < existing.height;
    const rawRow = isRelative ? existing.scrollTop + event.row : event.row;
    const absoluteRow = Math.max(0, Math.min(rawRow, existing.totalLines - 1));

    let scrollTop = existing.scrollTop;
    if (absoluteRow < scrollTop) {
      scrollTop = absoluteRow;
    } else if (absoluteRow >= scrollTop + existing.height) {
      scrollTop = absoluteRow - existing.height + 1;
    }
    scrollTop = Math.max(0, Math.min(scrollTop, existing.totalLines - existing.height));

    const line = existing.lines.get(absoluteRow);
    const lineText = line
      ? line
          .map((c) => c.c)
          .join('')
          .trimEnd()
      : '';
    const clampedCol = lineText.length > 0 ? Math.min(event.col, lineText.length - 1) : 0;

    const updated: CopyModeState = {
      ...existing,
      cursorRow: absoluteRow,
      cursorCol: clampedCol,
      scrollTop,
    };

    return { copyModeStates: { ...context.copyModeStates, [event.paneId]: updated } };
  }),

  copyMode_selectionStart: assignCtx(({ event, context }) => {
    if (event.type !== 'COPY_MODE_SELECTION_START') return {};
    const existing = context.copyModeStates[event.paneId];
    if (!existing) return {};

    if (existing.totalLines === 0) {
      return {
        copyModeStates: {
          ...context.copyModeStates,
          [event.paneId]: {
            ...existing,
            pendingSelection: { mode: event.mode, row: event.row, col: event.col },
          },
        },
      };
    }

    const absoluteRow = event.row < existing.height ? existing.scrollTop + event.row : event.row;

    const line = existing.lines.get(absoluteRow);
    const lineText = line
      ? line
          .map((c) => c.c)
          .join('')
          .trimEnd()
      : '';
    const clampedCol = lineText.length > 0 ? Math.min(event.col, lineText.length - 1) : 0;

    const updated: CopyModeState = {
      ...existing,
      selectionMode: event.mode,
      selectionAnchor: { row: absoluteRow, col: clampedCol },
      cursorRow: absoluteRow,
      cursorCol: clampedCol,
    };

    return { copyModeStates: { ...context.copyModeStates, [event.paneId]: updated } };
  }),

  copyMode_selectionClear: assignCtx(({ event, context }) => {
    if (event.type !== 'COPY_MODE_SELECTION_CLEAR') return {};
    const existing = context.copyModeStates[event.paneId];
    if (!existing) return {};

    const updated: CopyModeState = {
      ...existing,
      selectionMode: null,
      selectionAnchor: null,
    };

    return { copyModeStates: { ...context.copyModeStates, [event.paneId]: updated } };
  }),

  copyMode_wordSelect: assignCtx(({ event, context }) => {
    if (event.type !== 'COPY_MODE_WORD_SELECT') return {};
    const existing = context.copyModeStates[event.paneId];
    if (!existing) return {};

    const absoluteRow = event.row < existing.height ? existing.scrollTop + event.row : event.row;

    const line = existing.lines.get(absoluteRow);
    if (!line) return {};

    const text = line.map((c) => c.c).join('');
    let wordStart = event.col;
    let wordEnd = event.col;

    const isWord = event.broad
      ? (i: number) => i >= 0 && i < text.length && text[i] !== ' '
      : (i: number) => i >= 0 && i < text.length && /\w/.test(text[i]);
    if (isWord(event.col)) {
      while (wordStart > 0 && isWord(wordStart - 1)) wordStart--;
      while (wordEnd < text.length - 1 && isWord(wordEnd + 1)) wordEnd++;
    }

    return {
      copyModeStates: {
        ...context.copyModeStates,
        [event.paneId]: {
          ...existing,
          selectionMode: 'char' as const,
          selectionAnchor: { row: absoluteRow, col: wordStart },
          cursorRow: absoluteRow,
          cursorCol: wordEnd,
        },
      },
    };
  }),

  copyMode_lineSelect: assignCtx(({ event, context }) => {
    if (event.type !== 'COPY_MODE_LINE_SELECT') return {};
    const existing = context.copyModeStates[event.paneId];
    if (!existing) return {};

    const absoluteRow = event.row < existing.height ? existing.scrollTop + event.row : event.row;

    // Expand across wrapped rows so triple-click selects the whole logical
    // line: walk up while the row above wrapped into this one, and down while
    // this row wraps into the next. Unloaded rows aren't wrapped, so the walk
    // stops at gaps in the loaded scrollback.
    let startRow = absoluteRow;
    while (startRow > 0 && isWrappedRow(existing.lines.get(startRow - 1), existing.width)) {
      startRow--;
    }
    let endRow = absoluteRow;
    while (
      endRow < existing.totalLines - 1 &&
      isWrappedRow(existing.lines.get(endRow), existing.width)
    ) {
      endRow++;
    }

    return {
      copyModeStates: {
        ...context.copyModeStates,
        [event.paneId]: {
          ...existing,
          selectionMode: 'line' as const,
          selectionAnchor: { row: startRow, col: 0 },
          cursorRow: endRow,
          cursorCol: existing.width - 1,
        },
      },
    };
  }),

  copyMode_scroll: act(({ event, context, enqueue }) => {
    if (event.type !== 'COPY_MODE_SCROLL') return;
    const existing = context.copyModeStates[event.paneId];
    if (!existing) return;

    const maxScrollTop = existing.totalLines - existing.height;
    const scrollTop = Math.max(0, Math.min(maxScrollTop, event.scrollTop));

    // Back at the bottom with nothing selected: the user is done looking,
    // so the pane follows live output again. Each view leaves by its own
    // door — the scroll view has no tmux mode to cancel. A selection holds
    // the view open, the client's in copy mode or the browser's in the
    // scroll view: closing it would take the selection with it.
    if (
      maxScrollTop > 0 &&
      scrollTop >= maxScrollTop &&
      existing.scrollTop < maxScrollTop &&
      !existing.selectionMode &&
      !event.nativeSelection
    ) {
      enqueue.raise(
        existing.mode === 'scroll'
          ? { type: 'EXIT_SCROLL_MODE', paneId: event.paneId }
          : { type: 'EXIT_COPY_MODE', paneId: event.paneId },
      );
      return;
    }

    const updated: CopyModeState = {
      ...existing,
      scrollTop,
    };

    enqueue(
      assign({
        copyModeStates: { ...context.copyModeStates, [event.paneId]: updated },
      }),
    );

    const needed = getNeededChunk(
      scrollTop,
      existing.height,
      existing.loadedRanges,
      existing.historySize,
      existing.totalLines,
    );
    if (needed) {
      enqueue(
        assign({
          copyModeStates: {
            ...context.copyModeStates,
            [event.paneId]: { ...updated, loading: true },
          },
        }),
      );
      enqueue(
        sendTo('tmux', {
          type: 'FETCH_SCROLLBACK_CELLS' as const,
          paneId: event.paneId,
          start: needed.start,
          end: needed.end,
        }),
      );
    }
  }),

  copyMode_yank: act(({ event, context, enqueue }) => {
    if (event.type !== 'COPY_MODE_YANK') return;
    const copyState = context.copyModeStates[event.paneId];
    if (!copyState || !copyState.selectionMode || copyState.copiedAt) return;
    leaveAfterCopy(enqueue, context, event.paneId);
  }),

  /**
   * A drag in copy mode was released: copy what it selected and leave, the
   * way tmux's `MouseDragEnd1Pane → copy-pipe-and-cancel` does. The release is
   * the user gesture the clipboard write needs, and the action runs inside it.
   */
  copyMode_mouseCopy: act(({ event, context, enqueue }) => {
    if (event.type !== 'COPY_MODE_MOUSE_COPY') return;
    const copyState = context.copyModeStates[event.paneId];
    if (!copyState || copyState.mode !== 'copy' || copyState.copiedAt) return;
    if (!copyState.selectionMode || !copyState.selectionAnchor) return;
    const text = extractSelectedText(copyState);
    if (text) enqueue(() => writeClipboard(text, event.paneId));
    leaveAfterCopy(enqueue, context, event.paneId);
  }),

  /** The copy flash is over: close the view, unless it is no longer that copy's. */
  copyMode_copiedExit: act(({ event, context, enqueue }) => {
    if (event.type !== 'COPY_MODE_COPIED_EXIT') return;
    const copyState = context.copyModeStates[event.paneId];
    if (!copyState || copyState.copiedAt !== event.copiedAt) return;
    const newStates = { ...context.copyModeStates };
    delete newStates[event.paneId];
    enqueue(assign({ copyModeStates: newStates }));
  }),

  copyMode_key: act(({ event, context, enqueue }) => {
    if (event.type !== 'COPY_MODE_KEY') return;
    // The pane holding the keyboard: the dock's pane while the dock is
    // focused (it can be scrolled into copy mode like any pane), else the
    // active tab pane. The keyboard actor made the same choice to get here.
    const dockPaneId = context.rightSidebarFocused
      ? (selectRightSidebarPane(context)?.tmuxId ?? null)
      : null;
    const paneId = dockPaneId ?? context.activePaneId;
    if (!paneId) return;
    const copyState = context.copyModeStates[paneId];
    if (!copyState) return;

    const result = handleCopyModeKey(event.key, event.ctrlKey, event.shiftKey, copyState);

    if (result.action === 'yank') {
      leaveAfterCopy(enqueue, context, paneId);
      return;
    }

    if (result.action === 'exit') {
      enqueue.raise({ type: 'EXIT_COPY_MODE', paneId });
      return;
    }

    if (Object.keys(result.state).length > 0) {
      const updated = { ...copyState, ...result.state } as CopyModeState;
      enqueue(
        assign({
          copyModeStates: { ...context.copyModeStates, [paneId]: updated },
        }),
      );

      const needed = getNeededChunk(
        updated.scrollTop,
        updated.height,
        updated.loadedRanges,
        updated.historySize,
        updated.totalLines,
      );
      if (needed && !updated.loading) {
        enqueue(
          assign({
            copyModeStates: {
              ...context.copyModeStates,
              [paneId]: { ...updated, loading: true },
            },
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
    }
  }),
};
