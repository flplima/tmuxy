/**
 * Action implementations for the groupsAndFloats state slice.
 *
 * Owns context fields: paneGroups, floatPanes, focusedFloatPaneId, and both
 * sidebars' open/focus state.
 *
 * SELECT_PANE_GROUP_TAB lives inline in appMachine.ts: it touches layout
 * fields (panes, activePaneId) during optimistic group swaps.
 */

import { assign, sendTo } from 'xstate';
import { act, type Ctx, type Enqueue, type EnqueueAction } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import type { TmuxWindow } from '../../types';
import {
  selectLeftSidebarPane,
  selectRightSidebarPane,
  selectDockRows,
  selectSettledPaneWidth,
  visibleFloats,
} from '../../selectors';
import { calculateTargetSize } from '../../../utils/layout';
import { SIDEBAR_MOTION_SETTLE_MS } from '../../constants';

/**
 * The lowest window index the session isn't using, scanning up from its lowest
 * one (so a `base-index 1` session never gets a stray window 0) — where a new
 * float is created (see `OpenFloat`).
 *
 * `break-pane` picks this index on its own, but it doesn't tell us which window
 * it made — and `set-option -w` with no target resolves against the session's
 * *current* window, which `break-pane -d` deliberately leaves unchanged. Naming
 * the index up front is what lets the tag land on the NEW window inside one
 * atomic command list (tagging late would let the monitor see the `%window-add`
 * before the marker exists, and render a chrome window as a tab).
 */
export function freeWindowIndex(windows: TmuxWindow[]): number {
  const used = new Set(windows.map((w) => w.index));
  let index = windows.length > 0 ? Math.min(...used) : 0;
  while (used.has(index)) index++;
  return index;
}

/** How long a sidebar may sit on "starting…" before the column reports a failure. */
export const SIDEBAR_START_TIMEOUT_MS = 4000;

const SIDEBAR_MOTION_ID = 'sidebar-motion';

/**
 * The pane grid's size once the columns have finished sliding, from the app
 * body's width minus whatever will be docked beside the grid. Null before the
 * body has been measured, or while a column overlays (the grid's width does
 * not change then).
 */
function settledTargetSize(context: Ctx): { cols: number; rows: number } | null {
  if (context.containerHeight <= 0) return null;
  // The same width `PaneLayout` centres the grid against while the columns
  // move — one source of truth, so the grid cannot be tiled for one width and
  // positioned against another.
  const width = selectSettledPaneWidth(context);
  if (width === null) return null;
  return calculateTargetSize(context.charWidth, width, context.containerHeight);
}

/**
 * Start a column sliding. The grid is told its settled size right away so
 * tmux re-tiles once, under the moving column, instead of once per frame of
 * the slide; SET_TARGET_SIZE drops the in-between sizes until the settle
 * event, which is (re)armed here so a toggle mid-slide simply extends it.
 */
function beginSidebarMotion(
  context: Ctx,
  enqueue: Enqueue,
  side: 'left' | 'right',
  willOpen: boolean,
) {
  const next: Ctx = {
    ...context,
    sidebarMotion: true,
    [`${side}SidebarOpen`]: willOpen,
    [`${side}SidebarClosing`]: !willOpen,
  };
  enqueue(
    assign({
      sidebarMotion: true,
      [`${side}SidebarClosing`]: !willOpen,
    }),
  );
  enqueue.cancel(SIDEBAR_MOTION_ID);
  enqueue.raise(
    { type: 'SIDEBAR_MOTION_SETTLED' as const },
    { delay: SIDEBAR_MOTION_SETTLE_MS, id: SIDEBAR_MOTION_ID },
  );
  const size = settledTargetSize(next);
  if (size) enqueue.raise({ type: 'SET_TARGET_SIZE' as const, ...size, force: true });
}

/** The surfaces that can hold the keyboard away from the tiled panes. */
export type KeyboardSurface = 'left' | 'right' | 'float';

