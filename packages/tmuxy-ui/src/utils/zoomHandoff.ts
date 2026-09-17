/**
 * The hand-off from a committed pinch to the zoom it asked for.
 *
 * While the fingers are down a pinch draws the pane (or the whole grid) where
 * they have it. When they lift, tmux is asked to zoom, and GestureStage holds
 * the drawing and records here the box the pane is drawn at. PaneLayout's zoom
 * MutationObserver catches the exact mutation that gives the pane its new
 * geometry and animates it from this box instead of from its old slot, so the
 * motion carries straight on from the fingers with no step back in between.
 */

import type { Box } from './gestures';

let held: { paneId: string; box: Box } | null = null;

export function holdZoomHandoff(paneId: string, box: Box): void {
  held = { paneId, box };
}

/** The box a committed pinch left `paneId` at, once; null when no pinch handed this pane off. */
export function takeZoomHandoff(paneId: string): Box | null {
  if (held?.paneId !== paneId) return null;
  const { box } = held;
  held = null;
  return box;
}

export function clearZoomHandoff(): void {
  held = null;
}
