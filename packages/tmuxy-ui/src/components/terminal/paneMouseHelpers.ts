import type { MutableRefObject, RefObject } from 'react';
import type { AppMachineEvent } from '../../machines/types/events';
import type { ScrollbackMode } from '../../domain/copyMode';
import { sendScrollLines, takeWholeRows, scrollByRows } from './scrollUtils';
import { TmuxOp } from '../../domain/commands';
import type { PaneId } from '../../domain/ids';

/** A mouse report at a 0-based cell, as the 1-based SGR coordinates (never row 0). */
export function mouseOp(
  paneId: PaneId,
  button: number,
  cell: { x: number; y: number },
  release: boolean,
): TmuxOp {
  return TmuxOp.SendMouse({ paneId, button, x: cell.x + 1, y: Math.max(1, cell.y + 1), release });
}

export interface UsePaneMouseOptions {
  paneId: PaneId;
  /** px */
  charWidth: number;
  /** px */
  charHeight: number;
  mouseAnyFlag: boolean;
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

// Y is not clamped: a row above or below the grid starts the drag's auto-scroll.
export function clientToCell(
  e: { clientX: number; clientY: number },
  scrollEl: HTMLDivElement | null,
  contentEl: HTMLDivElement | null,
  charWidth: number,
  charHeight: number,
): { x: number; y: number } {
  const rect = getGridRect(scrollEl, contentEl);
  if (!rect) return { x: 0, y: 0 };
  const relX = e.clientX - rect.left;
  let relY = e.clientY - rect.top;
  // A scrollTop off the row grid shifts the rendered rows up.
  const subLineOffset = scrollEl ? scrollEl.scrollTop % charHeight : 0;
  relY += subLineOffset;
  return {
    x: Math.max(0, Math.floor(relX / charWidth)),
    y: Math.floor(relY / charHeight),
  };
}

export interface PaneWheelContext {
  send: (event: AppMachineEvent) => void;
  paneId: PaneId;
  charHeight: number;
  alternateOn: boolean;
  mouseAnyFlag: boolean;
  scrollbackOpen: boolean;
  inMode: boolean;
  pixelToCell: (e: React.MouseEvent) => { x: number; y: number };
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
    pixelToCell,
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

    const cell = mouseAnyFlag ? pixelToCell(e as unknown as React.MouseEvent) : { x: 0, y: 0 };
    sendScrollLines({
      send,
      paneId,
      lines,
      alternateOn,
      mouseAnyFlag,
      cellX: cell.x,
      cellY: cell.y,
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
