/**
 * The bar between the phone's terminal and its bottom view: dragged down it
 * zooms the terminal as far as the bottom view has room, dragged up from the
 * terminal's own size it folds it away, and the zoom key shares its zoom.
 */

import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_PX,
  DEFAULT_SPLIT,
  dragSplit,
  parsePhoneSplit,
  releaseSplit,
  SNAP_PX,
  toggleZoom,
} from '../phoneSplit';

/** A 312px terminal over a 360px bottom view. */
const drag = (start = DEFAULT_SPLIT) => ({ start, base: 312, room: 312 + 360 });

describe('dragSplit', () => {
  it('zooms the terminal by the height it is dragged to, no further than the room', () => {
    expect(dragSplit(drag(), 156).zoom).toBeCloseTo(1.5, 10);
    expect(dragSplit(drag(), 1000).zoom).toBeCloseTo(672 / 312, 10);
    expect(dragSplit(drag({ zoom: 1.5, collapsed: false }), -100).zoom).toBeCloseTo(
      (468 - 100) / 312,
      10,
    );
  });

  it('never shrinks the terminal below its own size', () => {
    expect(dragSplit(drag(), -30)).toEqual(DEFAULT_SPLIT);
    expect(dragSplit(drag({ zoom: 1.2, collapsed: false }), -COLLAPSE_PX - 50)).toEqual(
      DEFAULT_SPLIT,
    );
  });

  it('folds the terminal away past the threshold up, from its own size only', () => {
    expect(dragSplit(drag(), -COLLAPSE_PX + 1).collapsed).toBe(false);
    expect(dragSplit(drag(), -COLLAPSE_PX - 1)).toEqual({ zoom: 1, collapsed: true });
  });

  it('brings a folded terminal back past the threshold down, at its own size', () => {
    const folded = drag({ zoom: 1, collapsed: true });
    expect(dragSplit(folded, COLLAPSE_PX - 1).collapsed).toBe(true);
    expect(dragSplit(folded, COLLAPSE_PX + 1)).toEqual(DEFAULT_SPLIT);
  });
});

describe('releaseSplit', () => {
  it('settles a release close to the own size on it, and keeps the rest', () => {
    expect(releaseSplit({ zoom: 1 + (SNAP_PX - 1) / 312, collapsed: false }, 312)).toEqual(
      DEFAULT_SPLIT,
    );
    expect(releaseSplit({ zoom: 1.5, collapsed: false }, 312)).toEqual({
      zoom: 1.5,
      collapsed: false,
    });
    expect(releaseSplit({ zoom: 1, collapsed: true }, 312).collapsed).toBe(true);
  });
});

describe('toggleZoom', () => {
  it('jumps to twice the size, and from any zoom back to the own size, unfolded', () => {
    expect(toggleZoom(DEFAULT_SPLIT)).toEqual({ zoom: 2, collapsed: false });
    expect(toggleZoom({ zoom: 1.4, collapsed: false })).toEqual(DEFAULT_SPLIT);
    expect(toggleZoom({ zoom: 1, collapsed: true })).toEqual({ zoom: 2, collapsed: false });
  });
});

describe('a kept split', () => {
  it('reads back as it was written, and as the default when nothing or junk was', () => {
    expect(parsePhoneSplit(null)).toEqual(DEFAULT_SPLIT);
    expect(parsePhoneSplit(JSON.stringify({ zoom: 1.75, collapsed: true }))).toEqual({
      zoom: 1.75,
      collapsed: true,
    });
    expect(parsePhoneSplit('{"zoom":0.2}')).toEqual(DEFAULT_SPLIT);
    expect(parsePhoneSplit('not json')).toEqual(DEFAULT_SPLIT);
  });
});
