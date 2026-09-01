/**
 * Action implementations for the groupsAndFloats parallel state.
 *
 * Owns context fields: paneGroups, floatPanes, focusedFloatPaneId, and both
 * sidebars' open/focus state.
 *
 * Note: SELECT_PANE_GROUP_TAB is intentionally NOT migrated here — it is a
 * cross-cutting handler that touches layout fields (panes, activePaneId)
 * during optimistic group swaps. It remains in appMachine.ts inline and
 * will be revisited as part of the layout-state migration, where the
 * coordination between the two states can be designed properly.
 */

import { assign, enqueueActions, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents, TmuxWindow } from '../../types';
import { selectLeftSidebarPane, selectRightSidebarPane } from '../../selectors';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

/**
 * The lowest window index the session isn't using, scanning up from its lowest
 * one (so a `base-index 1` session never gets a stray window 0).
 *
 * `break-pane` picks this index on its own, but it doesn't tell us which window
 * it made — and `set-option -w` with no target resolves against the session's
 * *current* window, which `break-pane -d` deliberately leaves unchanged. Naming
 * the index up front is what lets the tag land on the NEW window inside one
 * atomic command list (tagging late would let the monitor see the `%window-add`
 * before the marker exists, and render a chrome window as a tab).
 */
function freeWindowIndex(windows: TmuxWindow[]): number {
  const used = new Set(windows.map((w) => w.index));
  let index = windows.length > 0 ? Math.min(...used) : 0;
  while (used.has(index)) index++;
  return index;
}

/**
 * Build the `split-window ; break-pane ; set-option` list that creates a
 * chrome window (a float or one of the two sidebars) running `command` and tags
 * it in one shot. `extraOptions` are further `@tmuxy-*` window options to set
 * on it.
 *
 * This is the same list `bin/tmuxy/float-create` builds for a float — the
 * sidebars are chrome windows of exactly that shape, differing only in the type
 * they are tagged with and the width the backend then sizes them to.
 *
 * An empty `command` leaves `split-window` to start the default shell in the
 * current pane's directory, which is what makes a sidebar shell open like any
 * freshly split pane.
 */
