import { assign, raise, sendTo } from 'xstate';
import { act, assignCtx, type Ctx, type EnqueueAction } from '../actionTypes';
import { PHONE_COLS, PHONE_ROWS } from '../../../infra/dom/phoneLayout';
import { fittedGridCell } from '../helpers';
import { gridExtent } from '../../../domain/paneGeometry';
import { fixedGridSize } from '../../../domain/gridFit';
import { cellSizeClaim, formatCellPx } from '../../../domain/cellSize';
import { TmuxOp } from '../../../domain/commands';

/**
 * Bring tmux's window to `target`, the size this client asks for: report it
 * when the grid it draws differs, and otherwise, once the layout is
 * `settled`, open the animation gate (an idle session may send no further
 * update to open it). The one place both the viewport's change and a model
 * update decide whether to resize.
 *
 * A size is reported once: the backend keeps it, and the grid of a session
 * another client holds smaller differs on every update for as long as that
 * client stays. A report that failed on its way is owed again
 * (`viewport_sizeUnreported`).
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

/**
 * The grid this client asks tmux for: a phone's, or a fixed `@tmuxy-size`,
 * which every client asks for whatever its container measures (the grid
 * keeps its cols/rows and the cell is fitted to it instead,
 * domain/gridFit.ts); else the `measured` one.
 */
function askedSize(
  context: Pick<Ctx, 'phoneLayout' | 'sizePolicy'>,
  measured: { cols: number; rows: number },
): { cols: number; rows: number } {
  if (context.phoneLayout) return { cols: PHONE_COLS, rows: PHONE_ROWS };
  return fixedGridSize(context.sizePolicy) ?? { cols: measured.cols, rows: measured.rows };
}

/**
 * Tell programs in panes this client's cell size (`@tmuxy-cell-px`) when the
 * rule in `cellSizeClaim` says so: once a connection has a state, if the
 * option is unset or differs, and then each time this client's own cell
 * changes. The cell is the grid's, the one pixel mouse reports count in.
 */
function announceCellSize(
  context: Pick<
    Ctx,
    'connected' | 'panes' | 'charWidth' | 'charHeight' | 'cellPx' | 'cellPxClaimed'
  >,
  enqueue: EnqueueAction,
): void {
  if (!context.connected || context.panes.length === 0) return;
  const own = formatCellPx(context.charWidth, context.charHeight);
  const { write, claimed } = cellSizeClaim(own, context.cellPx, context.cellPxClaimed);
  if (claimed !== context.cellPxClaimed) enqueue(assign({ cellPxClaimed: claimed }));
  if (write) {
    enqueue(
      sendTo('tmux', { type: 'SEND_OP' as const, op: TmuxOp.AnnounceCellSize({ size: own }) }),
    );
  }
}

export const viewportActions = {
  viewport_announceCellSize: act(({ context, enqueue }) => announceCellSize(context, enqueue)),

  viewport_unclaimCellSize: assignCtx({ cellPxClaimed: null }),

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
    const { cols, rows } = askedSize(context, event);
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

  /**
   * While the first connection is made, the size goes out as it is measured:
   * the in-browser guest attaches its tmux client at it, long after the
   * page measured itself. The transport hands it only to a driver
   * that `takesSizeWhileConnecting`; a server hears it with the first fetch.
   */
  viewport_reportWhileConnecting: act(({ context, event, enqueue }) => {
    if (event.type !== 'SET_TARGET_SIZE') return;
    enqueue(sendTo('tmux', { type: 'SET_CLIENT_SIZE' as const, ...askedSize(context, event) }));
  }),

  // The report is forgotten, so the next model update that still differs
  // from the target sends it again; a newer report in between stands.
  viewport_sizeUnreported: assignCtx(({ context, event }) =>
    event.type === 'CLIENT_SIZE_UNREPORTED' &&
    context.reportedSize?.cols === event.cols &&
    context.reportedSize.rows === event.rows
      ? { reportedSize: null }
      : {},
  ),

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
