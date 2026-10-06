/**
 * scrollUtils - Shared scroll command logic for wheel and touch handlers
 *
 * Encapsulates the three-mode scroll routing:
 * 1. Mouse tracking (apps requesting mouse, e.g. nvim with `mouse=a`) → SGR wheel events
 * 2. Alternate screen without mouse (vim with `mouse=`, less) → Up/Down arrow keys
 * 3. Normal shell → proxy pixel delta to scroll container (native copy mode)
 *
 * Mouse tracking takes precedence over alternate-screen: when the app explicitly
 * enabled mouse reporting, it expects raw mouse events, not synthetic arrow keys
 * (which would move the cursor in nvim, not scroll the viewport).
 */

import type { AppMachineEvent } from '../machines/types';
import type { PaneId } from '../domain/ids';
import { TmuxOp } from '../domain/commands';

/**
 * Split a pixel delta into whole rows, carrying what is left over.
 *
 * Everything that scrolls a terminal is quantised to rows: the escape
 * protocol has no unit smaller than a line, tmux's copy cursor sits on one,
 * and a full-screen application is only ever told about rows. A trackpad
 * reports pixels, so the sub-row part of each event is carried into the next
 * one rather than dropped — a slow drag still moves, a row at a time.
 */
export function takeWholeRows(
  deltaPixels: number,
  charHeight: number,
  remainder: number,
): { rows: number; remainder: number } {
  if (charHeight <= 0) return { rows: 0, remainder: 0 };
  const total = remainder + deltaPixels;
  const rows = Math.trunc(total / charHeight);
  return { rows, remainder: total - rows * charHeight };
}

/**
 * Move a scrollback container by whole rows, landing on a row boundary.
 *
 * Rounded to the nearest row first, so a container left mid-row by something
 * else (a `scrollIntoView`, a font-size change) is pulled back onto the grid
 * instead of carrying the offset for the rest of the session. The browser
 * clamps the far end of the range for us.
 */
export function scrollByRows(el: HTMLElement, rows: number, charHeight: number): void {
  if (rows === 0 || charHeight <= 0) return;
  const currentRow = Math.round(el.scrollTop / charHeight);
  el.scrollTop = Math.max(0, currentRow + rows) * charHeight;
}

interface ScrollCommandOptions {
  send: (event: AppMachineEvent) => void;
  paneId: PaneId;
  /** Number of lines to scroll. Positive = down, negative = up. */
  lines: number;
  alternateOn: boolean;
  mouseAnyFlag: boolean;
  /** Cell X position (only needed for mouse-tracking SGR events) */
  cellX?: number;
  /** Cell Y position (only needed for mouse-tracking SGR events) */
  cellY?: number;
}

/**
 * Send scroll commands to tmux for line-quantized scroll modes
 * (alternate screen and mouse tracking).
 *
 * Returns true if the scroll was handled, false if the caller should
 * fall through to the default scroll-container proxy behavior.
 */
export function sendScrollLines(opts: ScrollCommandOptions): boolean {
  const { send, paneId, lines, alternateOn, mouseAnyFlag, cellX = 0, cellY = 0 } = opts;

  if (lines === 0) return true; // consumed but nothing to do

  if (!alternateOn && !mouseAnyFlag) return false; // not handled

  const isScrollUp = lines < 0;
  const absLines = Math.abs(lines);

  if (mouseAnyFlag) {
    // Mouse tracking mode: send SGR wheel events
    const button = isScrollUp ? 64 : 65;
    for (let i = 0; i < absLines; i++) {
      send({
        type: 'DISPATCH_OP',
        op: TmuxOp.SendMouse({ paneId, button, x: cellX + 1, y: cellY + 1, release: false }),
      });
    }
  } else {
    const key = isScrollUp ? 'Up' : 'Down';
    for (let i = 0; i < absLines; i++) {
      send({ type: 'DISPATCH_OP', op: TmuxOp.SendKeys({ target: paneId, keys: key }) });
    }
  }

  return true;
}
