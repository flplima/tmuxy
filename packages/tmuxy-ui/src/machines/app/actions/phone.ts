/**
 * The zoom: the terminal's scale in the browser — the grid, not tmux's zoom
 * — set by the bar under the keys (PhoneDivider), which also folds the
 * terminal away, or by a double tap or the zoom key, which jump to twice the
 * size and back (domain/phoneSplit.ts). App.tsx draws it, scrolled to the
 * point a double tap hit. The split is kept per device.
 *
 * The bottom view: under the keys a phone shows the app menu, the tabs/panes
 * tree or the dock — the pinned terminal the desktop keeps in its right
 * column, the same `sidebar-right` window, created the same way on first
 * use — picked by the tab bar under them or a sideways swipe. The dock's
 * pane is sized to the view it is drawn in (SET_PHONE_DOCK_SIZE, written to
 * the window as the desktop's drag writes a dragged width), and holds the
 * keyboard while it is in front.
 */

import { assign } from 'xstate';
import { act } from '../actionTypes';
import { selectRightSidebarPane } from '../../selectors/panesAndSidebars';
import { releaseKeyboard } from '../helpers';
import { toggleZoom } from '../../../domain/phoneSplit';
import { savePhoneSplitPref } from '../../../infra/prefs';

export const phoneActions = {
  phone_toggleZoom: act(({ context, event, enqueue }) => {
    if (event.type !== 'TOGGLE_PHONE_ZOOM') return;
    const split = toggleZoom({ zoom: context.phoneZoom, collapsed: context.phoneCollapsed });
    savePhoneSplitPref(split);
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
    savePhoneSplitPref(split);
    enqueue(assign({ phoneZoom: split.zoom, phoneCollapsed: split.collapsed, phoneZoomAt: null }));
  }),

  phone_setBottomView: act(({ context, event, enqueue }) => {
    if (event.type !== 'SET_PHONE_BOTTOM_VIEW') return;
    if (event.view === context.phoneBottomView) return;
    enqueue(assign({ phoneBottomView: event.view }));
    if (event.view !== 'dock') {
      releaseKeyboard(enqueue, 'right');
      return;
    }
    enqueue.raise(
      selectRightSidebarPane(context)
        ? { type: 'FOCUS_SIDEBAR' as const, side: 'right' as const }
        : { type: 'START_SIDEBAR' as const, side: 'right' as const },
    );
  }),

  /** The dock's view was measured: the dock's pane is sized to it (sidebars_syncDockSize). */
  phone_setDockSize: act(({ context, event, enqueue }) => {
    if (event.type !== 'SET_PHONE_DOCK_SIZE') return;
    if (event.cols < 1 || event.rows < 1) return;
    const view = context.phoneDockView;
    if (view && view.cols === event.cols && view.rows === event.rows) return;
    enqueue(assign({ phoneDockView: { cols: event.cols, rows: event.rows } }));
    enqueue.raise({ type: 'SYNC_DOCK_SIZE' as const });
  }),
};