function breakOutTaggedWindow(
  windows: TmuxWindow[],
  {
    command = '',
    name,
    windowType,
    extraOptions = [],
  }: {
    command?: string;
    name: string;
    windowType: 'float' | 'sidebar-left' | 'sidebar-right';
    extraOptions?: Array<[string, string]>;
  },
): string {
  const index = freeWindowIndex(windows);
  const parts = [
    `split-window ${command}`.trimEnd(),
    `break-pane -d -n ${name} -t :${index}`,
    `set-option -w -t :${index} @tmuxy-window-type ${windowType}`,
    ...extraOptions.map(([key, value]) => `set-option -w -t :${index} ${key} ${value}`),
  ];
  return parts.join(' \\; ');
}

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
  >(({ context, enqueue }) => {
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command: breakOutTaggedWindow(context.windows, {
          command: '"tmuxy session switch --float"',
          name: 'session',
          windowType: 'float',
        }),
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
  >(({ context, enqueue }) => {
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command: breakOutTaggedWindow(context.windows, {
          command: '"tmuxy session connect"',
          name: 'connect',
          windowType: 'float',
        }),
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
   * Toggle the left sidebar — the tree column.
   *
   * Like the right column, it is a real tmux pane in a tagged chrome window,
   * created on first open. What it runs is `tmuxy widget tree`, which prints the
   * widget marker and then blocks: the tree itself is rendered by React from the
   * state the app already holds, so the pane carries no content. It exists to
   * give the column a pane identity — something `ctrl+hjkl` can navigate into,
   * the backend can size, and the keyboard can be routed to.
   *
   * Closing hides the column and kills the pane: unlike the right column there
   * is nothing running in it worth preserving, and a stale tree pane would keep
   * a window in the session for no reason.
   */
  groupsAndFloats_toggleLeftSidebar: enqueueActions<
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
    const willOpen = !context.leftSidebarOpen;
    enqueue(assign({ leftSidebarOpen: willOpen }));

    if (willOpen) {
      // The sessions poll idles while the column is closed — kick an immediate
      // refresh so the tree isn't empty for up to a poll interval on open.
      enqueue(sendTo('servers', { type: 'REFRESH_SESSIONS' as const }));
      const pane = selectLeftSidebarPane(context);
      if (pane) {
        // Showing it again also hands it the keyboard. Routed through the focus
        // action so the OTHER column is blurred — only one surface at a time.
        enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' as const });
      } else {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_COMMAND' as const,
            command: breakOutTaggedWindow(context.windows, {
              command: "'tmuxy widget tree'",
              name: 'tree',
              windowType: 'sidebar-left',
            }),
          }),
        );
      }
      return;
    }

    const pane = selectLeftSidebarPane(context);
    if (pane) {
      enqueue(
        sendTo('tmux', { type: 'SEND_COMMAND' as const, command: `kill-pane -t ${pane.tmuxId}` }),
      );
    }
    if (context.leftSidebarFocused) {
      enqueue(assign({ leftSidebarFocused: false }));
      enqueue(sendTo('keyboard', { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const, focused: false }));
    }
  }),

  /**
   * Give the tree column keyboard focus (via Ctrl+h from the leftmost pane, a
   * click, or a `tmuxy nav left` focus request). Subsequent keys drive the tree
   * widget (j/k/Enter/Escape) via its capture-phase listener; the keyboard actor
   * stops forwarding to tmux.
   */
  groupsAndFloats_focusLeftSidebar: enqueueActions<
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
    // Nothing to focus until the column's pane exists; the toggle creates it and
    // the lifecycle re-raises this once it lands.
    if (!selectLeftSidebarPane(context)) {
      if (!context.leftSidebarOpen) enqueue.raise({ type: 'TOGGLE_LEFT_SIDEBAR' as const });
      return;
    }
    if (!context.leftSidebarOpen) enqueue(assign({ leftSidebarOpen: true }));
    enqueue(assign({ leftSidebarFocused: true }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const, focused: true }));

    // Exactly one surface holds the keyboard, so taking it blurs the others.
    if (context.focusedFloatPaneId) {
      enqueue(assign({ focusedFloatPaneId: null }));
      enqueue(sendTo('keyboard', { type: 'UPDATE_FOCUSED_FLOAT' as const, paneId: null }));
    }
    if (context.rightSidebarFocused) {
      enqueue(assign({ rightSidebarFocused: false }));
      enqueue(sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: null }));
    }
  }),

  /** Return keyboard focus from the sidebar back to the panes (Ctrl+l / Esc). */
  groupsAndFloats_blurLeftSidebar: enqueueActions<
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
    if (!context.leftSidebarFocused) return;
    enqueue(assign({ leftSidebarFocused: false }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const, focused: false }));
  }),

  /**
   * Toggle the right sidebar — the pinned terminal.
   *
   * A real tmux pane in a `sidebar-right`-typed window, created on first open.
   * It runs nothing in particular: `split-window` with no command starts the
   * default shell in the current pane's directory, so the column opens exactly
   * like a freshly split pane rather than somewhere surprising.
   *
   * Closing only hides the column: the window and whatever the user left
   * running in it stay alive, so reopening — on any tab, after a reconnect, or
   * from another client — lands back on the same session-wide terminal.
   */
  groupsAndFloats_toggleRightSidebar: enqueueActions<
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
    const willOpen = !context.rightSidebarOpen;
    enqueue(assign({ rightSidebarOpen: willOpen }));

    if (willOpen) {
      const pane = selectRightSidebarPane(context);
      if (pane) {
        // Already running — showing it again also hands it the keyboard, so the
        // user can type into what they just asked to see. Routed through the
        // focus action so the OTHER column is blurred.
        enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' as const });
      } else {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_COMMAND' as const,
            // No command: tmux starts the default shell in the pane's own
            // directory. Focus follows once the pane actually exists (see
            // appMachine's sidebar lifecycle reconciliation).
            command: breakOutTaggedWindow(context.windows, {
              name: 'terminal',
              windowType: 'sidebar-right',
            }),
          }),
        );
      }
      return;
    }

    if (context.rightSidebarFocused) {
      enqueue(assign({ rightSidebarFocused: false }));
      enqueue(sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: null }));
    }
  }),

  /**
   * Give the dock keyboard focus (a click, or Ctrl+l from the rightmost pane).
   * Keys route to its pane the same way a focused float's do — never via
   * `select-pane`, which would switch the active window and blank the tab.
   */
  groupsAndFloats_focusRightSidebar: enqueueActions<
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
    const pane = selectRightSidebarPane(context);
    if (!pane) return;
    if (!context.rightSidebarOpen) enqueue(assign({ rightSidebarOpen: true }));
    enqueue(assign({ rightSidebarFocused: true }));
    enqueue(
      sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: pane.tmuxId }),
    );
    // The two overlays are mutually exclusive keyboard targets.
    if (context.focusedFloatPaneId) {
      enqueue(assign({ focusedFloatPaneId: null }));
      enqueue(sendTo('keyboard', { type: 'UPDATE_FOCUSED_FLOAT' as const, paneId: null }));
    }
    if (context.leftSidebarFocused) {
      enqueue(assign({ leftSidebarFocused: false }));
      enqueue(sendTo('keyboard', { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const, focused: false }));
    }
  }),

  /** Return keyboard focus from the dock to the panes (Ctrl+h / Esc). */
  groupsAndFloats_blurRightSidebar: enqueueActions<
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
    if (!context.rightSidebarFocused) return;
    enqueue(assign({ rightSidebarFocused: false }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: null }));
  }),
};
