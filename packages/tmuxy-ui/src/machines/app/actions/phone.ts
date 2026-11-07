/**
 * Action implementations for the phone state slice.
 *
 * The zoom: the terminal's scale in the browser — the grid, not tmux's zoom
 * — set by the bar under the keys (PhoneDivider), which also folds the
 * terminal away, or by a double tap on it or the zoom key, which jump to
 * twice the size and back (utils/phoneSplit.ts). Past its own size the
 * finger pans it. App.tsx draws it, scrolled to the point a double tap hit.
 * The split is kept per device.
 *
 * The bottom view: under the keys a phone shows the app menu, the tabs/panes
 * tree or the dock — the pinned terminal the desktop keeps in its right
 * column, the same `sidebar-right` window, created the same way on first
 * use — picked by the tab bar under them or a sideways swipe. The dock's pane is sized to the view it is drawn in
 * (SET_PHONE_DOCK_SIZE, written to the window as the desktop's drag writes a
 * dragged width), and holds the keyboard while it is in front.
 */

import { assign, sendTo } from 'xstate';
import { act } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import { selectRightSidebarPane } from '../../selectors/panesAndSidebars';
import { releaseKeyboard } from '../helpers';
import { saveSplit, toggleZoom } from '../../../utils/phoneSplit';

export const phoneActions = {
  phone_toggleZoom: act(({ context, event, enqueue }) => {
    if (event.type !== 'TOGGLE_PHONE_ZOOM') return;
    const split = toggleZoom({ zoom: context.phoneZoom, collapsed: context.phoneCollapsed });
    saveSplit(split);
    enqueue(
      assign({
        phoneZoom: split.zoom,
        phoneCollapsed: split.collapsed,
        phoneZoomAt: split.zoom > 1 ? { x: event.x ?? null, y: event.y ?? null } : null,
      }),
    );
  }),

  phone_setSplit: act(({ event, enqueue }) => {
    if (event.type !== 'SET_PHONE_SPLIT') return;
    const split = { zoom: Math.max(1, event.zoom), collapsed: event.collapsed };
    saveSplit(split);
    enqueue(assign({ phoneZoom: split.zoom, phoneCollapsed: split.collapsed, phoneZoomAt: null }));
  }),

  phone_setBottomView: act(({ context, event, enqueue }) => {
    if (event.type !== 'SET_PHONE_BOTTOM_VIEW') return;
    if (event.view === context.phoneBottomView) return;
    enqueue(assign({ phoneBottomView: event.view }));
    if (event.view !== 'dock') {
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
