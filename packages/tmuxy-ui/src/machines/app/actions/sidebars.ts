import { assign, sendTo } from 'xstate';
import { sidebarWindow } from '../../../domain/windows';
import { act, type Ctx, type Enqueue } from '../actionTypes';
import { TmuxOp } from '../../../domain/commands';
import {
  selectSettledPaneWidth,
  selectSidebarHidden,
  selectSidebarLayout,
  selectSidebarPane,
} from '../../selectors/panesAndSidebars';
import { selectDockSize } from '../../selectors/layout';
import type { SidebarSide, SidebarState } from '../../types/domain';
import { calculateTargetSize } from '../../../infra/dom/targetSize';
import { releaseKeyboard, sidebarStartTimeoutId, takeKeyboard } from '../helpers';
import { fixedGridSize } from '../../../domain/gridFit';
import { fitWindowToSidebar } from '../../../infra/desktopWindow';
import { toStore } from '../dispatch';

/** How long a sidebar may sit on "starting…" before the column reports a failure. */
export const SIDEBAR_START_TIMEOUT_MS = 4000;

/** Safety net: drop a resize preview the server never confirmed. */
const SIDEBAR_PREVIEW_TIMEOUT_MS = 5000;

/** Change `side`'s column, on top of whatever this step already changed. */
function patchSidebar(enqueue: Enqueue, side: SidebarSide, patch: Partial<SidebarState>) {
  enqueue(
    assign(({ context }) => ({
      sidebars: { ...context.sidebars, [side]: { ...context.sidebars[side], ...patch } },
    })),
  );
}

/** `context` with `side`'s column open or shut, for a selector asked about the layout to come. */
function withOpen(context: Ctx, side: SidebarSide, open: boolean): Ctx {
  return {
    ...context,
    sidebars: { ...context.sidebars, [side]: { ...context.sidebars[side], open } },
  };
}

/**
 * Tell the grid its size with `side` open or shut, the moment the toggle is
 * made: tmux re-tiles once, for the width the column leaves, rather than after
 * the container's next measure. A grid `@tmuxy-size` fixes is not re-tiled:
 * the desktop window grows by the column instead (and the grid is fitted to
 * the room left wherever it cannot).
 */
function retileFor(context: Ctx, enqueue: Enqueue, side: SidebarSide, willOpen: boolean) {
  if (fixedGridSize(context.sizePolicy) && !context.phoneLayout) {
    const layout = selectSidebarLayout(withOpen(context, side, true));
    const width = side === 'left' ? layout.leftWidth : layout.rightWidth;
    enqueue(() => fitWindowToSidebar(side, willOpen, width));
    return;
  }
  if (context.containerHeight <= 0) return;
  const width = selectSettledPaneWidth(withOpen(context, side, willOpen));
  if (width === null) return;
  const size = calculateTargetSize(context.measuredCell.charWidth, width, context.containerHeight);
  enqueue.raise({ type: 'SET_TARGET_SIZE' as const, ...size });
}

/**
 * Hide or show `side`'s window for every client (`@tmuxy-sidebar-hidden`).
 * Through the store, which holds the flag as written until tmux's states
 * agree, so reconcileSidebar never reads this client's own late echo as
 * another client's toggle (P13).
 */
function setHidden(context: Ctx, enqueue: Enqueue, side: SidebarSide, hidden: boolean) {
  const pane = selectSidebarPane(context, side);
  if (!pane) return;
  toStore(
    enqueue,
    TmuxOp.SetWindowTag({
      windowId: pane.windowId,
      tag: 'sidebar-hidden',
      value: hidden ? '1' : null,
    }),
  );
}

/** A toggle docks or shuts the column it names; a peek of that column is over. */
const endPeekOf = (context: Ctx, side: SidebarSide) =>
  context.sidebarPeek === side ? { sidebarPeek: null } : {};

