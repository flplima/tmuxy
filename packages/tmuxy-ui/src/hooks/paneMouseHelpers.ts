import type { MutableRefObject, RefObject } from 'react';
import type { AppMachineEvent } from '../machines/types/events';
import type { ScrollbackMode } from '../domain/copyMode';
import { sendScrollLines, takeWholeRows, scrollByRows } from './scrollUtils';
import { TmuxOp } from '../domain/commands';
import type { PaneId } from '../domain/ids';

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
  /** Character width in pixels */
  charWidth: number;
  /** Character height in pixels */
  charHeight: number;
  /** Whether the application wants mouse events */
  mouseAnyFlag: boolean;
  /** Whether the application is in alternate screen mode */
  alternateOn: boolean;
  /** Whether the pane is in copy mode */
  inMode: boolean;
  /**
   * Which scrollback view the pane is showing, or null for the live screen.
   *
   * Only `copy` drives the client's cell selection from here. On the live
   * screen and in the scroll view the browser owns selecting — this hook must
   * keep its hands off the event so the native selection can happen, which is
   * what makes dragging feel like any other terminal.
   */
  scrollbackMode: ScrollbackMode | null;
  /** Pane height in rows (for scroll calculations) */
  paneHeight: number;
  /** Ref to the .pane-content element (used for coordinate calculation) */
  contentRef: RefObject<HTMLDivElement | null>;
  /** Ref to the scroll container (proxy target for wheel events) */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Number of scrollback lines above the visible terminal */
  historySize: number;
  /** When true, wheel events bubble to parent when there's nothing to scroll */
  forwardScrollToParent?: boolean;
}

/** Minimum time between drag updates (ms) */
export const DRAG_THROTTLE_MS = 30;

/** Auto-scroll interval (ms) */
export const AUTO_SCROLL_INTERVAL_MS = 50;

/** Auto-scroll speed (lines per tick) */
export const AUTO_SCROLL_LINES = 2;

// The box the cell grid starts in: the scroll container, inside the pane
// content's horizontal padding. Measured from `.pane-content` itself, every
// position read half a cell too far right, so a click on the right half of
// a cell went to the next column.
export function getGridRect(
  scrollEl: HTMLDivElement | null,
  contentEl: HTMLDivElement | null,
): DOMRect | undefined {
  return (scrollEl ?? contentEl)?.getBoundingClientRect();
}

// Convert pixel coordinates to terminal cell coordinates, relative to the
// cell grid (below the header, inside the padding).
// Accounts for sub-line scroll offset when the scroll container is not
// line-aligned (smooth scroll leaves fractional pixel offsets).
// Does NOT clamp Y so we can detect above/below for auto-scroll.
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
  // When the scroll container has a sub-line offset (scrollTop not aligned
  // to charHeight), the rendered content is shifted up. Adjust relY so the
  // row calculation matches what the user visually clicks on.
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

// Handle wheel events
// Uses the proxy pattern: pane-wrapper is non-scrollable (overflow: hidden),
// wheel events are intercepted and manually forwarded to the scroll container.
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

  // When forwardScrollToParent is enabled and the pane has no scrollback,
  // let the event bubble to the parent (e.g. demo page scroll).
  if (
    forwardScrollToParent &&
    historySize === 0 &&
    !alternateOn &&
    !mouseAnyFlag &&
    !scrollbackOpen
  ) {
    return;
  }

  // A full-screen application owns the screen: the scroll is its business,
  // as line-quantized input. This is the branch that keeps the scroll view
  // out of nvim, htop, less and anything else drawing its own viewport —
  // it never opens over them.
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

  // A scrollback view is already open (either kind): forward the wheel
  // delta to the scroll container by hand. The wrapper is non-scrollable,
  // so native scroll never reaches the inner pane-scroll-container;
  // adjusting scrollTop fires onScroll, which reports the new top row.
  // A row at a time, like every other way this pane can scroll: copy mode
  // moves a cursor that lives on a row, a full-screen application is sent
  // rows, and the row is what `onScroll` reports back. Pixel-precise
  // motion here was the odd one out, and left the top row half drawn.
  if (scrollbackOpen) {
    e.preventDefault();
    const { rows, remainder } = takeWholeRows(e.deltaY, charHeight, wheelRemainder.current);
    wheelRemainder.current = remainder;
    if (scrollEl) scrollByRows(scrollEl, rows, charHeight);
    return;
  }

  // Tmux is in some pane mode (e.g. server-side copy-mode entered before
  // the client caught up). Treat as alt-screen — don't re-enter copy mode.
  if (inMode) {
    e.preventDefault();
    return;
  }

  // Live screen with history behind it: scrolling up opens the scroll
  // view — scrollback you can read and select, with no cursor and nothing
  // said to tmux. Copy mode is not on this path at all any more; it is
  // reached by `prefix [`, which is the only thing that should hand a pane
  // a cursor and vi keys.
  if (historySize > 0 && e.deltaY < 0) {
    e.preventDefault();
    const { rows: lines, remainder } = takeWholeRows(e.deltaY, charHeight, wheelRemainder.current);
    wheelRemainder.current = remainder;
    if (lines === 0) return;
    send({ type: 'ENTER_SCROLL_MODE', paneId, scrollLines: lines });
    return;
  }

  // Normal mode scroll down: nothing to do
  e.preventDefault();
}
