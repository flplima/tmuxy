import type { MutableRefObject, RefObject } from 'react';
import type { AppMachineEvent } from '../../machines/types/events';
import type { ScrollbackMode } from '../../domain/copyMode';
import { sendScrollLines, takeWholeRows, scrollByRows } from './scrollUtils';
import { TmuxOp } from '../../domain/commands';
import type { PaneId } from '../../domain/ids';
import { scaleToAnnounced } from '../../domain/cellSize';

/** A mouse report at `at`, already in SGR's 1-based coordinates (see `reportPosition`). */
export function mouseOp(
  paneId: PaneId,
  button: number,
  at: ReportPosition,
  release: boolean,
): TmuxOp {
  return TmuxOp.SendMouse({ paneId, reports: [{ button, x: at.x, y: at.y, release }] });
}

/** SGR's button code for the pointer moving with no button held: 32 for motion, 3 for none. */
export const HOVER_BUTTON = 35;

/** Where a mouse report says the pointer is: 1-based, a cell or a CSS pixel. */
export interface ReportPosition {
  x: number;
  y: number;
}

export const samePosition = (a: ReportPosition | null, b: ReportPosition): boolean =>
  a !== null && a.x === b.x && a.y === b.y;

export interface UsePaneMouseOptions {
  paneId: PaneId;
  /** px */
  charWidth: number;
  /** px */
  charHeight: number;
  mouseAnyFlag: boolean;
  /** The program hears the pointer move with no button held (`?1003h`). */
  mouseAllFlag: boolean;
  /** The program wants positions in pixels (SGR-Pixels, `?1016h`). */
  mousePixelsFlag: boolean;
  /**
   * The cell size programs were told (`@tmuxy-cell-px`), `''` while none
   * was: pixel reports are counted in it (`scaleToAnnounced`).
   */
  announcedCell: string;
  alternateOn: boolean;
  /** tmux's `pane_in_mode`: any tmux mode, not only copy mode. */
  inMode: boolean;
  /** null for the live screen. */
  scrollbackMode: ScrollbackMode | null;
  paneHeight: number;
  contentRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  historySize: number;
  forwardScrollToParent?: boolean;
}

export const DRAG_THROTTLE_MS = 30;

export const AUTO_SCROLL_INTERVAL_MS = 50;

/** Rows per tick. */
export const AUTO_SCROLL_LINES = 2;

// The scroll container, inside `.pane-content`'s horizontal padding: measured
// from `.pane-content`, a click on a cell's right half went to the next column.
export function getGridRect(
  scrollEl: HTMLDivElement | null,
  contentEl: HTMLDivElement | null,
): DOMRect | undefined {
  return (scrollEl ?? contentEl)?.getBoundingClientRect();
}

/**
 * The pointer's offset in CSS pixels from the top-left corner of the cell
 * grid, or null with no grid. A scrollTop off the row grid shifts the
 * rendered rows up, so it is added back.
 */
function gridOffset(
  e: { clientX: number; clientY: number },
  scrollEl: HTMLDivElement | null,
  contentEl: HTMLDivElement | null,
  charHeight: number,
): { x: number; y: number } | null {
  const rect = getGridRect(scrollEl, contentEl);
  if (!rect) return null;
  const subLineOffset = scrollEl ? scrollEl.scrollTop % charHeight : 0;
  return { x: e.clientX - rect.left, y: e.clientY - rect.top + subLineOffset };
}

// Y is not clamped: a row above or below the grid starts the drag's auto-scroll.
export function clientToCell(
  e: { clientX: number; clientY: number },
  scrollEl: HTMLDivElement | null,
  contentEl: HTMLDivElement | null,
  charWidth: number,
  charHeight: number,
): { x: number; y: number } {
  const offset = gridOffset(e, scrollEl, contentEl, charHeight);
  if (!offset) return { x: 0, y: 0 };
  return {
    x: Math.max(0, Math.floor(offset.x / charWidth)),
    y: Math.floor(offset.y / charHeight),
  };
}

