/**
 * Tab Overview actions — the Safari-style "all tabs" view.
 *
 * Owns context fields: tabOverviewOpen, tabOverviewSelected.
 *
 * The overview is a client-side surface over the pane area: opening it zooms
 * the current tab out into a grid of every tab; picking a slot zooms that tab
 * back in and makes it current. Slot order is the tab strip's order (the
 * index-ordered visible windows), and `tabOverviewSelected` is the keyboard
 * cursor over those slots plus one extra trailing slot, the "+" that creates a
 * tab. Everything that changes tmux (select, reorder, close, create) goes
 * through the same events the rest of the app uses, so the overview never
 * invents a second path to the server.
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx, type Ctx } from '../actionTypes';
import { isPlaceholderId } from '../../../domain/ids';
import { selectVisibleWindows } from '../../selectors/panesAndSidebars';
import { reorderOp } from '../../../utils/tabOverview';
import { TmuxOp } from '../../../domain/commands';

/** Slot count including the trailing "+" slot — which a read-only client, with nothing to create, does not have. */
const slotCount = (context: Ctx) =>
  selectVisibleWindows(context).length + (context.readOnly ? 0 : 1);

/** The slot of the current tab, where the keyboard cursor starts. */
const activeSlot = (context: Ctx) => {
  const idx = selectVisibleWindows(context).findIndex((w) => w.id === context.activeWindowId);
  return idx === -1 ? 0 : idx;
};

const closed = { tabOverviewOpen: false } as const;

export const tabOverviewActions = {
  tabOverview_toggle: act(({ context, enqueue }) => {
    if (context.tabOverviewOpen) {
      enqueue(assign(closed));
    } else {
      enqueue(
        assign({
          tabOverviewOpen: true,
          tabOverviewSelected: activeSlot(context),
        }),
      );
    }
  }),

  tabOverview_close: act(({ context, enqueue }) => {
    if (context.tabOverviewOpen) enqueue(assign(closed));
  }),

  /** Move the keyboard cursor; the grid wraps at the ends. */
  tabOverview_move: act(({ context, event, enqueue }) => {
    if (event.type !== 'TAB_OVERVIEW_MOVE' || !context.tabOverviewOpen) return;
    const count = slotCount(context);
    const next = (((context.tabOverviewSelected + event.delta) % count) + count) % count;
    enqueue(assign({ tabOverviewSelected: next }));
  }),

  /**
   * Open the slot under the cursor (or the one given): a tab becomes current,
   * the "+" slot creates a tab. Either way the overview closes — the zoom-in
   * is the component's FLIP back to the full grid.
   */
  tabOverview_activate: act(({ context, event, enqueue }) => {
    if (event.type !== 'TAB_OVERVIEW_ACTIVATE') return;
    const visible = selectVisibleWindows(context);
    const index = event.index ?? context.tabOverviewSelected;
    enqueue(assign(closed));
    const target = visible[index];
    if (target) {
      if (target.id !== context.activeWindowId) {
        enqueue.raise({ type: 'SELECT_TAB', windowId: target.id });
      }
      return;
    }
    if (index === visible.length) enqueue.raise({ type: 'CREATE_TAB' });
  }),

  /** ctrl+1…9: the Nth tab as the strip shows it, whatever its tmux index. */
  tabOverview_selectByPosition: act(({ context, event, enqueue }) => {
    if (event.type !== 'SELECT_TAB_BY_POSITION') return;
    const target = selectVisibleWindows(context)[event.position - 1];
    if (!target || target.id === context.activeWindowId) return;
    enqueue.raise({ type: 'SELECT_TAB', windowId: target.id });
  }),

  /** Drag-and-drop in the overview: put the tab at a new strip position. */
  tabOverview_reorder: act(({ context, event, enqueue }) => {
    if (event.type !== 'REORDER_TAB') return;
    const visible = selectVisibleWindows(context);
    const op = reorderOp(visible, event.windowId, event.toIndex);
    if (!op) return;
    // Routed through the store: the strip shows the new order from the drop
    // on, not from tmux's echo on.
    enqueue.raise({ type: 'DISPATCH_OP', op });
    // The cursor follows the tab the user just moved.
    enqueue(assign({ tabOverviewSelected: Math.min(event.toIndex, visible.length - 1) }));
  }),

  /** TAB mode's `<` / `>`: the active tab one place along the strip. */
  tabOverview_moveActive: act(({ context, event, enqueue }) => {
    if (event.type !== 'MOVE_ACTIVE_TAB' || !context.activeWindowId) return;
    const from = selectVisibleWindows(context).findIndex((w) => w.id === context.activeWindowId);
    if (from === -1) return;
    enqueue.raise({
      type: 'REORDER_TAB',
      windowId: context.activeWindowId,
      toIndex: from + event.by,
    });
  }),

  /**
   * Rename Tab from the app menu or the native menu bar: the strip opens its
   * field on the active tab, the same one its context menu opens, instead of
   * the tmux prompt at the bottom of the window asking for a name a long way
   * from the thing being named.
   */
  tabOverview_requestRename: assignCtx(({ context }) => ({
    tabRenameRequest:
      context.activeWindowId && !isPlaceholderId(context.activeWindowId)
        ? context.activeWindowId
        : null,
  })),

  tabOverview_renameRequestTaken: assignCtx(() => ({ tabRenameRequest: null })),

  /** Stacked panes on the active tab: a window option the backend reads (docs/TMUX.md). */
  tabOverview_toggleStacked: act(({ context, enqueue }) => {
    const window = context.windows.find((w) => w.id === context.activeWindowId);
    if (!window || isPlaceholderId(window.id)) return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.SetWindowTag({
          windowId: window.id,
          tag: 'collapsible',
          value: window.collapsible ? null : '1',
        }),
      }),
    );
  }),

  /** The slot's ✕ (and the tab strip's): close that tab, not the current one. */
  tabOverview_closeTab: act(({ context, event, enqueue }) => {
    // A tab tmux has not confirmed yet has no id to kill; the ✕ waits.
    if (event.type !== 'CLOSE_TAB' || isPlaceholderId(event.windowId)) return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.KillWindow({ windowId: event.windowId }),
      }),
    );
    // Keep the cursor on a slot that still exists once the tab is gone.
    const count = Math.max(1, slotCount(context) - 1);
    if (context.tabOverviewSelected >= count) {
      enqueue(assign({ tabOverviewSelected: count - 1 }));
    }
  }),
};
