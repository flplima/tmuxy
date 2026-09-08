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
import type { CopyModeState, CellLine, ScrollbackMode } from '../../../tmux/types';
import { handleCopyModeKey } from '../../../utils/copyModeKeys';
import { mergeScrollbackChunk, getNeededChunk, isWrappedRow } from '../../../utils/copyMode';
import { selectRightSidebarPane } from '../../selectors';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

/**
 * Build the per-pane scrollback record both views share.
 *
 * Everything here is identical for the two modes — the loaded lines seeded
 * from what is already on screen, the totals, the initial scroll position —
 * so the only thing the callers decide is `mode` and what they tell tmux
 * afterwards. Returns the geometry the caller needs for its fetch, or null
 * when the pane has gone.
 */
function buildScrollbackState(
  context: Ctx,
  paneId: string,
  mode: ScrollbackMode,
  event: { scrollLines?: number; nativeScrollTop?: number },
): { state: CopyModeState; historySize: number; height: number } | null {
  const pane = context.panes.find((p) => p.tmuxId === paneId);
  if (!pane) return null;

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
  if (event.nativeScrollTop !== undefined) {
    scrollTop = Math.max(0, Math.min(event.nativeScrollTop, bottom));
  } else if (event.scrollLines) {
    scrollTop = Math.max(0, bottom + event.scrollLines);
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
    historySize,
    height: pane.height,
    state: {
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
    },
  };
}

export const copyModeExitTimes = new Map<string, number>();
export const COPY_MODE_REENTRY_COOLDOWN = 2000;

export const copyModeActions = {
  /**
   * Open tmux's copy mode: the pane really enters `in_mode`, so the client can
   * draw its cursor and run vi motions against a viewport tmux agrees is
   * frozen. Reached by `prefix [`, a CLI `copy-mode`, or the reconciliation
   * noticing tmux entered it on its own.
   */
  copyMode_enter: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'ENTER_COPY_MODE') return;
      const built = buildScrollbackState(context, event.paneId, 'copy', event);
      if (!built) return;

      enqueue(
        assign({
          copyModeStates: { ...context.copyModeStates, [event.paneId]: built.state },
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
          start: -built.historySize,
          end: built.height - 1,
        }),
      );
    },
  ),

  /**
   * Open the native-like scrollback view. Same record, same fetch — and
   * deliberately no `copy-mode -t`: the pane keeps running, tmux never reports
   * `in_mode`, and nothing about the application's own screen changes. That
   * absence is the whole difference a user feels between this and copy mode.
   */
  copyMode_enterScroll: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'ENTER_SCROLL_MODE') return;
      const built = buildScrollbackState(context, event.paneId, 'scroll', event);
      if (!built) return;

      enqueue(
        assign({
          copyModeStates: { ...context.copyModeStates, [event.paneId]: built.state },
        }),
      );

      enqueue(
        sendTo('tmux', {
          type: 'FETCH_SCROLLBACK_CELLS' as const,
          paneId: event.paneId,
          start: -built.historySize,
          end: built.height - 1,
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
  copyMode_exitScroll: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'EXIT_SCROLL_MODE') return {};
    if (!context.copyModeStates[event.paneId]) return {};
    const newStates = { ...context.copyModeStates };
    delete newStates[event.paneId];
    return { copyModeStates: newStates };
  }),

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

      // Back at the bottom with nothing selected: the user is done looking,
      // so the pane follows live output again. Each view leaves by its own
      // door — the scroll view has no tmux mode to cancel.
      if (
        maxScrollTop > 0 &&
        scrollTop >= maxScrollTop &&
        existing.scrollTop < maxScrollTop &&
        !existing.selectionMode
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