/**
 * The position a mouse report carries, 1-based as SGR counts: the cell under
 * the pointer, or with SGR-Pixels the CSS pixel, counted from the cell grid's
 * top-left corner (its first pixel is 1, as its first cell is). Never below 1.
 * A pixel is counted in the `announced` cell, the one programs were told,
 * when this client's own differs (`scaleToAnnounced`).
 */
export function reportPosition(
  e: { clientX: number; clientY: number },
  scrollEl: HTMLDivElement | null,
  contentEl: HTMLDivElement | null,
  charWidth: number,
  charHeight: number,
  pixels: boolean,
  announced = '',
): ReportPosition {
  if (pixels) {
    const offset = scaleToAnnounced(
      gridOffset(e, scrollEl, contentEl, charHeight) ?? { x: 0, y: 0 },
      { width: charWidth, height: charHeight },
      announced,
    );
    return {
      x: Math.max(1, Math.floor(offset.x) + 1),
      y: Math.max(1, Math.floor(offset.y) + 1),
    };
  }
  const cell = clientToCell(e, scrollEl, contentEl, charWidth, charHeight);
  return { x: cell.x + 1, y: Math.max(1, cell.y + 1) };
}

export interface PaneWheelContext {
  send: (event: AppMachineEvent) => void;
  paneId: PaneId;
  charHeight: number;
  alternateOn: boolean;
  mouseAnyFlag: boolean;
  scrollbackOpen: boolean;
  inMode: boolean;
  /** Where a wheel report says the pointer is (`reportPosition`). */
  mouseAt: (e: React.MouseEvent) => ReportPosition;
  scrollEl: HTMLDivElement | null;
  historySize: number;
  forwardScrollToParent?: boolean;
  wheelRemainder: MutableRefObject<number>;
}

export function handlePaneWheel(e: React.WheelEvent, ctx: PaneWheelContext): void {
  const {
    send,
    paneId,
    charHeight,
    alternateOn,
    mouseAnyFlag,
    scrollbackOpen,
    inMode,
    mouseAt,
    scrollEl,
    historySize,
    forwardScrollToParent,
    wheelRemainder,
  } = ctx;

  // Bubbles to the embedding page (the demo's scroll).
  if (
    forwardScrollToParent &&
    historySize === 0 &&
    !alternateOn &&
    !mouseAnyFlag &&
    !scrollbackOpen
  ) {
    return;
  }

  // A full-screen application (nvim, htop, less) owns its scroll: the scroll
  // view never opens over it.
  if (alternateOn || mouseAnyFlag) {
    e.preventDefault();
    const { rows: lines, remainder } = takeWholeRows(e.deltaY, charHeight, wheelRemainder.current);
    wheelRemainder.current = remainder;
    if (lines === 0) return;

    sendScrollLines({
      send,
      paneId,
      lines,
      alternateOn,
      mouseAnyFlag,
      at: mouseAnyFlag ? mouseAt(e as unknown as React.MouseEvent) : undefined,
    });
    return;
  }

  // The wrapper does not scroll, so the delta is forwarded to the scroll
  // container by hand, a row at a time: pixel motion left the top row half drawn.
  if (scrollbackOpen) {
    e.preventDefault();
    const { rows, remainder } = takeWholeRows(e.deltaY, charHeight, wheelRemainder.current);
    wheelRemainder.current = remainder;
    if (scrollEl) scrollByRows(scrollEl, rows, charHeight);
    return;
  }

  // tmux is in a mode the client has not caught up with (e.g. copy mode
  // entered from the CLI): its scroll is tmux's.
  if (inMode) {
    e.preventDefault();
    return;
  }

  // Scrolling up opens the scroll view, never copy mode: only `prefix [`
  // hands a pane a cursor and vi keys.
  if (historySize > 0 && e.deltaY < 0) {
    e.preventDefault();
    const { rows: lines, remainder } = takeWholeRows(e.deltaY, charHeight, wheelRemainder.current);
    wheelRemainder.current = remainder;
    if (lines === 0) return;
    send({ type: 'ENTER_SCROLL_MODE', paneId, scrollLines: lines });
    return;
  }

  e.preventDefault();
}