export const sidebarsActions = {
  /**
   * Size the dock's pane to the room it is drawn in, whenever that changes —
   * the backend sizes the pane from its window's options — and only then, so
   * the poll is not poked on every state update. The desktop's column gives
   * it rows (it runs in the sidebar font, whose rows are shorter than the
   * grid's, so it holds more rows than the viewport); the phone's bottom view
   * gives it both.
   */
  sidebars_syncDockSize: act(({ context, enqueue }) => {
    const dock = sidebarWindow(context.windows, 'right');
    const size = selectDockSize(context);
    if (!dock || !size) return;
    const sent = context.dockSizeSent;
    if (sent && sent.windowId === dock.id && sent.cols === size.cols && sent.rows === size.rows) {
      return;
    }
    const tags = [
      ['sidebar-cols', size.cols],
      ['sidebar-rows', size.rows],
    ] as const;
    for (const [tag, value] of tags) {
      if (value === null) continue;
      enqueue(
        sendTo('tmux', {
          type: 'SEND_OP' as const,
          op: TmuxOp.SetWindowTag({ windowId: dock.id, tag, value: String(value) }),
        }),
      );
    }
    enqueue(assign({ dockSizeSent: { windowId: dock.id, ...size } }));
  }),

  sidebars_toggleTabCollapse: act(({ context, event, enqueue }) => {
    if (event.type !== 'TOGGLE_TAB_COLLAPSE') return;
    const { windowId } = event;
    const collapsedTabIds = context.collapsedTabIds.includes(windowId)
      ? context.collapsedTabIds.filter((id) => id !== windowId)
      : [...context.collapsedTabIds, windowId];
    enqueue(assign({ collapsedTabIds }));
  }),

  sidebars_toggle: act(({ context, event, enqueue }) => {
    if (event.type !== 'TOGGLE_SIDEBAR') return;
    const { side } = event;
    const willOpen = !context.sidebars[side].open;
    patchSidebar(enqueue, side, { open: willOpen, startFailed: false });
    enqueue(assign(endPeekOf(context, side)));
    retileFor(context, enqueue, side, willOpen);

    if (!willOpen) {
      setHidden(context, enqueue, side, true);
      releaseKeyboard(enqueue, side);
      return;
    }
    if (selectSidebarPane(context, side)) {
      setHidden(context, enqueue, side, false);
      enqueue.raise({ type: 'FOCUS_SIDEBAR' as const, side });
    } else {
      enqueue.raise({ type: 'START_SIDEBAR' as const, side });
    }
  }),

  /**
   * The column takes the keyboard, opening it when it is shut. A peeking
   * column takes it where it is, over the panes, not docked, and gives it
   * back when the peek ends; on a phone the dock is the bottom view, not a
   * column to open.
   */
  sidebars_focus: act(({ context, event, enqueue }) => {
    if (event.type !== 'FOCUS_SIDEBAR') return;
    const { side } = event;
    const pane = selectSidebarPane(context, side);
    const shut = !context.sidebars[side].open && context.sidebarPeek !== side;
    if (!pane) {
      if (side === 'left' && shut) enqueue.raise({ type: 'TOGGLE_SIDEBAR' as const, side });
      return;
    }
    if (shut && !(side === 'right' && context.phoneLayout))
      patchSidebar(enqueue, side, { open: true });
    takeKeyboard(enqueue, { kind: side, paneId: pane.tmuxId });
  }),

  sidebars_blur: act(({ event, enqueue }) => {
    if (event.type !== 'BLUR_SIDEBAR') return;
    releaseKeyboard(enqueue, event.side);
  }),

  /**
   * Break the column's pane out (`OpenSidebar`) unless it exists or a start is
   * already on its way: one window per column. Every extra window a toggle
   * asked for while the first was still being made would live on in tmux,
   * hidden, for good.
   */
  sidebars_start: act(({ context, event, enqueue }) => {
    if (event.type !== 'START_SIDEBAR') return;
    const { side } = event;
    if (context.sidebars[side].starting || selectSidebarPane(context, side)) return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op: TmuxOp.OpenSidebar({ side, splitFrom: context.activePaneId }),
      }),
    );
    patchSidebar(enqueue, side, { starting: true, startFailed: false });
    enqueue.raise(
      { type: 'SIDEBAR_START_TIMEOUT' as const, side },
      { delay: SIDEBAR_START_TIMEOUT_MS, id: sidebarStartTimeoutId(side) },
    );
  }),

  sidebars_sidebarStartTimeout: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_START_TIMEOUT') return;
    const { side } = event;
    const wanted = context.sidebars[side].open || context.sidebarPeek === side;
    patchSidebar(enqueue, side, {
      starting: false,
      ...(wanted && !selectSidebarPane(context, side) ? { startFailed: true } : {}),
    });
  }),

  sidebars_sidebarResizePreview: act(({ event, enqueue }) => {
    if (event.type !== 'SIDEBAR_RESIZE_PREVIEW') return;
    enqueue(assign({ sidebarColsPreview: { side: event.side, cols: event.cols } }));
  }),

  sidebars_sidebarResizeCommit: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_RESIZE_COMMIT') return;
    const pane = selectSidebarPane(context, event.side);
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

  sidebars_sidebarPreviewExpire: act(({ context, event, enqueue }) => {
    if (event.type !== 'SIDEBAR_PREVIEW_EXPIRE') return;
    if (context.sidebarColsPreview?.side === event.side) {
      enqueue(assign({ sidebarColsPreview: null }));
    }
  }),

  /**
   * Show a closed column over the panes while the pointer rests on it or on
   * its toggle. Nothing is re-tiled and nothing is unhidden: the column's
   * window keeps `@tmuxy-sidebar-hidden`, so no other client sees it open.
   * A column whose pane was never made is started here, and arrives hidden
   * (reconcileSidebar: a start this client no longer has open).
   */
  sidebars_peekSidebar: act(({ context, event, enqueue }) => {
    if (event.type !== 'PEEK_SIDEBAR') return;
    const { side } = event;
    if (context.sidebars[side].open || context.phoneLayout || context.sidebarPeek === side) return;
    if (context.sidebarPeek) releaseKeyboard(enqueue, context.sidebarPeek);
    enqueue(assign({ sidebarPeek: side }));
    if (selectSidebarPane(context, side)) return;
    patchSidebar(enqueue, side, { startFailed: false });
    enqueue.raise({ type: 'START_SIDEBAR' as const, side });
  }),

  /** The pointer left the peek: the column goes, and takes the keyboard with it. */
  sidebars_endSidebarPeek: act(({ context, enqueue }) => {
    const side = context.sidebarPeek;
    if (!side) return;
    enqueue(assign({ sidebarPeek: null }));
    if (!context.sidebars[side].open) releaseKeyboard(enqueue, side);
  }),
};

