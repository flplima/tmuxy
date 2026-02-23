/**
 * scrollUtils - Shared scroll command logic for wheel and touch handlers
 *
 * Encapsulates the three-mode scroll routing:
 * 1. Alternate screen (vim, less, htop) → send Up/Down arrow keys
 * 2. Mouse tracking (apps requesting mouse) → send SGR wheel events
 * 3. Normal shell → proxy pixel delta to scroll container (native copy mode)
 */

import type { AppMachineEvent } from '../machines/types';

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

  if (alternateOn) {
    const key = isScrollUp ? 'Up' : 'Down';
    for (let i = 0; i < absLines; i++) {
      send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} ${key}` });
    }
  } else {
    // Mouse tracking mode: send SGR wheel events
    const button = isScrollUp ? 64 : 65;
    for (let i = 0; i < absLines; i++) {
      send({
        type: 'SEND_COMMAND',
        command: `run-shell -b 'printf "\\033[<${button};${cellX + 1};${cellY + 1}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
      });
    }
  }

  return true;
}
