/**
 * Action implementations for the copyMode parallel state.
 *
 * Owns context field: copyModeStates (per-pane CopyModeState records).
 *
 * `copyModeExitTimes` and `COPY_MODE_REENTRY_COOLDOWN` are exported because
 * the parent machine's TMUX_STATE_UPDATE reconciliation (still in
 * appMachine.ts pending the layout-state migration) reads them to suppress
 * re-entering copy mode for a pane that the client just exited — tmux takes
 * time to process the `send-keys -X cancel` so a stale snapshot can still
 * report `in_mode: true`.
 */

import { assign, enqueueActions, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';
import type { CopyModeState, CellLine } from '../../../tmux/types';
import { handleCopyModeKey } from '../../../utils/copyModeKeys';
import { mergeScrollbackChunk, getNeededChunk, isWrappedRow } from '../../../utils/copyMode';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

export const copyModeExitTimes = new Map<string, number>();
export const COPY_MODE_REENTRY_COOLDOWN = 2000;

export const copyModeActions = {
  copyMode_enter: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'ENTER_COPY_MODE') return;
      const pane = context.panes.find((p) => p.tmuxId === event.paneId);
      if (!pane) return;

      const historySize = pane.historySize ?? 0;
      const totalLines = historySize + pane.height;
      const scrollTop = Math.max(0, totalLines - pane.height);

      const lines = new Map<number, CellLine>();
      for (let i = 0; i < pane.content.length; i++) {
        lines.set(historySize + i, pane.content[i]);
      }

      const loadedRanges: Array<[number, number]> =
        pane.content.length > 0 ? [[historySize, historySize + pane.content.length - 1]] : [];

      let initialScrollTop = scrollTop;
      if (event.nativeScrollTop !== undefined) {
        initialScrollTop = Math.max(0, Math.min(event.nativeScrollTop, scrollTop));
      } else if (event.scrollLines) {
        initialScrollTop = Math.max(0, scrollTop + event.scrollLines);
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

      const copyState: CopyModeState = {
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
        scrollTop: initialScrollTop,
      };

      enqueue(
        assign({
          copyModeStates: { ...context.copyModeStates, [event.paneId]: copyState },
        }),
      );

      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: `copy-mode -t ${event.paneId}`,
        }),
      );

      enqueue(
        sendTo('tmux', {
          type: 'FETCH_SCROLLBACK_CELLS' as const,
          paneId: event.paneId,
          start: -historySize,
          end: pane.height - 1,
        }),
      );
    },
  ),

  copyMode_exit: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'EXIT_COPY_MODE') return;
      copyModeExitTimes.set(event.paneId, Date.now());
      const newStates = { ...context.copyModeStates };
      delete newStates[event.paneId];
      enqueue(assign({ copyModeStates: newStates }));

      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: `send-keys -t ${event.paneId} -X cancel`,
        }),
      );
    },
  ),

  copyMode_chunkLoaded: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'COPY_MODE_CHUNK_LOADED') return;
      const existing = context.copyModeStates[event.paneId];
      if (!existing) return;

      const { lines, loadedRanges } = mergeScrollbackChunk(
        existing.lines,
        existing.loadedRanges,
        event.cells,
        event.historySize,
        event.start,
        event.end,
      );

      const totalLines = event.historySize + existing.height;
      const histDiff = event.historySize - existing.historySize;

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
      if (topRow > 0) {
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
    },
  ),

  copyMode_cursorMove: assign<Ctx, Evt, undefined, Evt, never>(({ event, context }) => {
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

  copyMode_selectionStart: assign<Ctx, Evt, undefined, Evt, never>(({ event, context }) => {
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

  copyMode_selectionClear: assign<Ctx, Evt, undefined, Evt, never>(({ event, context }) => {
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

  copyMode_wordSelect: assign<Ctx, Evt, undefined, Evt, never>(({ event, context }) => {
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

  copyMode_lineSelect: assign<Ctx, Evt, undefined, Evt, never>(({ event, context }) => {
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

  copyMode_scroll: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'COPY_MODE_SCROLL') return;
      const existing = context.copyModeStates[event.paneId];
      if (!existing) return;

      const maxScrollTop = existing.totalLines - existing.height;
      const scrollTop = Math.max(0, Math.min(maxScrollTop, event.scrollTop));

      if (
        maxScrollTop > 0 &&
        scrollTop >= maxScrollTop &&
        existing.scrollTop < maxScrollTop &&
        !existing.selectionMode
      ) {
        enqueue.raise({ type: 'EXIT_COPY_MODE', paneId: event.paneId });
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
    },
  ),

  copyMode_yank: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'COPY_MODE_YANK') return;
      const copyState = context.copyModeStates[event.paneId];
      if (!copyState || !copyState.selectionMode) return;

      copyModeExitTimes.set(event.paneId, Date.now());
      const newStates = { ...context.copyModeStates };
      delete newStates[event.paneId];
      enqueue(assign({ copyModeStates: newStates }));

      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: `send-keys -t ${event.paneId} -X cancel`,
        }),
      );
    },
  ),

  copyMode_key: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'COPY_MODE_KEY') return;
      const paneId = context.activePaneId;
      if (!paneId) return;
      const copyState = context.copyModeStates[paneId];
      if (!copyState) return;

      const result = handleCopyModeKey(event.key, event.ctrlKey, event.shiftKey, copyState);

      if (result.action === 'yank') {
        copyModeExitTimes.set(paneId, Date.now());
        const newStates = { ...context.copyModeStates };
        delete newStates[paneId];
        enqueue(assign({ copyModeStates: newStates }));
        enqueue(
          sendTo('tmux', {
            type: 'SEND_COMMAND' as const,
            command: `send-keys -t ${paneId} -X cancel`,
          }),
        );
        return;
      }

      if (result.action === 'exit') {
        copyModeExitTimes.set(paneId, Date.now());
        const newStates = { ...context.copyModeStates };
        delete newStates[paneId];
        enqueue(assign({ copyModeStates: newStates }));
        enqueue(
          sendTo('tmux', {
            type: 'SEND_COMMAND' as const,
            command: `send-keys -t ${paneId} -X cancel`,
          }),
        );
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
    },
  ),
};
