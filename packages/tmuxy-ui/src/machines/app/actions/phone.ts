/**
 * Action implementations for the phone state slice.
 *
 * The zoom: a double tap on the terminal (or the key row's zoom key) scales
 * the terminal up in the browser — the grid, not tmux's zoom — and the
 * finger pans around it; the same again puts it back. App.tsx draws it and
 * scrolls to the point that was tapped.
 *
 * The bottom view: under the keys a phone shows the tabs/panes tree, and a
 * sideways swipe on it flips to the dock — the pinned terminal the desktop
 * keeps in its right column, the same `sidebar-right` window, created the
 * same way on first use. The dock's pane is sized to the view it is drawn in
 * (SET_PHONE_DOCK_SIZE, written to the window as the desktop's drag writes a
 * dragged width), and holds the keyboard while it is in front.
 */

import { assign, sendTo } from 'xstate';
import { act } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import { selectRightSidebarPane } from '../../selectors/panesAndSidebars';
import { releaseKeyboard } from '../helpers';

export const phoneActions = {
  phone_toggleZoom: act(({ context, event, enqueue }) => {
    if (event.type !== 'TOGGLE_PHONE_ZOOM') return;
    enqueue(
      assign({
        phoneZoom: context.phoneZoom ? null : { x: event.x ?? null, y: event.y ?? null },
      }),
    );
  }),

  phone_setBottomView: act(({ context, event, enqueue }) => {
    if (event.type !== 'SET_PHONE_BOTTOM_VIEW') return;
    if (event.view === context.phoneBottomView) return;
    enqueue(assign({ phoneBottomView: event.view }));
    if (event.view === 'tree') {
      releaseKeyboard(context, enqueue, 'right');
      return;
    }
    if (selectRightSidebarPane(context)) {
      enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' as const });
    } else {
      enqueue.raise({ type: 'START_RIGHT_SIDEBAR' as const });
    }
  }),

  /**
   * The dock's view was measured: size its pane to it, in the dock's own
   * cells, once per size — the write pokes tmux's window list.
   */
  phone_setDockSize: act(({ context, event, enqueue }) => {
    if (event.type !== 'SET_PHONE_DOCK_SIZE') return;
    const pane = selectRightSidebarPane(context);
    if (!pane || event.cols < 1 || event.rows < 1) return;
    const sent = context.phoneDockSizeSent;
    if (
      sent &&
      sent.windowId === pane.windowId &&
      sent.cols === event.cols &&
      sent.rows === event.rows
    ) {
      return;
    }
    for (const [tag, value] of [
      ['sidebar-cols', event.cols],
      ['sidebar-rows', event.rows],
    ] as const) {
      enqueue(
        sendTo('tmux', {
          type: 'SEND_OP' as const,
          op: TmuxOp.SetWindowTag({ windowId: pane.windowId, tag, value: String(value) }),
        }),
      );
    }
    enqueue(
      assign({
        phoneDockSizeSent: { windowId: pane.windowId, cols: event.cols, rows: event.rows },
      }),
    );
  }),
};
