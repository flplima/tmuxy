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

import { assign, enqueueActions, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';
import { selectVisibleWindows } from '../../selectors';
import { isPlaceholderId, reorderCommand } from '../../../utils/tabOverview';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

/** Slot count including the trailing "+" slot. */
const slotCount = (context: Ctx) => selectVisibleWindows(context).length + 1;

/** The slot of the current tab, where the keyboard cursor starts. */
const activeSlot = (context: Ctx) => {
  const idx = selectVisibleWindows(context).findIndex((w) => w.id === context.activeWindowId);
  return idx === -1 ? 0 : idx;
};

export const tabOverviewActions = {
  tabOverview_toggle: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, enqueue }) => {
      if (context.tabOverviewOpen) {
        enqueue(assign({ tabOverviewOpen: false }));
      } else {
        enqueue(assign({ tabOverviewOpen: true, tabOverviewSelected: activeSlot(context) }));
      }
    },
  ),

  tabOverview_close: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, enqueue }) => {
      if (context.tabOverviewOpen) enqueue(assign({ tabOverviewOpen: false }));
    },
  ),

  /** Move the keyboard cursor; the grid wraps at the ends. */
  tabOverview_move: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'TAB_OVERVIEW_MOVE' || !context.tabOverviewOpen) return;
      const count = slotCount(context);
      const next = (((context.tabOverviewSelected + event.delta) % count) + count) % count;
      enqueue(assign({ tabOverviewSelected: next }));
    },
  ),

  tabOverview_select: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'TAB_OVERVIEW_SELECT') return;
      const count = slotCount(context);
      enqueue(assign({ tabOverviewSelected: Math.max(0, Math.min(event.index, count - 1)) }));
    },
  ),

  /**
   * Open the slot under the cursor (or the one given): a tab becomes current,
   * the "+" slot creates a tab. Either way the overview closes — the zoom-in
   * is the component's FLIP back to the full grid.
   */
  tabOverview_activate: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'TAB_OVERVIEW_ACTIVATE') return;
      const visible = selectVisibleWindows(context);
      const index = event.index ?? context.tabOverviewSelected;
      enqueue(assign({ tabOverviewOpen: false }));
      const target = visible[index];
      if (target) {
        if (target.id !== context.activeWindowId) {
          enqueue.raise({ type: 'SELECT_TAB', windowId: target.id, windowIndex: target.index });
        }
        return;
      }
      if (index === visible.length) enqueue.raise({ type: 'CREATE_TAB' });
    },
  ),

  /** ctrl+1…9: the Nth tab as the strip shows it, whatever its tmux index. */
  tabOverview_selectByPosition: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ context, event, enqueue }) => {
    if (event.type !== 'SELECT_TAB_BY_POSITION') return;
    const target = selectVisibleWindows(context)[event.position - 1];
    if (!target || target.id === context.activeWindowId) return;
    enqueue.raise({ type: 'SELECT_TAB', windowId: target.id, windowIndex: target.index });
  }),

  /** Drag-and-drop in the overview: put the tab at a new strip position. */
  tabOverview_reorder: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'REORDER_TAB') return;
      const visible = selectVisibleWindows(context);
      const command = reorderCommand(visible, event.windowId, event.toIndex);
      if (!command) return;
      enqueue(sendTo('tmux', { type: 'SEND_COMMAND' as const, command }));
      // The cursor follows the tab the user just moved.
      enqueue(assign({ tabOverviewSelected: Math.min(event.toIndex, visible.length - 1) }));
    },
  ),

  /** The slot's ✕ (and the tab strip's): close that tab, not the current one. */
  tabOverview_closeTab: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      // A tab tmux has not confirmed yet has no id to kill; the ✕ waits.
      if (event.type !== 'CLOSE_TAB' || isPlaceholderId(event.windowId)) return;
      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: `kill-window -t ${event.windowId}`,
        }),
      );
      // Keep the cursor on a slot that still exists once the tab is gone.
      const count = Math.max(1, slotCount(context) - 1);
      if (context.tabOverviewSelected >= count) {
        enqueue(assign({ tabOverviewSelected: count - 1 }));
      }
    },
  ),
};
