/**
 * The phone's split, upright: the page — the terminal and the keys — and the
 * bottom view (the menu, the tree, the side pane) under it as a sheet, its
 * handle along its top (components/phone/PhoneDivider.tsx).
 *
 * The handle moves along one line. Dragged down from rest, the terminal grows
 * as one picture: the panes, their headers and tmux's status line scale
 * together from the top-left corner, the keys and the sheet moving down with
 * them, as far as the sheet has room to give. Dragged up from the terminal's
 * own size, the sheet rises over the page, which keeps its size and fades to
 * dark under it; released past a quarter of the way, or flicked, it covers
 * the page (`collapsed`), anything less goes back down. Covered, a drag down
 * lowers it, by the same rule the other way.
 *
 * The zoom is the one a double tap sets (twice the size, or back), so the
 * handle moves with it. Both are kept per device (infra/prefs.ts). */

import { sheetCloses } from './sheetSwipe';

/** The zoom a double tap jumps to. */
export const PHONE_ZOOM_STEP = 2;

/** A release this close to the terminal's own size settles on it. */
export const SNAP_PX = 12;

export interface PhoneSplit {
  /** The terminal's scale: 1 is its own size, the 80 columns across the screen. */
  zoom: number;
  /** The sheet raised over the whole page, the terminal and the keys under it. */
  collapsed: boolean;
}

export const DEFAULT_SPLIT: PhoneSplit = { zoom: 1, collapsed: false };

/** A drag in progress: where it started and the room it has. */
export interface SplitDrag {
  start: PhoneSplit;
  /** The terminal's height at its own size, px. */
  base: number;
  /** The most the terminal can grow to: its height and the sheet's, px. */
  room: number;
  /** The page's height (the terminal and the keys): how far the sheet rises, px. */
  cover: number;
}

/** Where the handle is while a finger has it. */
export interface SplitPosition {
  zoom: number;
  /** How far the sheet is raised over the page, px. */
  lift: number;
}

/** The handle's place on its line: below rest it is the zoom, above it the lift. */
const placeOf = (split: PhoneSplit, base: number, cover: number) =>
  split.collapsed ? -cover : (split.zoom - 1) * base;

/** Where the handle is `dy` px below where the finger landed. */
export function dragSplit(drag: SplitDrag, dy: number): SplitPosition {
  const { start, base, room, cover } = drag;
  if (base <= 0) return { zoom: start.zoom, lift: start.collapsed ? cover : 0 };
  const most = Math.max(0, room - base);
  const at = Math.min(most, Math.max(-cover, placeOf(start, base, cover) + dy));
  return { zoom: 1 + Math.max(0, at) / base, lift: Math.max(0, -at) };
}

/**
 * Where a drag released at `pos`, moving down at `speed` px/ms, settles: a
 * raised sheet up or down as a pulled sheet decides (sheetSwipe.ts), a zoom
 * on the terminal's own size when it is that close.
 */
export function releaseSplit(drag: SplitDrag, pos: SplitPosition, speed: number): PhoneSplit {
  const { start, base, cover } = drag;
  if (pos.lift > 0) {
    const covers = start.collapsed
      ? !sheetCloses(cover - pos.lift, speed, cover)
      : sheetCloses(pos.lift, -speed, cover);
    return covers ? { zoom: 1, collapsed: true } : DEFAULT_SPLIT;
  }
  if (pos.zoom * base >= base + SNAP_PX) return { zoom: pos.zoom, collapsed: false };
  return DEFAULT_SPLIT;
}

/** A double tap: twice the size, or back to its own. */
export function toggleZoom(split: PhoneSplit): PhoneSplit {
  return { zoom: split.zoom > 1 ? 1 : PHONE_ZOOM_STEP, collapsed: false };
}

/** A split as it was kept (JSON), or the default when nothing or junk was. */
export function parsePhoneSplit(kept: string | null): PhoneSplit {
  try {
    const raw = JSON.parse(kept ?? 'null') as Partial<PhoneSplit> | null;
    const zoom = typeof raw?.zoom === 'number' && raw.zoom >= 1 ? raw.zoom : 1;
    return { zoom, collapsed: raw?.collapsed === true };
  } catch {
    return DEFAULT_SPLIT;
  }
}
