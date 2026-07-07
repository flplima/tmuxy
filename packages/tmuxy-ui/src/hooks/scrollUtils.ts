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
