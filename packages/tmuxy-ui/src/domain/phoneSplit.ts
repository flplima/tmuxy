/**
 * The phone's split, upright: the terminal and the keys above, the bottom
 * view (the menu, the tree, the side pane) below, and a bar between them
 * that a finger drags (components/phone/PhoneDivider.tsx).
 *
 * Dragged down, the terminal grows as one picture: the panes, their headers
 * and tmux's status line scale together from the top-left corner, as far as
 * the bottom view has room to give. Dragged up from the terminal's own size,
 * past a threshold, the terminal and the keys fold away and the bottom view
 * takes the whole height; dragged down past it again, they come back.
 *
 * The zoom is the one a double tap sets (twice the size, or back), so the
 * bar moves with it. Both are kept per device (infra/prefs.ts). */

/** The zoom a double tap jumps to. */
export const PHONE_ZOOM_STEP = 2;

/** How far up (or back down) the bar is dragged to fold the terminal away (or back). */
export const COLLAPSE_PX = 60;

/** A release this close to the terminal's own size settles on it. */
export const SNAP_PX = 12;

/** How close to its own size the terminal must be for a drag up to fold it. */
const FOLD_SLACK_PX = 4;

export interface PhoneSplit {
  /** The terminal's scale: 1 is its own size, the 80 columns across the screen. */
  zoom: number;
  /** The terminal and the keys folded away, the bottom view the whole height. */
  collapsed: boolean;
}

export const DEFAULT_SPLIT: PhoneSplit = { zoom: 1, collapsed: false };

/** A drag in progress: where it started and the room it has. */
export interface SplitDrag {
  start: PhoneSplit;
  /** The terminal's height at its own size, px. */
  base: number;
  /** The most the terminal can grow to: its height and the bottom view's, px. */
  room: number;
}

/** The split while the bar is `dy` px below where the finger landed. */
export function dragSplit(drag: SplitDrag, dy: number): PhoneSplit {
  const { start, base, room } = drag;
  if (base <= 0) return start;
  if (start.collapsed) return dy > COLLAPSE_PX ? DEFAULT_SPLIT : start;
  if (dy < -COLLAPSE_PX && start.zoom * base <= base + FOLD_SLACK_PX) {
    return { zoom: 1, collapsed: true };
  }
  const most = Math.max(1, room / base);
  return { zoom: Math.min(most, Math.max(1, (start.zoom * base + dy) / base)), collapsed: false };
}

/** Where a released drag settles: on the terminal's own size when it is that close. */
export function releaseSplit(split: PhoneSplit, base: number): PhoneSplit {
  if (split.collapsed || split.zoom * base >= base + SNAP_PX) return split;
  return { zoom: 1, collapsed: false };
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
