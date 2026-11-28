/**
 * The handle along the top of the phone's bottom sheet: dragged down it zooms
 * the terminal as far as the sheet has room, dragged up it raises the sheet
 * over the page, settling covering it or back, and a double tap shares its
 * zoom.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLIT,
  dragSplit,
  parsePhoneSplit,
  releaseSplit,
  SNAP_PX,
  toggleZoom,
  type PhoneSplit,
} from '../phoneSplit';
import { SHEET_CLOSE_SHARE } from '../sheetSwipe';

/** A 312px terminal and its keys (a 400px page) over a 360px sheet. */
const drag = (start: PhoneSplit = DEFAULT_SPLIT) => ({
  start,
  base: 312,
  room: 312 + 360,
  cover: 400,
});
const COVERED: PhoneSplit = { zoom: 1, collapsed: true };

describe('dragSplit', () => {
  it('zooms the terminal by the height it is dragged down, no further than the room', () => {
    expect(dragSplit(drag(), 156)).toEqual({ zoom: 1.5, lift: 0 });
    expect(dragSplit(drag(), 1000).zoom).toBeCloseTo(672 / 312, 10);
    expect(dragSplit(drag({ zoom: 1.5, collapsed: false }), -100).zoom).toBeCloseTo(
      (468 - 100) / 312,
      10,
    );
  });

  it('raises the sheet by the height dragged up past the own size, no further than the page', () => {
    expect(dragSplit(drag(), -30)).toEqual({ zoom: 1, lift: 30 });
    expect(dragSplit(drag({ zoom: 1.5, collapsed: false }), -200)).toEqual({ zoom: 1, lift: 44 });
    expect(dragSplit(drag(), -1000)).toEqual({ zoom: 1, lift: 400 });
  });

  it('lowers a covering sheet by the height dragged down, and past rest zooms', () => {
    expect(dragSplit(drag(COVERED), 0)).toEqual({ zoom: 1, lift: 400 });
    expect(dragSplit(drag(COVERED), 100)).toEqual({ zoom: 1, lift: 300 });
    expect(dragSplit(drag(COVERED), 556)).toEqual({ zoom: 1.5, lift: 0 });
  });
});

describe('releaseSplit', () => {
  const release = (start: PhoneSplit, dy: number, speed = 0) =>
    releaseSplit(drag(start), dragSplit(drag(start), dy), speed);

  it('settles a zoom close to the own size on it, and keeps the rest', () => {
    expect(release(DEFAULT_SPLIT, SNAP_PX - 1)).toEqual(DEFAULT_SPLIT);
    expect(release(DEFAULT_SPLIT, 156)).toEqual({ zoom: 1.5, collapsed: false });
  });

  it('covers the page past a share of it, or flicked up; anything less goes back', () => {
    const share = 400 * SHEET_CLOSE_SHARE;
    expect(release(DEFAULT_SPLIT, -(share - 1))).toEqual(DEFAULT_SPLIT);
    expect(release(DEFAULT_SPLIT, -(share + 1))).toEqual(COVERED);
    expect(release(DEFAULT_SPLIT, -60, -1)).toEqual(COVERED);
  });

  it('lowers a covering sheet the same way down', () => {
    const share = 400 * SHEET_CLOSE_SHARE;
    expect(release(COVERED, share - 1)).toEqual(COVERED);
    expect(release(COVERED, share + 1)).toEqual(DEFAULT_SPLIT);
    expect(release(COVERED, 60, 1)).toEqual(DEFAULT_SPLIT);
    expect(release(COVERED, 556)).toEqual({ zoom: 1.5, collapsed: false });
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
