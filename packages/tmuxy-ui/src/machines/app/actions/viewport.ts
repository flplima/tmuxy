import { assign, raise, sendTo } from 'xstate';
import { act, assignCtx, type Ctx, type EnqueueAction } from '../actionTypes';
import { PHONE_COLS, PHONE_ROWS } from '../../../infra/dom/phoneLayout';
import { fittedGridCell } from '../helpers';
import { gridExtent } from '../../../domain/paneGeometry';
import { fixedGridSize } from '../../../domain/gridFit';

/**
 * Bring tmux's window to `target`, the size this client asks for: report it
 * when the grid it draws differs, and otherwise, once the layout is
 * `settled`, open the animation gate (an idle session may send no further
 * update to open it). The one place both the viewport's change and a model
 * update decide whether to resize.
 *
 * A size is reported once: the backend keeps it, and the grid of a session
 * another client holds smaller differs on every update for as long as that
 * client stays.
 */
export function syncClientSize(
  context: Pick<
    Ctx,
    | 'connected'
    | 'panes'
    | 'activeWindowId'
    | 'totalWidth'
    | 'totalHeight'
    | 'enableAnimations'
    | 'reportedSize'
  >,
  enqueue: EnqueueAction,
  target: { cols: number; rows: number },
  settled: boolean,
): void {
  const grid = gridExtent(context.panes, context.activeWindowId, {
    cols: context.totalWidth,
    rows: context.totalHeight,
  });
  if (grid.cols <= 0) return;
  if (context.connected && (target.cols !== grid.cols || target.rows !== grid.rows)) {
    const reported = context.reportedSize;
    if (reported?.cols === target.cols && reported.rows === target.rows) return;
    enqueue(assign({ reportedSize: target }));
    enqueue(sendTo('tmux', { type: 'SET_CLIENT_SIZE' as const, ...target }));
  } else if (!context.enableAnimations && settled) {
    enqueue(raise({ type: 'ANIMATIONS_SETTLED' as const }));
  }
}

export const viewportActions = {
  viewport_setCharSize: assignCtx(({ context, event }) => {
    if (event.type !== 'SET_CHAR_SIZE') return {};
    const measuredCell = {
      charWidth: event.charWidth,
      charHeight: event.charHeight,
      cellGap: event.cellGap,
      gridFontSize: event.gridFontSize ?? null,
    };
    return { measuredCell, ...fittedGridCell({ ...context, measuredCell }) };
  }),

  /** The grid's cell, fitted again: the size policy or the window's size changed. */
  viewport_refitGrid: assignCtx(({ context }) => fittedGridCell(context)),

  viewport_setPhoneLayout: assignCtx(({ event }) =>
    event.type === 'SET_PHONE_LAYOUT'
      ? { phoneLayout: event.phone, phoneLandscape: event.phone && event.landscape }
      : {},
  ),

  viewport_setTargetSize: act(({ event, context, enqueue }) => {
    if (event.type !== 'SET_TARGET_SIZE') return;
    // A fixed `@tmuxy-size` is what every client asks for, whatever its
    // container measures: the grid keeps its cols/rows and the cell is
    // fitted to it instead (domain/gridFit.ts).
    const fixed = context.phoneLayout ? null : fixedGridSize(context.sizePolicy);
    const cols = context.phoneLayout ? PHONE_COLS : (fixed?.cols ?? event.cols);
    const rows = context.phoneLayout ? PHONE_ROWS : (fixed?.rows ?? event.rows);
    // Asked for again (a new connection, another size policy): whatever was
    // reported before is not what this backend holds.
    const reportedSize = event.resend ? null : context.reportedSize;
    enqueue(assign({ targetCols: cols, targetRows: rows, viewportMeasured: true, reportedSize }));
    enqueue.raise({ type: 'SYNC_DOCK_SIZE' as const });
    if (context.connected && context.panes.length === 0) {
      enqueue(sendTo('tmux', { type: 'FETCH_INITIAL_STATE' as const, cols, rows }));
    }
    syncClientSize({ ...context, reportedSize }, enqueue, { cols, rows }, context.lastUpdateQuiet);
  }),

  viewport_setContainerSize: assignCtx(({ context, event }) => {
    if (event.type !== 'SET_CONTAINER_SIZE') return {};
    const container = { containerWidth: event.width, containerHeight: event.height };
    return { ...container, ...fittedGridCell({ ...context, ...container }) };
  }),

  viewport_setBodySize: assignCtx(({ event }) =>
    event.type === 'SET_BODY_SIZE' ? { bodyWidth: event.width } : {},
  ),

  viewport_observeContainer: act(({ event, enqueue }) => {
    if (event.type !== 'OBSERVE_CONTAINER') return;
    enqueue(sendTo('size', { type: 'OBSERVE_CONTAINER' as const, element: event.element }));
  }),
};
