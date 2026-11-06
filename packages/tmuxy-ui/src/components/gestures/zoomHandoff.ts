/**
 * When a pinch lifts, tmux is asked to zoom and GestureStage records here the
 * box the pane is drawn at; the zoom observer (paneWrapperHooks) animates the
 * new geometry from this box instead of the old slot, so the motion carries
 * straight on from the fingers.
 */

import type { Box } from '../../machines/gestures/gestures';
import type { PaneId } from '../../domain/ids';

let held: { paneId: PaneId; box: Box } | null = null;

export function holdZoomHandoff(paneId: PaneId, box: Box): void {
  held = { paneId, box };
}

/** Consumed by the first call; null when no pinch handed this pane off. */
export function takeZoomHandoff(paneId: PaneId): Box | null {
  if (held?.paneId !== paneId) return null;
  const { box } = held;
  held = null;
  return box;
}

export function clearZoomHandoff(): void {
  held = null;
}
