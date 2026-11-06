/**
 * Action implementations for the sidebars state slice.
 *
 * Owns context fields for both sidebars' open, focus, resize-preview and
 * dock-rows state.
 */

import { assign, sendTo } from 'xstate';
import { act, type Ctx, type Enqueue } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import {
  selectLeftSidebarPane,
  selectRightSidebarPane,
  selectSettledPaneWidth,
  selectSidebarLayout,
} from '../../selectors/panesAndSidebars';
import { selectDockRows } from '../../selectors/layout';
import { calculateTargetSize } from '../../../utils/layout';
import { releaseKeyboard, sidebarStartTimeoutId } from '../helpers';
import { fixedGridSize } from '../../../utils/gridFit';
import { fitWindowToSidebar } from '../../../infra/desktopWindow';

/** How long a sidebar may sit on "starting…" before the column reports a failure. */
export const SIDEBAR_START_TIMEOUT_MS = 4000;

/** Safety net: drop a resize preview the server never confirmed. */
const SIDEBAR_PREVIEW_TIMEOUT_MS = 5000;

/**
 * Tell the grid its size with `side` open or shut, the moment the toggle is
 * made: tmux re-tiles once, for the width the column leaves, rather than after
 * the container's next measure. A grid `@tmuxy-size` fixes is not re-tiled:
 * the desktop window grows by the column instead (and the grid is fitted to
 * the room left wherever it cannot).
 */
function retileFor(context: Ctx, enqueue: Enqueue, side: 'left' | 'right', willOpen: boolean) {
  if (fixedGridSize(context.sizePolicy) && !context.phoneLayout) {
    const layout = selectSidebarLayout({ ...context, [`${side}SidebarOpen`]: true });
    const width = side === 'left' ? layout.leftWidth : layout.rightWidth;
    enqueue(() => fitWindowToSidebar(side, willOpen, width));
    return;
  }
  if (context.containerHeight <= 0) return;
  const width = selectSettledPaneWidth({ ...context, [`${side}SidebarOpen`]: willOpen });
  if (width === null) return;
  const size = calculateTargetSize(context.measuredCell.charWidth, width, context.containerHeight);
  enqueue.raise({ type: 'SET_TARGET_SIZE' as const, ...size });
}

/**
 * Break the tree's pane out (`OpenSidebar`) unless a start is already on its
 * way: one window per column. A toggle that landed while the first open's
 * window was still being made used to ask for a second, and every extra one
 * lived on in tmux, hidden, for good.
 */
function startLeftSidebar(context: Ctx, enqueue: Enqueue) {
  if (context.leftSidebarStarting) return;
  enqueue(
    sendTo('tmux', {
      type: 'SEND_OP' as const,
      op: TmuxOp.OpenSidebar({ side: 'left', splitFrom: context.activePaneId }),
    }),
  );
  enqueue(assign({ leftSidebarStarting: true }));
  enqueue.raise(
    { type: 'SIDEBAR_START_TIMEOUT' as const, side: 'left' as const },
    { delay: SIDEBAR_START_TIMEOUT_MS, id: sidebarStartTimeoutId('left') },
  );
}

/** A toggle docks or shuts the column it names; a peek of that column is over. */
const endPeekOf = (context: Ctx, side: 'left' | 'right') =>
  context.sidebarPeek === side ? { sidebarPeek: null } : {};

