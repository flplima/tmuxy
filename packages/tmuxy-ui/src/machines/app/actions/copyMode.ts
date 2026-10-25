/**
 * Action implementations for the copyMode state slice.
 *
 * Owns context field: copyModeStates (per-pane CopyModeState records).
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx } from '../actionTypes';
import type { CopyModeState } from '../../../domain/copyMode';
import { handleCopyModeKey } from '../../../utils/copyModeKeys';
import {
  clampColToLine,
  isWrappedRow,
  extractSelectedText,
  toAbsoluteRow,
} from '../../../utils/copyMode';
import { selectPaneTakesCopyMode, selectRightSidebarPane } from '../../selectors/panesAndSidebars';
import { writeClipboard } from '../../../utils/clipboard';
import { TmuxOp } from '../../../domain/commands';
import {
  applyScrollbackChunk,
  buildScrollbackState,
  copyModeExitTimes,
  fetchHistory,
  fetchNeededChunk,
  leaveAfterCopy,
  selectEveryRow,
} from '../scrollback';

export const copyModeActions = {
  /**
   * Open tmux's copy mode: the pane really enters `in_mode`, so the client can
   * draw its cursor and run vi motions against a viewport tmux agrees is
   * frozen. Reached by `prefix [`, a CLI `copy-mode`, or the reconciliation
   * noticing tmux entered it on its own.
   */
  copyMode_enter: act(({ event, context, enqueue }) => {
    if (event.type !== 'ENTER_COPY_MODE') return;
    const pane = context.panes.find((p) => p.tmuxId === event.paneId);
    if (!pane || !selectPaneTakesCopyMode(context, event.paneId)) return;
    const record = buildScrollbackState(pane, 'copy', event);

    enqueue(
      assign({
        copyModeStates: { ...context.copyModeStates, [event.paneId]: record },
      }),
    );

    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.EnterCopyMode({ paneId: event.paneId }),
      }),
    );

    fetchHistory(enqueue, event.paneId, record);
  }),

  /**
   * Open the native-like scrollback view. Same record, same fetch — and
   * deliberately no `copy-mode -t`: the pane keeps running, tmux never reports
   * `in_mode`, and nothing about the application's own screen changes.
   */
  copyMode_enterScroll: act(({ event, context, enqueue }) => {
    if (event.type !== 'ENTER_SCROLL_MODE') return;

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

    const pane = context.panes.find((p) => p.tmuxId === event.paneId);
    if (!pane || pane.alternateOn || pane.inMode) return;

    const record = buildScrollbackState(pane, 'scroll', {});

    enqueue(
      assign({
        copyModeStates: {
          ...context.copyModeStates,
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
    const updated = applyScrollbackChunk(existing, event, enqueue);
    enqueue(assign({ copyModeStates: { ...context.copyModeStates, [event.paneId]: updated } }));
  }),

  copyMode_cursorMove: assignCtx(({ event, context }) => {
    if (event.type !== 'COPY_MODE_CURSOR_MOVE') return {};
    const existing = context.copyModeStates[event.paneId];
    if (!existing) return {};

    const rawRow = toAbsoluteRow(existing, event.row, event.relative === true);
    const absoluteRow = Math.max(0, Math.min(rawRow, existing.totalLines - 1));

    let scrollTop = existing.scrollTop;
    if (absoluteRow < scrollTop) {
      scrollTop = absoluteRow;
    } else if (absoluteRow >= scrollTop + existing.height) {
      scrollTop = absoluteRow - existing.height + 1;
    }
    scrollTop = Math.max(0, Math.min(scrollTop, existing.totalLines - existing.height));

    const updated: CopyModeState = {
      ...existing,
      cursorRow: absoluteRow,
      cursorCol: clampColToLine(existing, absoluteRow, event.col),
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

    const absoluteRow = toAbsoluteRow(existing, event.row);
    const clampedCol = clampColToLine(existing, absoluteRow, event.col);

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

    const absoluteRow = toAbsoluteRow(existing, event.row);

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

    const absoluteRow = toAbsoluteRow(existing, event.row);

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
    fetchNeededChunk(enqueue, context, event.paneId, updated);
  }),

  copyMode_yank: act(({ event, context, enqueue }) => {
    if (event.type !== 'COPY_MODE_YANK') return;
    const copyState = context.copyModeStates[event.paneId];
    if (!copyState || !copyState.selectionMode || copyState.copiedAt) return;
    leaveAfterCopy(enqueue, context, event.paneId);
  }),

  /**
   * A drag in copy mode was released: copy what it selected and leave, the
   * way tmux's `MouseDragEnd1Pane → copy-pipe-and-cancel` does.
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
      fetchNeededChunk(enqueue, context, paneId, updated);
    }
  }),
};
