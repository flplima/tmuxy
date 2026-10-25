/**
 * Cross-cutting focus, group-tab selection, drag/resize forwarding, and copy
 * selection handlers for the idle state of appMachine.
 */

import { assign, sendTo } from 'xstate';
import { act, type Ctx } from './actionTypes';
import { isPlaceholderId, type PaneId } from '../../domain/ids';
import { TmuxOp } from '../../domain/commands';
import { getActivePaneInGroup, selectRightSidebarPane } from '../selectors/panesAndSidebars';
import { releaseKeyboard } from './helpers';

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
  FOCUS_PANE: {
    actions: 'focusAndDrag_focusPane',
  },
  SELECT_PANE_GROUP_TAB: {
    actions: 'focusAndDrag_selectPaneGroupTab',
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

  focusAndDrag_focusPane: act(({ event, context, enqueue }) => {
    if (event.type !== 'FOCUS_PANE') return;
    if (selectRightSidebarPane(context)?.tmuxId === event.paneId) {
      enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' });
      return;
    }
    releaseKeyboard(context, enqueue, 'left');
    if (context.floatPanes[event.paneId]) {
      enqueue(assign({ focusedFloatPaneId: event.paneId }));
      enqueue(
        sendTo('keyboard', {
          type: 'UPDATE_FOCUSED_FLOAT' as const,
          paneId: event.paneId,
        }),
      );
      releaseKeyboard(context, enqueue, 'right');
    } else {
      releaseKeyboard(context, enqueue, 'float');
      releaseKeyboard(context, enqueue, 'right');
      const targetPane = context.panes.find((p) => p.tmuxId === event.paneId);
      const inActiveWindow = targetPane?.windowId === context.activeWindowId;
      if (event.paneId !== context.activePaneId && inActiveWindow) {
        enqueue(
          sendTo('tmuxStore', {
            type: 'DISPATCH_OP' as const,
            op: TmuxOp.SelectPane({ paneId: event.paneId }),
          }),
        );
      }
    }
  }),

  focusAndDrag_selectPaneGroupTab: act(({ event, context, enqueue }) => {
    if (event.type !== 'SELECT_PANE_GROUP_TAB') return;
    const clickedPaneId = event.paneId;

    const clickedPane = context.panes.find((p) => p.tmuxId === clickedPaneId);
    if (!clickedPane) return;

    if (clickedPaneId === context.activePaneId && clickedPane.windowId === context.activeWindowId) {
      return;
    }

    releaseKeyboard(context, enqueue, 'left');
    releaseKeyboard(context, enqueue, 'float');
    releaseKeyboard(context, enqueue, 'right');

    enqueue(assign({ activePaneId: clickedPaneId }));
    enqueue(
      sendTo('keyboard', {
        type: 'UPDATE_ACTIVE_PANE' as const,
        paneId: clickedPaneId,
      }),
    );

    const group = Object.values(context.paneGroups).find((g) => g.paneIds.includes(clickedPaneId));

    const visibleId = group ? getActivePaneInGroup(context, group) : null;
    const visiblePane = visibleId
      ? (context.panes.find((p) => p.tmuxId === visibleId) ?? null)
      : null;

    // The member already on screen has nothing to swap in, and tmux's group
    // switch does nothing for it: the click takes the pane, as a click on its
    // body does. Without the select the next tmux state hands the focus back.
    if (visiblePane?.tmuxId === clickedPaneId) {
      enqueue(
        sendTo('tmuxStore', {
          type: 'DISPATCH_OP' as const,
          op: TmuxOp.SelectPane({ paneId: clickedPaneId }),
        }),
      );
      return;
    }

    if (!group || !visiblePane) {
      enqueue(
        sendTo('tmux', {
          type: 'SEND_OP' as const,
          op: TmuxOp.GroupSwitch({ clickedPaneId, visiblePaneId: null }),
        }),
      );
      return;
    }

    enqueue(
      sendTo('tmuxStore', {
        type: 'DISPATCH_OP' as const,
        op: TmuxOp.GroupSwitch({ clickedPaneId, visiblePaneId: visiblePane.tmuxId }),
      }),
    );
  }),

  focusAndDrag_copySelection: act(({ context, enqueue }) => {
    const paneId = context.activePaneId;
    if (paneId && context.copyModeStates[paneId]) {
      if (context.copyModeStates[paneId].selectionMode) {
        enqueue.raise({ type: 'COPY_MODE_YANK', paneId });
        return;
      }
      enqueue.raise({ type: 'EXIT_COPY_MODE', paneId });
      return;
    }

    const activePane = context.activePaneId;
    const realActivePane = activePane && !isPlaceholderId(activePane) ? activePane : null;
    const dockPane = context.rightSidebarFocused
      ? (selectRightSidebarPane(context)?.tmuxId ?? null)
      : null;
    const sigintTarget =
      context.focusedFloatPaneId ?? dockPane ?? realActivePane ?? context.sessionName;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.SendKeys({ target: sigintTarget, keys: 'C-c' }),
      }),
    );
  }),
};
