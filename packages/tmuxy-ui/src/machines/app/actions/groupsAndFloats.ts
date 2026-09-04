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
import { selectLeftSidebarPane, selectRightSidebarPane, selectDockRows } from '../../selectors';

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
 * A float names the new window's INDEX up front (see `freeWindowIndex`). A
 * sidebar is targeted by its NAME instead: its name is fixed and unique
 * (`__sidebar-left` / `__sidebar-right`, which the backend also recognises as
 * a defensive re-tag), so the list never depends on the client's copy of the
 * window indices. Those go stale for a beat after any window closes
 * (`renumber-windows` shifts the rest and `%window-close` carries no indices),
 * and a guessed index that tmux already uses made `break-pane` fail AFTER
 * `split-window` had run — leaving a raw `tmuxy widget tree` pane in the tab
 * and the column stuck on "starting…".
 *
 * An empty `command` leaves `split-window` to start the default shell in the
 * current pane's directory, which is what makes a sidebar shell open like any
 * freshly split pane.
 */
export function breakOutTaggedWindow(
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
  const byName = windowType !== 'float';
  const target = byName ? `:${name}` : `:${freeWindowIndex(windows)}`;
  const parts = [
    `split-window ${command}`.trimEnd(),
    byName ? `break-pane -d -n ${name}` : `break-pane -d -n ${name} -t ${target}`,
    `set-option -w -t ${target} @tmuxy-window-type ${windowType}`,
    ...extraOptions.map(([key, value]) => `set-option -w -t ${target} ${key} ${value}`),
  ];
  return parts.join(' \\; ');
}

/** The fixed window name of a sidebar column (see `breakOutTaggedWindow`). */
export const SIDEBAR_WINDOW_NAME = { left: '__sidebar-left', right: '__sidebar-right' } as const;

/** How long a sidebar may sit on "starting…" before the column reports a failure. */
export const SIDEBAR_START_TIMEOUT_MS = 4000;

