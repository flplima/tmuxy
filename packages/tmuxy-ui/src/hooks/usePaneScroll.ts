/**
 * usePaneScroll - Pixel-to-line accumulator for scroll events
 *
 * Accumulates deltaY pixels until they cross a line threshold,
 * then sends copy-mode scroll commands to tmux. No timers or debouncing —
 * fires immediately once the threshold is reached.
 */

import { useCallback, useRef } from 'react';
import type { AppMachineEvent } from '../machines/types';

export function usePaneScroll(
  send: (event: AppMachineEvent) => void,
  charHeight: number
): (e: React.WheelEvent, tmuxId: string) => void {
  const remainder = useRef(0);

  return useCallback(
    (e: React.WheelEvent, tmuxId: string) => {
      e.preventDefault();

      remainder.current += e.deltaY;
      const lines = Math.trunc(remainder.current / charHeight);
      if (lines === 0) return;
      remainder.current -= lines * charHeight;

      const direction = lines > 0 ? 'scroll-down' : 'scroll-up';
      send({ type: 'SEND_COMMAND', command: `copy-mode -e -t ${tmuxId}` });
      send({ type: 'SEND_COMMAND', command: `send-keys -t ${tmuxId} -X -N ${Math.abs(lines)} ${direction}` });
    },
    [send, charHeight]
  );
}