/**
 * Take the keyboard back from a surface, when it holds it: the focus flag
 * here and the keyboard actor's record of it, which is what re-aims the next
 * keystroke. Exactly one surface holds the keyboard, so whatever takes it —
 * a pane click, a group tab, the other column — releases the others through
 * this; a column that vanished or was hidden releases itself the same way.
 */
export function releaseKeyboard(context: Ctx, enqueue: EnqueueAction, surface: KeyboardSurface) {
  if (surface === 'left') {
    if (!context.leftSidebarFocused) return;
    enqueue(assign({ leftSidebarFocused: false }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_LEFT_SIDEBAR_FOCUSED' as const, focused: false }));
  } else if (surface === 'right') {
    if (!context.rightSidebarFocused) return;
    enqueue(assign({ rightSidebarFocused: false }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: null }));
  } else {
    if (!context.focusedFloatPaneId) return;
    enqueue(assign({ focusedFloatPaneId: null }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_FOCUSED_FLOAT' as const, paneId: null }));
  }
}

/** Safety net: drop a resize preview the server never confirmed. */
const SIDEBAR_PREVIEW_TIMEOUT_MS = 5000;

export const groupsAndFloatsActions = {
  groupsAndFloats_openConnectFloat: act(({ context, enqueue }) => {
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.OpenFloat({
          name: 'connect',
          run: 'tmuxy connect',
          index: freeWindowIndex(context.windows),
          splitFrom: context.activePaneId,
        }),
      }),
    );
  }),

  /**
   * Hand the keyboard to the float of the tab now in front of the user, or back
   * to that tab's panes when it has none.
   *
   * A float belongs to the tab it was opened over, so a tab switch takes one
   * off screen and can bring another up, and the keyboard has to follow: it
   * cannot stay on a surface nobody can see. The tab switch raises this because
   * it flips the active window optimistically - by the time the server's model
   * update arrives, the float on the new tab no longer looks like one that just
   * came into view.
   */
  groupsAndFloats_syncFloatFocus: act(({ context, enqueue }) => {
    const floats = visibleFloats(context.floatPanes, context.windows, context.activeWindowId);
    const next = floats.length > 0 ? floats[floats.length - 1].paneId : null;
    if (next === context.focusedFloatPaneId) return;
    enqueue(assign({ focusedFloatPaneId: next }));
    enqueue(sendTo('keyboard', { type: 'UPDATE_FOCUSED_FLOAT' as const, paneId: next }));
  }),

  groupsAndFloats_closeFloat: act(({ event, context, enqueue }) => {
    if (event.type !== 'CLOSE_FLOAT') return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.KillPane({ paneId: event.paneId }),
      }),
    );
    const { [event.paneId]: _removed, ...remainingFloats } = context.floatPanes;
    enqueue(assign({ floatPanes: remainingFloats }));
    if (context.focusedFloatPaneId === event.paneId) {
      const remaining = visibleFloats(remainingFloats, context.windows, context.activeWindowId);
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

  groupsAndFloats_closeTopFloat: act(({ context, enqueue }) => {
    // Only a float on the tab in front of the user: Escape must never kill one
    // sitting over another tab.
    const floats = visibleFloats(context.floatPanes, context.windows, context.activeWindowId);
    if (floats.length === 0) return;
    const topFloat = floats[floats.length - 1];
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.KillPane({ paneId: topFloat.paneId }),
      }),
    );
    const { [topFloat.paneId]: _removed, ...remainingFloats } = context.floatPanes;
    enqueue(assign({ floatPanes: remainingFloats }));
    const remaining = visibleFloats(remainingFloats, context.windows, context.activeWindowId);
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
  groupsAndFloats_syncDockRows: act(({ context, enqueue }) => {
    if (context.readOnly) return;
    const dock = context.windows.find((w) => w.windowType === 'sidebar-right');
    const rows = selectDockRows(context);
    if (!dock || rows < 1) return;
    const sent = context.dockRowsSent;
    if (sent && sent.windowId === dock.id && sent.rows === rows) return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.SetWindowTag({ windowId: dock.id, tag: 'sidebar-rows', value: String(rows) }),
      }),
    );
    enqueue(assign({ dockRowsSent: { windowId: dock.id, rows } }));
  }),

  /**
   * Collapse or expand one tab in the sidebar tree.
   *
   * Only collapsed tabs are recorded, so "expanded" needs no entry and a tab
   * that goes away takes its entry with it — a tmux window id is never reused
   * within a session.
   */
  groupsAndFloats_toggleTabCollapse: act(({ context, event, enqueue }) => {
    if (event.type !== 'TOGGLE_TAB_COLLAPSE') return;
    const { windowId } = event;
    const collapsedTabIds = context.collapsedTabIds.includes(windowId)
      ? context.collapsedTabIds.filter((id) => id !== windowId)
      : [...context.collapsedTabIds, windowId];
    enqueue(assign({ collapsedTabIds }));
  }),

  groupsAndFloats_toggleLeftSidebar: act(({ context, enqueue }) => {
    const willOpen = !context.leftSidebarOpen;
    enqueue(assign({ leftSidebarOpen: willOpen, leftSidebarStartFailed: false }));
    beginSidebarMotion(context, enqueue, 'left', willOpen);

    if (willOpen) {
      // The sessions poll idles while the column is closed — kick an immediate
      // refresh so the tree isn't empty for up to a poll interval on open.
      enqueue(sendTo('servers', { type: 'REFRESH_SESSIONS' as const }));
      const pane = selectLeftSidebarPane(context);
      if (pane) {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_OP' as const,
            op: TmuxOp.SetWindowTag({
              windowId: pane.windowId,
              tag: 'sidebar-hidden',
              value: null,
            }),
          }),
        );
        // Showing it again also hands it the keyboard. Routed through the focus
        // action so the OTHER column is blurred — only one surface at a time.
        enqueue.raise({ type: 'FOCUS_LEFT_SIDEBAR' as const });
      } else {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_OP' as const,
            op: TmuxOp.OpenSidebar({ side: 'left', splitFrom: context.activePaneId }),
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
          type: 'SEND_OP' as const,
          op: TmuxOp.SetWindowTag({ windowId: pane.windowId, tag: 'sidebar-hidden', value: '1' }),
        }),
      );
    }
    releaseKeyboard(context, enqueue, 'left');
  }),

  /**
   * Give the tree column keyboard focus (via Ctrl+h from the leftmost pane, a
   * click, or a `tmuxy nav left` focus request). Subsequent keys drive the tree
   * widget (j/k/Enter/l/q) via its capture-phase listener; the keyboard actor
   * stops forwarding to tmux.
   */
  groupsAndFloats_focusLeftSidebar: act(({ context, enqueue }) => {
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
    releaseKeyboard(context, enqueue, 'float');
    releaseKeyboard(context, enqueue, 'right');
  }),

  /** Return keyboard focus from the sidebar back to the panes (Ctrl+l, or l/→ in the tree). */
  groupsAndFloats_blurLeftSidebar: act(({ context, enqueue }) => {
    releaseKeyboard(context, enqueue, 'left');
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
  groupsAndFloats_toggleRightSidebar: act(({ context, enqueue }) => {
    const willOpen = !context.rightSidebarOpen;
    enqueue(assign({ rightSidebarOpen: willOpen, rightSidebarStartFailed: false }));
    beginSidebarMotion(context, enqueue, 'right', willOpen);

    if (willOpen) {
      const pane = selectRightSidebarPane(context);
      if (pane) {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_OP' as const,
            op: TmuxOp.SetWindowTag({
              windowId: pane.windowId,
              tag: 'sidebar-hidden',
              value: null,
            }),
          }),
        );
        // Already running — showing it again also hands it the keyboard, so the
        // user can type into what they just asked to see. Routed through the
        // focus action so the OTHER column is blurred.
        enqueue.raise({ type: 'FOCUS_RIGHT_SIDEBAR' as const });
      } else {
        enqueue(
          sendTo('tmux', {
            type: 'SEND_OP' as const,
            // The dock runs the default shell, in the pane's own directory.
            // Focus follows once the pane actually exists (see appMachine's
            // sidebar lifecycle reconciliation).
            op: TmuxOp.OpenSidebar({ side: 'right', splitFrom: context.activePaneId }),
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
          type: 'SEND_OP' as const,
          op: TmuxOp.SetWindowTag({ windowId: pane.windowId, tag: 'sidebar-hidden', value: '1' }),
        }),
      );
    }
    releaseKeyboard(context, enqueue, 'right');
  }),

  /**
   * A sidebar was asked to open a while ago and its pane still isn't there:
   * the create command failed on this server (a missing `tmuxy` CLI, a script
   * error). Flip the column into its failure state so the user learns why
   * rather than staring at "starting…".
   */
  /**
   * The slide is over: drop the closing columns, stop dropping sizes, and
   * apply the grid's measured size — the same the toggle predicted, so this
   * is a no-op unless the body changed under the slide.
   */
  groupsAndFloats_sidebarMotionSettled: act(({ context, enqueue }) => {
    enqueue(
      assign({ sidebarMotion: false, leftSidebarClosing: false, rightSidebarClosing: false }),
    );
    if (context.containerWidth > 0 && context.containerHeight > 0) {
      const size = calculateTargetSize(
        context.charWidth,
        context.containerWidth,
        context.containerHeight,
      );
      enqueue.raise({ type: 'SET_TARGET_SIZE' as const, ...size, force: true });
    }
  }),

  groupsAndFloats_sidebarStartTimeout: act(({ context, event, enqueue }) => {
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
  groupsAndFloats_sidebarResizePreview: act(({ event, enqueue }) => {
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
  groupsAndFloats_sidebarResizeCommit: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_RESIZE_COMMIT') return;
    const pane =
      event.side === 'left' ? selectLeftSidebarPane(context) : selectRightSidebarPane(context);
    if (!pane) return;
    enqueue(assign({ sidebarColsPreview: { side: event.side, cols: event.cols } }));
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.SetWindowTag({
          windowId: pane.windowId,
          tag: 'sidebar-cols',
          value: event.cols === null ? null : String(event.cols),
        }),
      }),
    );
    enqueue.raise(
      { type: 'SIDEBAR_PREVIEW_EXPIRE' as const, side: event.side },
      { delay: SIDEBAR_PREVIEW_TIMEOUT_MS, id: `sidebar-preview-timeout-${event.side}` },
    );
  }),

  /** The server never echoed a committed width: stop drawing the preview and show what it has. */
  groupsAndFloats_sidebarPreviewExpire: act(({ context, event, enqueue }) => {
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
  groupsAndFloats_focusRightSidebar: act(({ context, enqueue }) => {
    const pane = selectRightSidebarPane(context);
    if (!pane) return;
    if (!context.rightSidebarOpen) enqueue(assign({ rightSidebarOpen: true }));
    enqueue(assign({ rightSidebarFocused: true }));
    enqueue(
      sendTo('keyboard', { type: 'UPDATE_RIGHT_SIDEBAR_FOCUSED' as const, paneId: pane.tmuxId }),
    );
    // The two overlays are mutually exclusive keyboard targets.
    releaseKeyboard(context, enqueue, 'float');
    releaseKeyboard(context, enqueue, 'left');
  }),

  /** Return keyboard focus from the dock to the panes (Ctrl+h, or a click on a pane). */
  groupsAndFloats_blurRightSidebar: act(({ context, enqueue }) => {
    releaseKeyboard(context, enqueue, 'right');
  }),
};
