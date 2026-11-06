import {
  type TmuxSnapshot,
  type Patch,
  type ReconcileVerdict,
  FOCUS_CONFIRM_LINGER_MS,
} from './types';
import type { TmuxPane } from '../client';
import type { TmuxOpOf } from '../commands';
import type { PredictResult } from './ops';
import { withoutPane } from './paneOps';

/**
 * A pane moved into another tab (`join-pane -s <pane> -t <window>`): it
 * leaves its window as a kill would (a neighbour takes its space) and splits
 * the target window's active pane, stacked below it as `join-pane`'s default
 * `-v` does, as that window's active pane.
 */
export function predictJoinPane(
  op: TmuxOpOf<'JoinPane'>,
  snapshot: TmuxSnapshot,
): PredictResult | null {
  const moving = snapshot.panes.find((p) => p.tmuxId === op.paneId);
  if (!moving || moving.windowId === op.windowId) return null;
  if (!snapshot.windows.some((w) => w.id === op.windowId)) return null;

  const patch: Patch = (s) => {
    const pane = s.panes.find((p) => p.tmuxId === op.paneId);
    const target = s.windows.find((w) => w.id === op.windowId);
    if (!pane || !target || pane.windowId === op.windowId) return s;
    const inTarget = s.panes.filter((p) => p.windowId === op.windowId);
    const anchor =
      inTarget.find((p) => p.tmuxId === target.activePaneId) ??
      inTarget.find((p) => p.active) ??
      inTarget[0];
    if (!anchor) return s;
    const below = Math.floor(anchor.height / 2);
    const above = anchor.height - below - 1;
    const panes = withoutPane(s.panes, pane).map((p) =>
      p.tmuxId === anchor.tmuxId ? { ...p, height: above } : p,
    );
    panes.push({
      ...pane,
      windowId: op.windowId,
      x: anchor.x,
      y: anchor.y + above + 1,
      width: anchor.width,
      height: below,
    });
    return {
      ...s,
      panes,
      windows: s.windows.map((w) => (w.id === op.windowId ? { ...w, activePaneId: op.paneId } : w)),
    };
  };

  return { patch, meta: { paneId: op.paneId, windowId: op.windowId } };
}

/**
 * Confirmed once tmux lists the pane in the target window (or no longer at
 * all), lingering like a kill so a snapshot from before the move cannot put
 * it back for a beat.
 */
export function reconcileJoinPane(
  meta: Readonly<Record<string, unknown>>,
  panes: ReadonlyArray<TmuxPane>,
  ageMs: number,
): ReconcileVerdict {
  const pane = panes.find((p) => p.tmuxId === meta.paneId);
  if (pane && pane.windowId !== meta.windowId) return { _tag: 'pending' };
  return ageMs >= FOCUS_CONFIRM_LINGER_MS ? { _tag: 'matched' } : { _tag: 'pending' };
}
