/**
 * Cross-cutting focus, group-tab selection, drag/resize forwarding, and copy
 * selection handlers for the idle state of appMachine.
 */

import { assign, sendTo } from 'xstate';
import { act, type Ctx } from './actionTypes';
import type { PaneId } from '../../domain/ids';
import { TmuxOp } from '../../domain/commands';
import { selectRightSidebarPane } from '../selectors/panesAndSidebars';
import { takeKeyboard } from './helpers';
import { selectTab } from './actions/layout';
import { PANES_OWN_KEYBOARD, selectKeyFocusPane, selectKeyTarget } from '../selectors/keyboard';

/** The member of a group drawn in a tab (the others are parked in the stash). */
function shownMember(context: Ctx, members: readonly PaneId[]) {
  const tabs = new Set(context.windows.filter((w) => w.windowType === 'tab').map((w) => w.id));
  return (
    context.panes.find((p) => members.includes(p.tmuxId) && p.windowId && tabs.has(p.windowId)) ??
    null
  );
}

/** A group member parked out of view: in a group, and not in the window on screen. */
function isParkedMember(context: Ctx, paneId: PaneId): boolean {
  const pane = context.panes.find((p) => p.tmuxId === paneId);
  return !!pane?.groupId && pane.windowId !== context.activeWindowId;
}

export const focusAndDragIdleEvents = {
  DRAG_START: {
    actions: 'focusAndDrag_dragStart',
  },
  DRAG_MOVE: {
    actions: 'focusAndDrag_dragMove',
  },
  DRAG_END: {
    actions: 'focusAndDrag_dragEnd',
  },
  RESIZE_START: {
    actions: 'focusAndDrag_resizeStart',
  },
  RESIZE_MOVE: {
    actions: 'focusAndDrag_resizeMove',
  },
  RESIZE_END: {
    actions: 'focusAndDrag_resizeEnd',
  },
  SELECT_PANE: {
    actions: 'focusAndDrag_selectPane',
  },
  COPY_SELECTION: {
    actions: 'focusAndDrag_copySelection',
  },
} as const;

export const focusAndDragActions = {
  focusAndDrag_dragStart: act(({ event, context, enqueue }) => {
    if (event.type !== 'DRAG_START') return;
    const pane = context.panes.find((p) => p.tmuxId === event.paneId);
    const memberDrag = isParkedMember(context, event.paneId);
    enqueue(
      assign({
        drag: {
          draggedPaneId: event.paneId,
          targetPaneId: null,
          startX: event.startX,
          startY: event.startY,
          currentX: event.startX,
          currentY: event.startY,
          originalX: pane?.x ?? 0,
          originalY: pane?.y ?? 0,
          originalWidth: pane?.width ?? 0,
          originalHeight: pane?.height ?? 0,
          ghostX: pane?.x ?? 0,
          ghostY: pane?.y ?? 0,
          ghostWidth: pane?.width ?? 0,
          ghostHeight: pane?.height ?? 0,
          tabDrop: null,
          groupDrop: null,
          memberDrag,
          leaveSide: null,
        },
      }),
    );
    enqueue(
      sendTo('dragLogic', {
        ...event,
        panes: context.activeWindowId
          ? context.panes.filter((p) => p.windowId === context.activeWindowId)
          : context.panes,
        charWidth: context.charWidth,
        charHeight: context.charHeight,
        containerWidth: context.containerWidth,
        containerHeight: context.containerHeight,
        paneWindowId: pane?.windowId ?? null,
        panesInWindow: pane ? context.panes.filter((p) => p.windowId === pane.windowId).length : 0,
        groups: context.paneGroups,
        memberDrag,
      }),
    );
  }),

  focusAndDrag_dragMove: act(({ event, enqueue }) => {
    if (event.type !== 'DRAG_MOVE') return;
    enqueue(sendTo('dragLogic', event));
  }),

  focusAndDrag_dragEnd: act(({ enqueue }) => {
    enqueue(sendTo('dragLogic', { type: 'DRAG_END' as const }));
  }),

  focusAndDrag_resizeStart: act(({ event, context, enqueue }) => {
    if (event.type !== 'RESIZE_START') return;
    enqueue(
      sendTo('resizeLogic', {
        ...event,
        panes: context.panes,
        windows: context.windows,
        charWidth: context.charWidth,
        charHeight: context.charHeight,
      }),
    );
  }),

  focusAndDrag_resizeMove: act(({ event, enqueue }) => {
    if (event.type !== 'RESIZE_MOVE') return;
    enqueue(sendTo('resizeLogic', event));
  }),

  focusAndDrag_resizeEnd: act(({ enqueue }) => {
    enqueue(sendTo('resizeLogic', { type: 'RESIZE_END' as const }));
  }),

  /**
   * The user picked a pane — clicked it, its header tab, its tree row, a
   * notification for it. The machine works out how to get there: the dock
   * and a float take the keyboard where they are; a group member out of view
   * is swapped into its group's slot (GroupSwitch; a `select-pane` into the
   * stash would race the swap); a pane in another tab switches to that tab
   * first, since `select-pane` never changes the session's current window.
   */
  focusAndDrag_selectPane: act(({ event, context, enqueue }) => {
    if (event.type !== 'SELECT_PANE') return;
    const { paneId } = event;
    if (selectRightSidebarPane(context)?.tmuxId === paneId) {
      enqueue.raise({ type: 'FOCUS_SIDEBAR', side: 'right' });
      return;
    }
    if (context.floatPanes[paneId]) {
      takeKeyboard(enqueue, { kind: 'float', paneId });
      return;
    }
    const pane = context.panes.find((p) => p.tmuxId === paneId);
    if (!pane) return;
    takeKeyboard(enqueue, PANES_OWN_KEYBOARD);

    const group = Object.values(context.paneGroups).find((g) => g.paneIds.includes(paneId));
    const shown = group ? shownMember(context, group.paneIds) : null;
    if (group && shown?.tmuxId !== paneId) {
      if (shown && shown.windowId !== context.activeWindowId) {
        selectTab(context, enqueue, shown.windowId);
      }
      enqueue(
        sendTo('tmuxStore', {
          type: 'DISPATCH_OP' as const,
          op: TmuxOp.GroupSwitch({ clickedPaneId: paneId, visiblePaneId: shown?.tmuxId ?? null }),
        }),
      );
      return;
    }

    const inFront = pane.windowId === context.activeWindowId;
    if (!inFront) selectTab(context, enqueue, pane.windowId);
    if (inFront && paneId === context.activePaneId) return;
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.SelectPane({ paneId }),
      }),
    );
  }),

  focusAndDrag_copySelection: act(({ context, enqueue }) => {
    const paneId = selectKeyFocusPane(context);
    const copyState = paneId ? context.copyModeStates[paneId] : undefined;
    if (paneId && copyState) {
      enqueue.raise(
        copyState.selectionMode
          ? { type: 'COPY_MODE_YANK', paneId }
          : { type: 'EXIT_COPY_MODE', paneId },
      );
      return;
    }
    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.SendKeys({ target: selectKeyTarget(context), keys: 'C-c' }),
      }),
    );
  }),
};
