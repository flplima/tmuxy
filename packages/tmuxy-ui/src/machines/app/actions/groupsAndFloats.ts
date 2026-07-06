/**
 * Action implementations for the groupsAndFloats parallel state.
 *
 * Owns context fields: paneGroups, floatPanes, focusedFloatPaneId,
 * groupSwitchDimOverrides.
 *
 * Note: SELECT_PANE_GROUP_TAB is intentionally NOT migrated here — it is a
 * cross-cutting handler that touches layout fields (panes, activePaneId)
 * during optimistic group swaps. It remains in appMachine.ts inline and
 * will be revisited as part of the layout-state migration, where the
 * coordination between the two states can be designed properly.
 */

import { assign, enqueueActions, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

export const groupsAndFloatsActions = {
  groupsAndFloats_openSessionFloat: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ enqueue }) => {
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command:
          'split-window "tmuxy session switch --float" \\; break-pane -d -n session \\; set-option -w @tmuxy-window-type float',
      }),
    );
  }),

  groupsAndFloats_openConnectFloat: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ enqueue }) => {
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command:
          'split-window "tmuxy session connect" \\; break-pane -d -n connect \\; set-option -w @tmuxy-window-type float',
      }),
    );
  }),

  groupsAndFloats_closeFloat: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, context, enqueue }) => {
    if (event.type !== 'CLOSE_FLOAT') return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command: `kill-pane -t ${event.paneId}`,
      }),
    );
    const { [event.paneId]: _removed, ...remainingFloats } = context.floatPanes;
    enqueue(assign({ floatPanes: remainingFloats }));
    if (context.focusedFloatPaneId === event.paneId) {
      const remaining = Object.values(remainingFloats);
      const nextFocused = remaining.length > 0 ? remaining[remaining.length - 1].paneId : null;
      enqueue(assign({ focusedFloatPaneId: nextFocused }));
      enqueue(
        sendTo('keyboard', {
          type: 'UPDATE_FOCUSED_FLOAT' as const,
          paneId: nextFocused,
        }),
      );
    }
  }),

  groupsAndFloats_closeTopFloat: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ context, enqueue }) => {
    const floats = Object.values(context.floatPanes);
    if (floats.length === 0) return;
    const topFloat = floats[floats.length - 1];
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command: `kill-pane -t ${topFloat.paneId}`,
      }),
    );
    const { [topFloat.paneId]: _removed, ...remainingFloats } = context.floatPanes;
    enqueue(assign({ floatPanes: remainingFloats }));
    const remaining = Object.values(remainingFloats);
    const nextFocused = remaining.length > 0 ? remaining[remaining.length - 1].paneId : null;
    enqueue(assign({ focusedFloatPaneId: nextFocused }));
    enqueue(
      sendTo('keyboard', {
        type: 'UPDATE_FOCUSED_FLOAT' as const,
        paneId: nextFocused,
      }),
    );
  }),

  /**
   * Toggle the left sidebar drawer. Lazily creates the hidden `tmuxy tree`
   * window the first time it opens (idempotent script — safe to call again).
   * Closing only hides the drawer; the window + live TUI stay alive so
   * reopening is instant and survives reconnects. When closing while focused,
   * keyboard focus returns to the panes.
   */
  groupsAndFloats_toggleSidebar: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ context, enqueue }) => {
    // The sidebar is a pure client-side React tree (SidebarTree) — no tmux
    // window/pane is created; toggling just flips the drawer's open flag.
    const willOpen = !context.sidebarOpen;
    enqueue(assign({ sidebarOpen: willOpen }));
    if (!willOpen && context.sidebarFocused) {
      enqueue(assign({ sidebarFocused: false }));
      enqueue(sendTo('keyboard', { type: 'UPDATE_SIDEBAR_FOCUSED' as const, focused: false }));
    }
  }),

  /**
   * Give the sidebar keyboard focus (via Ctrl+h from the leftmost pane or a
   * click). Subsequent keys drive the SidebarTree (j/k/Enter/Escape) via its
   * capture-phase listener; the keyboard actor stops forwarding to tmux.
   */
  groupsAndFloats_focusSidebar: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ context, enqueue }) => {
    if (!context.sidebarOpen) enqueue(assign({ sidebarOpen: true }));
    enqueue(assign({ sidebarFocused: true }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_SIDEBAR_FOCUSED' as const, focused: true }));
  }),

  /** Return keyboard focus from the sidebar back to the panes (Ctrl+l / Esc). */
  groupsAndFloats_blurSidebar: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ context, enqueue }) => {
    if (!context.sidebarFocused) return;
    enqueue(assign({ sidebarFocused: false }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_SIDEBAR_FOCUSED' as const, focused: false }));
  }),

  groupsAndFloats_clearGroupSwitchOverride: assign<Ctx, Evt, undefined, Evt, never>({
    groupSwitchDimOverrides: ({ context }) =>
      context.groupSwitchDimOverrides.filter((o) => Date.now() - o.timestamp < 750),
  }),
};
