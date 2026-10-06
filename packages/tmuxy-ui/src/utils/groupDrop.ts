/**
 * Dragging panes into, within and out of a pane group.
 *
 * A group's header is divided into equal shares, one per member, so where a
 * pointer sits along a header names a place in the group's order by
 * arithmetic alone — the drag machine has no element to ask, and the bands
 * are derived from the same pane boxes the swap hit test uses, so they stay
 * right after a live swap has moved the panes.
 *
 * - A member dragged along its own group's header moves to the share under
 *   the pointer (`pane-group-move`).
 * - An ungrouped pane dropped on another pane's header joins that pane's
 *   group, or forms one with it, at the gap nearest the pointer
 *   (`pane-group-join`).
 * - A parked member dragged out of its header leaves the group: next to the
 *   pane it is dropped on, or as a tab of its own (`pane-group-leave`).
 */

import type { TmuxPane } from '../tmux/types';
import type { PaneGroup } from '../machines/types';
import { PANE_INSET_Y, paneInsetX } from '../constants';
import type { TabDrop } from './tabStripDrop';

const SCRIPTS = '$HOME/.config/tmuxy/bin/tmuxy';

/** A pane header's box, container-relative, with the members sharing it. */
export interface HeaderBand {
  paneId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  members: string[];
}

/** Where a pane released over a header would go. */
export type GroupDrop =
  | { kind: 'order'; paneId: string; from: number; index: number }
  | { kind: 'join'; anchorPaneId: string; index: number };

export type Side = 'left' | 'right' | 'up' | 'down';

/** The member list of the group a pane is in, or null when it is in none. */
export function groupOf(groups: Record<string, PaneGroup>, paneId: string): string[] | null {
  for (const group of Object.values(groups)) {
    if (group.paneIds.includes(paneId)) return group.paneIds;
  }
  return null;
}

/** Each visible pane's header row, in the geometry of `findSwapTarget`. */
export function headerBands(
  panes: TmuxPane[],
  groups: Record<string, PaneGroup>,
  charWidth: number,
  charHeight: number,
  centerOffsetX: number,
  centerOffsetY: number,
): HeaderBand[] {
  const insetX = paneInsetX(charWidth);
  return panes.map((pane) => {
    const left = centerOffsetX + pane.x * charWidth - insetX;
    const top = centerOffsetY + Math.max(0, pane.y - 1) * charHeight - PANE_INSET_Y;
    return {
      paneId: pane.tmuxId,
      left,
      top,
      right: left + pane.width * charWidth + 2 * insetX,
      bottom: top + charHeight + PANE_INSET_Y,
      members: groupOf(groups, pane.tmuxId) ?? [pane.tmuxId],
    };
  });
}

/**
 * The drop the pointer is over, or null when it is on no header or on one the
 * dragged pane cannot go to: its own lone header, or another group while it
 * still belongs to one (it has to leave first).
 */
export function groupDropAt(
  bands: HeaderBand[],
  draggedId: string,
  draggedInGroup: boolean,
  x: number,
  y: number,
): GroupDrop | null {
  const band = bands.find((b) => x >= b.left && x < b.right && y >= b.top && y < b.bottom);
  if (!band) return null;
  const n = band.members.length;
  const share = (band.right - band.left) / n;
  const along = (x - band.left) / share;

  const from = band.members.indexOf(draggedId);
  if (from >= 0) {
    if (n < 2) return null;
    const index = Math.min(n - 1, Math.max(0, Math.floor(along)));
    return { kind: 'order', paneId: draggedId, from, index };
  }
  if (draggedInGroup) return null;
  const index = Math.min(n, Math.max(0, Math.round(along)));
  return { kind: 'join', anchorPaneId: band.paneId, index };
}

/** Whether two drops name the same place. */
export function sameGroupDrop(a: GroupDrop | null, b: GroupDrop | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The tmux command a group drop runs; null when the member is already there. */
export function groupDropCommand(drop: GroupDrop, draggedId: string): string | null {
  if (drop.kind === 'order') {
    if (drop.index === drop.from) return null;
    return `run-shell "${SCRIPTS}/pane-group-move ${drop.paneId} ${drop.index}"`;
  }
  return `run-shell "${SCRIPTS}/pane-group-join ${draggedId} ${drop.anchorPaneId} ${drop.index}"`;
}

/**
 * The side of a box the pointer is nearest, measured from its centre relative
 * to its size, so a tall pane splits above or below only near its ends.
 */
export function sideOf(
  box: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
): Side {
  const dx = (x - (box.left + box.right) / 2) / Math.max(1, box.right - box.left);
  const dy = (y - (box.top + box.bottom) / 2) / Math.max(1, box.bottom - box.top);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

/** Where a parked member dragged out of its group is released. */
export type LeaveDrop = { kind: 'beside'; paneId: string; side: Side } | TabDrop;

/** The command that takes a member out of its group to `drop`. */
export function leaveCommand(paneId: string, drop: LeaveDrop): string {
  const script = `${SCRIPTS}/pane-group-leave ${paneId}`;
  if (drop.kind === 'beside') return `run-shell "${script} --beside ${drop.paneId} ${drop.side}"`;
  // Over a tab: beside that window's active pane, which join-pane picks for a
  // window target.
  if (drop.kind === 'tab') return `run-shell "${script} --beside ${drop.windowId} right"`;
  return `run-shell "${script} --tab"`;
}
