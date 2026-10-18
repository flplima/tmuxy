/**
 * Action implementations for the sidebars state slice.
 *
 * Owns context fields for both sidebars' open, fixed, focus, resize-preview,
 * dock-rows, and motion state.
 */

import { assign, sendTo } from 'xstate';
import { act, type Ctx, type Enqueue } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import {
  selectLeftSidebarPane,
  selectRightSidebarPane,
  selectSettledPaneWidth,
} from '../../selectors/panesAndSidebars';
import { selectDockRows } from '../../selectors/layout';
import { calculateTargetSize } from '../../../utils/layout';
import { saveSidebarFixed } from '../../../utils/sidebarDock';
import { SIDEBAR_MOTION_SETTLE_MS } from '../../constants';
import { releaseKeyboard } from '../helpers';

/** How long a sidebar may sit on "starting…" before the column reports a failure. */
export const SIDEBAR_START_TIMEOUT_MS = 4000;

const SIDEBAR_MOTION_ID = 'sidebar-motion';

/** Safety net: drop a resize preview the server never confirmed. */
const SIDEBAR_PREVIEW_TIMEOUT_MS = 5000;

/**
 * The pane grid's size once the columns have finished sliding, from the app
 * body's width minus whatever will be docked beside the grid. Null before the
 * body has been measured, or while a column overlays (the grid's width does
 * not change then).
 */
function settledTargetSize(context: Ctx): { cols: number; rows: number } | null {
  if (context.containerHeight <= 0) return null;
  const width = selectSettledPaneWidth(context);
  if (width === null) return null;
  return calculateTargetSize(context.charWidth, width, context.containerHeight);
}

/**
 * Start a column sliding. The grid is told its settled size right away so
 * tmux re-tiles once, under the moving column, instead of once per frame of
 * the slide; SET_TARGET_SIZE drops the in-between sizes until the settle
 * event, which is (re)armed here so a toggle mid-slide simply extends it.
 */
function beginSidebarMotion(
  context: Ctx,
  enqueue: Enqueue,
  side: 'left' | 'right',
  willOpen: boolean,
) {
  const next: Ctx = {
    ...context,
    sidebarMotion: true,
    [`${side}SidebarOpen`]: willOpen,
    [`${side}SidebarClosing`]: !willOpen,
  };
  enqueue(
    assign({
      sidebarMotion: true,
      [`${side}SidebarClosing`]: !willOpen,
    }),
  );
  enqueue.cancel(SIDEBAR_MOTION_ID);
  enqueue.raise(
    { type: 'SIDEBAR_MOTION_SETTLED' as const },
    { delay: SIDEBAR_MOTION_SETTLE_MS, id: SIDEBAR_MOTION_ID },
  );
  const size = settledTargetSize(next);
  if (size) enqueue.raise({ type: 'SET_TARGET_SIZE' as const, ...size, force: true });
}

export const sidebarsActions = {
  /**
   * The dock runs in the sidebar font, whose rows are shorter than the pane
   * grid's, so its column holds more rows than the viewport. Write that count
   * to the dock's window (`@tmuxy-sidebar-rows`) whenever it changes — the
   * backend sizes the pane from it — and only then, so the poll is not poked
   * on every state update.
   */
  sidebars_syncDockRows: act(({ context, enqueue }) => {
    if (context.readOnly) return;
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

  /**
   * `prefix s` / `prefix S`: open that column, or — when it is already open —
   * fix it beside the grid (docked, reflowing the panes) or free it to
   * overlay them.
   */
  sidebars_sidebarKey: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_KEY') return;
    const left = event.side === 'left';
    if (!(left ? context.leftSidebarOpen : context.rightSidebarOpen)) {
      enqueue.raise({
        type: left ? ('TOGGLE_LEFT_SIDEBAR' as const) : ('TOGGLE_RIGHT_SIDEBAR' as const),
      });
      return;
    }
    const fixed = {
      left: left ? !context.leftSidebarFixed : context.leftSidebarFixed,
      right: left ? context.rightSidebarFixed : !context.rightSidebarFixed,
    };
    saveSidebarFixed(fixed);
    enqueue(assign({ leftSidebarFixed: fixed.left, rightSidebarFixed: fixed.right }));
  }),

  sidebars_toggleLeftSidebar: act(({ context, enqueue }) => {
    const willOpen = !context.leftSidebarOpen;
    enqueue(assign({ leftSidebarOpen: willOpen, leftSidebarStartFailed: false }));
    beginSidebarMotion(context, enqueue, 'left', willOpen);

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
        enqueue(
          sendTo('tmux', {
            type: 'SEND_OP' as const,
            op: TmuxOp.OpenSidebar({ side: 'left', splitFrom: context.activePaneId }),
          }),
        );
        enqueue(assign({ leftSidebarStarting: true }));
        enqueue.raise(
          { type: 'SIDEBAR_START_TIMEOUT' as const, side: 'left' as const },
          { delay: SIDEBAR_START_TIMEOUT_MS },
        );
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
    if (!selectLeftSidebarPane(context)) {
      if (!context.leftSidebarOpen) enqueue.raise({ type: 'TOGGLE_LEFT_SIDEBAR' as const });
      return;
    }
    if (!context.leftSidebarOpen) enqueue(assign({ leftSidebarOpen: true }));
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
    enqueue(assign({ rightSidebarOpen: willOpen, rightSidebarStartFailed: false }));
    beginSidebarMotion(context, enqueue, 'right', willOpen);

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
        enqueue(
          sendTo('tmux', {
            type: 'SEND_OP' as const,
            op: TmuxOp.OpenSidebar({ side: 'right', splitFrom: context.activePaneId }),
          }),
        );
        enqueue(assign({ rightSidebarStarting: true }));
        enqueue.raise(
          { type: 'SIDEBAR_START_TIMEOUT' as const, side: 'right' as const },
          { delay: SIDEBAR_START_TIMEOUT_MS },
        );
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

  sidebars_sidebarMotionSettled: act(({ context, enqueue }) => {
    enqueue(
      assign({ sidebarMotion: false, leftSidebarClosing: false, rightSidebarClosing: false }),
    );
    if (context.containerWidth > 0 && context.containerHeight > 0) {
      const size = calculateTargetSize(
        context.charWidth,
        context.containerWidth,
        context.containerHeight,
      );
      enqueue.raise({ type: 'SET_TARGET_SIZE' as const, ...size, force: true });
    }
  }),

  sidebars_sidebarStartTimeout: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_START_TIMEOUT') return;
    if (event.side === 'left') {
      enqueue(assign({ leftSidebarStarting: false }));
      if (context.leftSidebarOpen && !selectLeftSidebarPane(context)) {
        enqueue(assign({ leftSidebarStartFailed: true }));
      }
    } else {
      enqueue(assign({ rightSidebarStarting: false }));
      if (context.rightSidebarOpen && !selectRightSidebarPane(context)) {
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
    if (!context.rightSidebarOpen) enqueue(assign({ rightSidebarOpen: true }));
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
};