/**
 * One column against a model update: `prev` is the context before it, `next`
 * the windows and panes it brings. The pane appearing ends a start (and, if
 * this client asked for it, takes the keyboard); the pane going away ends the
 * column, or reports the start failed; the window hidden or shown by another
 * client closes or opens it here too.
 */
function reconcileSidebar(prev: Ctx, next: Ctx, side: SidebarSide, enqueue: Enqueue) {
  const was = selectSidebarPane(prev, side);
  const now = selectSidebarPane(next, side);
  const hidden = selectSidebarHidden(next, side);
  const state = prev.sidebars[side];
  if (!was && now) {
    // The desktop's column, or for the dock the phone's bottom view, asked for it.
    const requested = state.open || (side === 'right' && prev.phoneBottomView === 'dock');
    enqueue.cancel(sidebarStartTimeoutId(side));
    patchSidebar(enqueue, side, { starting: false, startFailed: false });
    if (state.starting && !requested && !hidden) {
      // This client asked for the column, then closed it before it landed:
      // it arrives hidden, as the close would have left it.
      setHidden(next, enqueue, side, true);
      return;
    }
    patchSidebar(enqueue, side, { open: !hidden });
    if (requested && !hidden) {
      enqueue.raise({ type: 'FOCUS_SIDEBAR' as const, side });
      enqueue.raise({ type: 'SUPPRESS_ANIMATIONS' as const });
    }
  } else if (was && !now) {
    enqueue.cancel(sidebarStartTimeoutId(side));
    patchSidebar(enqueue, side, {
      open: state.starting,
      startFailed: state.starting,
      starting: false,
    });
    releaseKeyboard(enqueue, side);
  } else if (was && now && selectSidebarHidden(prev, side) !== hidden) {
    patchSidebar(enqueue, side, { open: !hidden });
    if (hidden) releaseKeyboard(enqueue, side);
  }
}

/**
 * The columns against a model update (`prev` → `next`): each side's
 * lifecycle, a dragged width the server now reports, and a focus request a
 * script made (`tmuxy focus`), which moves the keyboard into a column that is
 * open but never opens one (a closed column keeps its window, so a script can
 * still name it).
 */
export function reconcileSidebars(
  prev: Ctx,
  next: Ctx,
  focusRequest: string | null | undefined,
  enqueue: Enqueue,
) {
  reconcileSidebar(prev, next, 'left', enqueue);
  reconcileSidebar(prev, next, 'right', enqueue);

  const preview = prev.sidebarColsPreview;
  if (preview) {
    const win = sidebarWindow(next.windows, preview.side);
    if (win && (win.sidebarCols ?? null) === preview.cols) {
      enqueue(assign({ sidebarColsPreview: null }));
    }
  }

  if (!focusRequest) return;
  if (focusRequest === 'left' || focusRequest === 'right') {
    if (prev.sidebars[focusRequest].open) {
      enqueue.raise({ type: 'FOCUS_SIDEBAR' as const, side: focusRequest });
    }
  } else if (focusRequest === 'panes') {
    releaseKeyboard(enqueue, 'left');
    releaseKeyboard(enqueue, 'right');
  }
  enqueue(
    sendTo('tmux', {
      type: 'SEND_OP' as const,
      op: TmuxOp.ClearFocusRequest({ session: prev.sessionName }),
    }),
  );
}
