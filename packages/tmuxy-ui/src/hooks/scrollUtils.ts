/**
 * scrollUtils - Shared scroll command logic for wheel and touch handlers.
 *
 * Encapsulates the three-mode scroll routing:
 * 1. Mouse tracking (apps requesting mouse, e.g. nvim with `mouse=a`) → SGR wheel events
 * 2. Alternate screen without mouse (vim with `mouse=`, less) → Up/Down arrow keys
 * 3. Normal shell → enter tmux's native copy mode and scroll-up/scroll-down
 *
 * Mouse tracking takes precedence over alternate-screen: when the app explicitly
 * enabled mouse reporting, it expects raw mouse events, not synthetic arrow keys
 * (which would move the cursor in nvim, not scroll the viewport).
 */

import type { AppMachineEvent } from '../machines/types';
import { scrollCommands } from '../utils/nativeCopyMode';

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
 * Send scroll commands to tmux. Routes to the correct mode (SGR wheel events,
 * arrow keys, or native copy-mode scrolling) based on pane state. Handles all
 * three modes — there is no fall-through case for callers to handle.
 */
export function sendScrollLines(opts: ScrollCommandOptions): void {
  const { send, paneId, lines, alternateOn, mouseAnyFlag, cellX = 0, cellY = 0 } = opts;

  if (lines === 0) return;

  const isScrollUp = lines < 0;
  const absLines = Math.abs(lines);

  if (mouseAnyFlag) {
    // Mouse tracking mode: send SGR wheel events
    const button = isScrollUp ? 64 : 65;
    for (let i = 0; i < absLines; i++) {
      send({
        type: 'SEND_COMMAND',
        command: `run-shell -b 'printf "\\033[<${button};${cellX + 1};${cellY + 1}M" | tmux load-buffer - && tmux paste-buffer -t ${paneId} -d'`,
      });
    }
    return;
  }

  if (alternateOn) {
    const key = isScrollUp ? 'Up' : 'Down';
    for (let i = 0; i < absLines; i++) {
      send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} ${key}` });
    }
    return;
  }

  // Normal shell: enter tmux's native copy mode and scroll. A wheel-up with
  // history scrolls into the scrollback; scrolling back to the bottom auto-exits
  // copy mode (copy-mode -e).
  for (const command of scrollCommands(paneId, lines)) {
    send({ type: 'SEND_COMMAND', command });
  }
}
