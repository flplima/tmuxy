/**
 * The tree's own record of a pane dropped on another tab, shown there from
 * the drop on while tmux carries out the `join-pane`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { TmuxPane } from '../domain/client';
import type { PaneId, WindowId } from '../domain/ids';

/**
 * How long the tree lists a dropped pane under its new tab without the model
 * agreeing. The join is not an op the client can predict, so a rejected one
 * is invisible to the tree; this is the bound after which the pane is listed
 * where tmux actually has it again.
 */
export const PENDING_MOVE_TIMEOUT_MS = 2000;

export interface PendingMove {
  paneId: PaneId;
  windowId: WindowId;
}

/**
 * The move being held, cleared once `panes` lists the pane under the window
 * it was dropped on, once the pane is gone, or after `PENDING_MOVE_TIMEOUT_MS`.
 */
export function usePendingMove(panes: ReadonlyArray<Pick<TmuxPane, 'tmuxId' | 'windowId'>>): {
  pendingMove: PendingMove | null;
  startMove: (paneId: PaneId, windowId: WindowId) => void;
} {
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  useEffect(() => {
    if (!pendingMove) return;
    const pane = panes.find((p) => p.tmuxId === pendingMove.paneId);
    if (!pane || pane.windowId === pendingMove.windowId) setPendingMove(null);
  }, [panes, pendingMove]);

  useEffect(() => {
    if (!pendingMove) return;
    const timer = window.setTimeout(
      () => setPendingMove((current) => (current === pendingMove ? null : current)),
      PENDING_MOVE_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [pendingMove]);

  const startMove = useCallback(
    (paneId: PaneId, windowId: WindowId) => setPendingMove({ paneId, windowId }),
    [],
  );

  return { pendingMove, startMove };
}