/** Safety net: drop a resize preview the server never confirmed. */
const SIDEBAR_PREVIEW_TIMEOUT_MS = 5000;

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
   * Closing HIDES the column: `@tmuxy-sidebar-hidden` goes on its window and
   * the pane stays, exactly like the dock. Both columns therefore close the same
   * way, the choice survives a reload, and every other client sees it — a
   * column that reappeared on every reload was one of the QA findings.
   */
  /**
   * The dock runs in the sidebar font, whose rows are shorter than the pane
   * grid's, so its column holds more rows than the viewport. Write that count
   * to the dock's window (`@tmuxy-sidebar-rows`) whenever it changes — the
   * backend sizes the pane from it — and only then, so the poll is not poked
   * on every state update.
   */
  groupsAndFloats_syncDockRows: enqueueActions<
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
    const dock = context.windows.find((w) => w.windowType === 'sidebar-right');
    const rows = selectDockRows(context);
    if (!dock || rows < 1) return;
    const sent = context.dockRowsSent;
    if (sent && sent.windowId === dock.id && sent.rows === rows) return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command: `set-option -w -t ${dock.id} @tmuxy-sidebar-rows ${rows}`,
      }),
    );
    enqueue(assign({ dockRowsSent: { windowId: dock.id, rows } }));
  }),

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
    enqueue(assign({ leftSidebarOpen: willOpen, leftSidebarStartFailed: false }));

    if (willOpen) {
      // The sessions poll idles while the column is closed — kick an immediate
      // refresh so the tree isn't empty for up to a poll interval on open.
      enqueue(sendTo('servers', { type: 'REFRESH_SESSIONS' as const }));
      const pane = selectLeftSidebarPane(context);
      if (pane) {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_COMMAND' as const,
            command: `set-option -u -w -t ${pane.windowId} @tmuxy-sidebar-hidden`,
          }),
        );
        // Showing it again also hands it the keyboard. Routed through the focus
        // action so the OTHER column is blurred — only one surface at a time.
        enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' as const });
      } else {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_COMMAND' as const,
            command: breakOutTaggedWindow(context.windows, {
              command: "'tmuxy widget tree'",
              name: SIDEBAR_WINDOW_NAME.left,
              windowType: 'sidebar-left',
            }),
          }),
        );
        // If the pane never shows up (the command failed on this server), the
        // column says so instead of sitting on "starting…" forever.
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
          type: 'SEND_COMMAND' as const,
          command: `set-option -w -t ${pane.windowId} @tmuxy-sidebar-hidden 1`,
        }),
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
   * widget (j/k/Enter/l/q) via its capture-phase listener; the keyboard actor
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

  /** Return keyboard focus from the sidebar back to the panes (Ctrl+l, or l/→ in the tree). */
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
    enqueue(assign({ rightSidebarOpen: willOpen, rightSidebarStartFailed: false }));

    if (willOpen) {
      const pane = selectRightSidebarPane(context);
      if (pane) {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_COMMAND' as const,
            command: `set-option -u -w -t ${pane.windowId} @tmuxy-sidebar-hidden`,
          }),
        );
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
              name: SIDEBAR_WINDOW_NAME.right,
              windowType: 'sidebar-right',
            }),
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

    // Hiding keeps the shell: the option is what makes the close stick across
    // reloads and clients, where the window's mere existence used to reopen it.
    const pane = selectRightSidebarPane(context);
    if (pane) {
      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: `set-option -w -t ${pane.windowId} @tmuxy-sidebar-hidden 1`,
        }),
      );
    }
    if (context.rightSidebarFocused) {
      enqueue(assign({ rightSidebarFocused: false }));
      enqueue(sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: null }));
    }
  }),

  /**
   * A sidebar was asked to open a while ago and its pane still isn't there:
   * the create command failed on this server (a missing `tmuxy` CLI, a script
   * error). Flip the column into its failure state so the user learns why
   * rather than staring at "starting…".
   */
  groupsAndFloats_sidebarStartTimeout: enqueueActions<
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

  /** Draw a sidebar column at the width under the pointer while its divider is dragged. */
  groupsAndFloats_sidebarResizePreview: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, enqueue }) => {
    if (event.type !== 'SIDEBAR_RESIZE_PREVIEW') return;
    enqueue(assign({ sidebarColsPreview: { side: event.side, cols: event.cols } }));
  }),

  /**
   * The drag ended: write the width to the column's window so the backend
   * resizes the pane to match and every client (and the next reload) draws the
   * column there. The preview stays up until the server echoes the width back,
   * so the column never snaps to the old size while the round trip is in
   * flight; a safety timer drops it if the write was rejected.
   */
  groupsAndFloats_sidebarResizeCommit: enqueueActions<
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
    if (event.type !== 'SIDEBAR_RESIZE_COMMIT') return;
    const pane =
      event.side === 'left' ? selectLeftSidebarPane(context) : selectRightSidebarPane(context);
    if (!pane) return;
    enqueue(assign({ sidebarColsPreview: { side: event.side, cols: event.cols } }));
    enqueue(
      sendTo('tmux', {
        type: 'SEND_COMMAND' as const,
        command:
          event.cols === null
            ? `set-option -u -w -t ${pane.windowId} @tmuxy-sidebar-cols`
            : `set-option -w -t ${pane.windowId} @tmuxy-sidebar-cols ${event.cols}`,
      }),
    );
    enqueue.raise(
      { type: 'SIDEBAR_PREVIEW_EXPIRE' as const, side: event.side },
      { delay: SIDEBAR_PREVIEW_TIMEOUT_MS, id: `sidebar-preview-timeout-${event.side}` },
    );
  }),

  /** The server never echoed a committed width: stop drawing the preview and show what it has. */
  groupsAndFloats_sidebarPreviewExpire: enqueueActions<
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
    if (event.type !== 'SIDEBAR_PREVIEW_EXPIRE') return;
    if (context.sidebarColsPreview?.side === event.side) {
      enqueue(assign({ sidebarColsPreview: null }));
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

  /** Return keyboard focus from the dock to the panes (Ctrl+h, or a click on a pane). */
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