export const sidebarsActions = {
  /**
   * The dock runs in the sidebar font, whose rows are shorter than the pane
   * grid's, so its column holds more rows than the viewport. Write that count
   * to the dock's window (`@tmuxy-sidebar-rows`) whenever it changes — the
   * backend sizes the pane from it — and only then, so the poll is not poked
   * on every state update.
   */
  sidebars_syncDockRows: act(({ context, enqueue }) => {
    const dock = context.windows.find((w) => w.windowType === 'sidebar-right');
    const rows = selectDockRows(context);
    if (!dock || rows < 1) return;
    const sent = context.dockRowsSent;
    if (sent && sent.windowId === dock.id && sent.rows === rows) return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.SetWindowTag({ windowId: dock.id, tag: 'sidebar-rows', value: String(rows) }),
      }),
    );
    enqueue(assign({ dockRowsSent: { windowId: dock.id, rows } }));
  }),

  /**
   * Collapse or expand one tab in the sidebar tree.
   */
  sidebars_toggleTabCollapse: act(({ context, event, enqueue }) => {
    if (event.type !== 'TOGGLE_TAB_COLLAPSE') return;
    const { windowId } = event;
    const collapsedTabIds = context.collapsedTabIds.includes(windowId)
      ? context.collapsedTabIds.filter((id) => id !== windowId)
      : [...context.collapsedTabIds, windowId];
    enqueue(assign({ collapsedTabIds }));
  }),

  sidebars_toggleLeftSidebar: act(({ context, enqueue }) => {
    const willOpen = !context.leftSidebarOpen;
    enqueue(
      assign({
        leftSidebarOpen: willOpen,
        leftSidebarStartFailed: false,
        ...endPeekOf(context, 'left'),
      }),
    );
    retileFor(context, enqueue, 'left', willOpen);

    if (willOpen) {
      enqueue(sendTo('servers', { type: 'REFRESH_SESSIONS' as const }));
      const pane = selectLeftSidebarPane(context);
      if (pane) {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_OP' as const,
            op: TmuxOp.SetWindowTag({
              windowId: pane.windowId,
              tag: 'sidebar-hidden',
              value: null,
            }),
          }),
        );
        enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' as const });
      } else {
        startLeftSidebar(context, enqueue);
      }
      return;
    }

    const pane = selectLeftSidebarPane(context);
    if (pane) {
      enqueue(
        sendTo('tmux', {
          type: 'SEND_OP' as const,
          op: TmuxOp.SetWindowTag({ windowId: pane.windowId, tag: 'sidebar-hidden', value: '1' }),
        }),
      );
    }
    releaseKeyboard(context, enqueue, 'left');
  }),

  sidebars_focusLeftSidebar: act(({ context, enqueue }) => {
    // A peeking column takes the keyboard where it is: over the panes, not
    // docked. It gives it back when the peek ends.
    const peeking = context.sidebarPeek === 'left';
    if (!selectLeftSidebarPane(context)) {
      if (!context.leftSidebarOpen && !peeking) {
        enqueue.raise({ type: 'TOGGLE_LEFT_SIDEBAR' as const });
      }
      return;
    }
    if (!context.leftSidebarOpen && !peeking) enqueue(assign({ leftSidebarOpen: true }));
    enqueue(assign({ leftSidebarFocused: true }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const, focused: true }));

    releaseKeyboard(context, enqueue, 'float');
    releaseKeyboard(context, enqueue, 'right');
  }),

  sidebars_blurLeftSidebar: act(({ context, enqueue }) => {
    releaseKeyboard(context, enqueue, 'left');
  }),

  sidebars_toggleRightSidebar: act(({ context, enqueue }) => {
    const willOpen = !context.rightSidebarOpen;
    enqueue(
      assign({
        rightSidebarOpen: willOpen,
        rightSidebarStartFailed: false,
        ...endPeekOf(context, 'right'),
      }),
    );
    retileFor(context, enqueue, 'right', willOpen);

    if (willOpen) {
      const pane = selectRightSidebarPane(context);
      if (pane) {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_OP' as const,
            op: TmuxOp.SetWindowTag({
              windowId: pane.windowId,
              tag: 'sidebar-hidden',
              value: null,
            }),
          }),
        );
        enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' as const });
      } else {
        enqueue.raise({ type: 'START_RIGHT_SIDEBAR' as const });
      }
      return;
    }

    const pane = selectRightSidebarPane(context);
    if (pane) {
      enqueue(
        sendTo('tmux', {
          type: 'SEND_OP' as const,
          op: TmuxOp.SetWindowTag({ windowId: pane.windowId, tag: 'sidebar-hidden', value: '1' }),
        }),
      );
    }
    releaseKeyboard(context, enqueue, 'right');
  }),

  /**
   * Break the dock's pane out (`OpenSidebar`) if nothing has yet: the
   * desktop's right column and the phone's bottom view both start it here.
   */
  sidebars_startRightSidebar: act(({ context, enqueue }) => {
    if (context.rightSidebarStarting || selectRightSidebarPane(context)) return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.OpenSidebar({ side: 'right', splitFrom: context.activePaneId }),
      }),
    );
    enqueue(assign({ rightSidebarStarting: true, rightSidebarStartFailed: false }));
    enqueue.raise(
      { type: 'SIDEBAR_START_TIMEOUT' as const, side: 'right' as const },
      { delay: SIDEBAR_START_TIMEOUT_MS, id: sidebarStartTimeoutId('right') },
    );
  }),

  sidebars_sidebarStartTimeout: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_START_TIMEOUT') return;
    if (event.side === 'left') {
      enqueue(assign({ leftSidebarStarting: false }));
      if (
        (context.leftSidebarOpen || context.sidebarPeek === 'left') &&
        !selectLeftSidebarPane(context)
      ) {
        enqueue(assign({ leftSidebarStartFailed: true }));
      }
    } else {
      enqueue(assign({ rightSidebarStarting: false }));
      if (
        (context.rightSidebarOpen || context.sidebarPeek === 'right') &&
        !selectRightSidebarPane(context)
      ) {
        enqueue(assign({ rightSidebarStartFailed: true }));
      }
    }
  }),

  sidebars_sidebarResizePreview: act(({ event, enqueue }) => {
    if (event.type !== 'SIDEBAR_RESIZE_PREVIEW') return;
    enqueue(assign({ sidebarColsPreview: { side: event.side, cols: event.cols } }));
  }),

  sidebars_sidebarResizeCommit: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_RESIZE_COMMIT') return;
    const pane =
      event.side === 'left' ? selectLeftSidebarPane(context) : selectRightSidebarPane(context);
    if (!pane) return;
    enqueue(assign({ sidebarColsPreview: { side: event.side, cols: event.cols } }));
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.SetWindowTag({
          windowId: pane.windowId,
          tag: 'sidebar-cols',
          value: event.cols === null ? null : String(event.cols),
        }),
      }),
    );
    enqueue.raise(
      { type: 'SIDEBAR_PREVIEW_EXPIRE' as const, side: event.side },
      { delay: SIDEBAR_PREVIEW_TIMEOUT_MS, id: `sidebar-preview-timeout-${event.side}` },
    );
  }),

  sidebars_sidebarPreviewExpire: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_PREVIEW_EXPIRE') return;
    if (context.sidebarColsPreview?.side === event.side) {
      enqueue(assign({ sidebarColsPreview: null }));
    }
  }),

  sidebars_focusRightSidebar: act(({ context, enqueue }) => {
    const pane = selectRightSidebarPane(context);
    if (!pane) return;
    // On a phone the dock is the bottom view, not a column to open.
    if (!context.rightSidebarOpen && !context.phoneLayout && context.sidebarPeek !== 'right') {
      enqueue(assign({ rightSidebarOpen: true }));
    }
    enqueue(assign({ rightSidebarFocused: true }));
    enqueue(
      sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: pane.tmuxId }),
    );
    releaseKeyboard(context, enqueue, 'float');
    releaseKeyboard(context, enqueue, 'left');
  }),

  sidebars_blurRightSidebar: act(({ context, enqueue }) => {
    releaseKeyboard(context, enqueue, 'right');
  }),

  /**
   * Show a closed column over the panes while the pointer rests on it or on
   * its toggle. Nothing is re-tiled and nothing is unhidden: the column's
   * window keeps `@tmuxy-sidebar-hidden`, so no other client sees it open.
   * A column whose pane was never made is started here, and arrives hidden
   * (reconcileSidebars: a start this client no longer has open).
   */
  sidebars_peekSidebar: act(({ context, event, enqueue }) => {
    if (event.type !== 'PEEK_SIDEBAR') return;
    const { side } = event;
    const open = side === 'left' ? context.leftSidebarOpen : context.rightSidebarOpen;
    if (open || context.phoneLayout || context.sidebarPeek === side) return;
    if (context.sidebarPeek) releaseKeyboard(context, enqueue, context.sidebarPeek);
    enqueue(assign({ sidebarPeek: side }));
    if (side === 'left') {
      if (selectLeftSidebarPane(context)) return;
      enqueue(assign({ leftSidebarStartFailed: false }));
      startLeftSidebar(context, enqueue);
    } else {
      if (selectRightSidebarPane(context)) return;
      enqueue(assign({ rightSidebarStartFailed: false }));
      enqueue.raise({ type: 'START_RIGHT_SIDEBAR' as const });
    }
  }),

  /** The pointer left the peek: the column goes, and takes the keyboard with it. */
  sidebars_endSidebarPeek: act(({ context, enqueue }) => {
    const side = context.sidebarPeek;
    if (!side) return;
    enqueue(assign({ sidebarPeek: null }));
    const open = side === 'left' ? context.leftSidebarOpen : context.rightSidebarOpen;
    if (!open) releaseKeyboard(context, enqueue, side);
  }),
};
