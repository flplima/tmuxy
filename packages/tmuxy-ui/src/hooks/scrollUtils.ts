/**
 * scrollUtils - Shared scroll command logic for wheel and touch handlers
 *
 * Encapsulates the three-mode scroll routing:
 * 1. Mouse tracking (apps requesting mouse, e.g. nvim with `mouse=a`) → SGR wheel events
 * 2. Alternate screen without mouse (vim with `mouse=`, less) → Up/Down arrow keys
 * 3. Normal shell → proxy the pixel delta straight to the scroll container
 *
 * Mouse tracking takes precedence over alternate-screen: when the app explicitly
 * enabled mouse reporting, it expects raw mouse events, not synthetic arrow keys
 * (which would move the cursor in nvim, not scroll the viewport).
 */

import type { AppMachineEvent } from '../machines/types';

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
 * Move a scrollback container by a pixel delta.
 *
 * Scrollback is the one surface where the terminal's row grid is NOT the unit
 * of motion. A trackpad reports pixels and a native terminal moves by pixels:
 * quantising to rows here meant two out of every three wheel events moved
 * nothing at all and the third jumped a whole line, which is the stepping the
 * scroll view was reported to have against iTerm2. Rows still quantise every
 * path that has to speak to tmux — the escape protocol, the copy cursor — but
 * not this one, which only has to move a scroll container the browser already
 * renders at sub-pixel precision. A partly drawn row at the top edge is what
 * every native terminal shows mid-gesture.
 *
 * The browser clamps both ends of the range for us.
 */
export function scrollByPixels(el: HTMLElement, deltaPixels: number): void {
  if (deltaPixels === 0) return;
  el.scrollTop = Math.max(0, el.scrollTop + deltaPixels);
}

/**
 * Move a scrollback container by whole rows, landing on a row boundary.
 *
 * Kept alongside `scrollByPixels` while the pixel-precise wheel path is
 * bisected against CI: the copy-mode wheel suite went red on the commit that
 * swapped this out, and reproduces on no local machine, throttled or not.
 */
export function scrollByRows(el: HTMLElement, rows: number, charHeight: number): void {
  if (rows === 0 || charHeight <= 0) return;
  const currentRow = Math.round(el.scrollTop / charHeight);
  el.scrollTop = Math.max(0, currentRow + rows) * charHeight;
}

/**
 * A wheel event's delta in pixels, whatever unit it arrived in.
 *
 * `deltaMode` is `DOM_DELTA_PIXEL` for every trackpad and for Chrome's mouse
 * wheel, but Firefox reports `DOM_DELTA_LINE` for a real wheel and a few
 * setups report `DOM_DELTA_PAGE`. Reading `deltaY` raw treated 3 lines as 3
 * pixels, so a mouse wheel barely moved the view there.
 */
export function wheelDeltaPixels(
  deltaY: number,
  deltaMode: number,
  charHeight: number,
  viewportHeight: number,
): number {
  if (deltaMode === 1) return deltaY * charHeight;
  if (deltaMode === 2) return deltaY * viewportHeight;
  return deltaY;
}

/**
 * Build the control-mode command that injects an SGR mouse report into a
 * mouse-tracking pane. `send-keys -H` (raw hex bytes) is the one reliable
 * transport: tmux ≥ 3.7 parses pane input arriving via load-buffer/
 * paste-buffer for mouse sequences and consumes them — the report never
 * reaches the application — and `send-keys -l` literals are format-expanded
 * (see docs/TMUX.md). Hex key bytes bypass both.
 *
 * Coordinates are 1-indexed SGR cell positions; `release` selects the
 * lowercase `m` terminator.
 */
export function sgrMouseCommand(
  paneId: string,
  button: number,
  cellX: number,
  cellY: number,
  release = false,
): string {
  const seq = `\x1b[<${button};${cellX};${cellY}${release ? 'm' : 'M'}`;
  const hex = Array.from(seq, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
  return `send-keys -t ${paneId} -H ${hex}`;
}

interface ScrollCommandOptions {
  send: (event: AppMachineEvent) => void;
  paneId: string;
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
        type: 'SEND_COMMAND',
        command: sgrMouseCommand(paneId, button, cellX + 1, cellY + 1),
      });
    }
  } else {
    const key = isScrollUp ? 'Up' : 'Down';
    for (let i = 0; i < absLines; i++) {
      send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} ${key}` });
    }
  }

  return true;
}
