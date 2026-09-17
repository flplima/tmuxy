import { describe, expect, it } from 'vitest';
import {
  SWIPE_EDGE_LIMIT_SHARE,
  SWIPE_GUTTER_PX,
  SWIPE_SETTLE_MAX_MS,
  SWIPE_SETTLE_MIN_MS,
  boxTransform,
  enterTransform,
  gestureStageMode,
  gridGestureTransform,
  neighborTab,
  parseSwipeNeighbor,
  rubberBand,
  scaledBox,
  swipeCommits,
  swipeOffsetPx,
  swipeSettleMs,
  zoomGrowBox,
} from '../gestures';
import type { GestureState, TmuxWindow } from '../../machines/types';

const tab = (id: string) => ({ id }) as TmuxWindow;
const tabs = [tab('@1'), tab('@2'), tab('@3')];

type SwipeGesture = Extract<GestureState, { kind: 'swipe' }>;

const swipe = (
  dx: number,
  neighborId: string | null,
  phase: SwipeGesture['phase'],
): SwipeGesture => ({
  kind: 'swipe',
  dx,
  neighborId,
  phase,
  settleMs: 0,
});

describe('neighborTab', () => {
  it('pulls in the next tab when the fingers move left and the previous one when they move right', () => {
    expect(neighborTab(tabs, '@2', -40)?.id).toBe('@3');
    expect(neighborTab(tabs, '@2', 40)?.id).toBe('@1');
  });

  it('has nothing to pull in past either end of the strip', () => {
    expect(neighborTab(tabs, '@3', -40)).toBeNull();
    expect(neighborTab(tabs, '@1', 40)).toBeNull();
    expect(neighborTab(tabs, '@2', 0)).toBeNull();
  });
});

describe('parseSwipeNeighbor', () => {
  it('splits the tab id from the side it comes in from', () => {
    expect(parseSwipeNeighbor('@3:1')).toEqual(['@3', 1]);
    expect(parseSwipeNeighbor('@1:-1')).toEqual(['@1', -1]);
    expect(parseSwipeNeighbor(null)).toEqual([null, 0]);
  });
});

describe('rubberBand', () => {
  it('follows the fingers at first, then less and less, and never past the limit', () => {
    const width = 1000;
    const limit = width * SWIPE_EDGE_LIMIT_SHARE;
    expect(rubberBand(20, width)).toBeCloseTo((20 * limit) / (limit + 20), 5);
    // Half the give of the first 100px, over the second.
    const first = rubberBand(100, width);
    const second = rubberBand(200, width) - first;
    expect(second).toBeLessThan(first);
    expect(rubberBand(100000, width)).toBeLessThan(limit);
    expect(rubberBand(-100, width)).toBeCloseTo(-first, 5);
  });
});

describe('swipeCommits', () => {
  it('commits a slide already half way across, however slowly it was released', () => {
    expect(swipeCommits(-520, 0, 1000)).toBe(true);
    expect(swipeCommits(520, 0, 1000)).toBe(true);
  });

  it('commits a flick short of half way, on the speed it was released at', () => {
    // 200px in hand at 3px/ms lands at 560 - past half of 1000.
    expect(swipeCommits(-200, -3, 1000)).toBe(true);
    expect(swipeCommits(-200, -0.5, 1000)).toBe(false);
  });

  it('settles a slow drag short of half way back where it started', () => {
    expect(swipeCommits(-240, -0.25, 1000)).toBe(false);
  });

  it('lets a slide pulled back as it is released settle where it started', () => {
    expect(swipeCommits(-450, 2, 1000)).toBe(false);
    expect(swipeCommits(0, -5, 1000)).toBe(false);
  });
});

describe('swipeSettleMs', () => {
  it('scales the time to the distance left and the speed, within bounds', () => {
    expect(swipeSettleMs(300, 1.5)).toBe(200);
    expect(swipeSettleMs(-300, -1.5)).toBe(200);
    expect(swipeSettleMs(20, 1.5)).toBe(SWIPE_SETTLE_MIN_MS);
    expect(swipeSettleMs(2000, 0.2)).toBe(SWIPE_SETTLE_MAX_MS);
    expect(swipeSettleMs(300, 0)).toBe(SWIPE_SETTLE_MAX_MS);
  });
});

describe('swipeOffsetPx', () => {
  it('is one tab of panes wide - a cell more than its cells - plus the gutter', () => {
    expect(swipeOffsetPx(100, 8)).toBe(101 * 8 + SWIPE_GUTTER_PX);
  });
});

describe('gestureStageMode', () => {
  it('moves the grid with the fingers, settles a released slide, and enters from the overview', () => {
    expect(gestureStageMode(null)).toBeNull();
    expect(gestureStageMode(swipe(10, '@1', 'tracking'))).toBe('moving');
    expect(gestureStageMode(swipe(800, '@1', 'finishing'))).toBe('settling');
    expect(
      gestureStageMode({
        kind: 'pinch',
        mode: 'enter',
        scale: 1.2,
        paneId: '%0',
        phase: 'tracking',
      }),
    ).toBe('entering');
  });
});

describe('gridGestureTransform', () => {
  it('moves the grid with the fingers, and gives with resistance past the last tab', () => {
    expect(gridGestureTransform(swipe(100, '@1', 'tracking'), 800, 600)).toBe(
      'translate3d(100px, 0, 0)',
    );
    expect(gridGestureTransform(swipe(100, null, 'tracking'), 800, 600)).toBe(
      `translate3d(${rubberBand(100, 800)}px, 0, 0)`,
    );
    // A finishing slide has already switched tabs: this is where the grid
    // starts, resistance or not, before it runs home.
    expect(gridGestureTransform(swipe(-995, null, 'finishing'), 800, 600)).toBe(
      'translate3d(-995px, 0, 0)',
    );
    // One sliding back belongs at rest, which is the stylesheet's job.
    expect(gridGestureTransform(swipe(0, '@1', 'cancelling'), 800, 600)).toBeNull();
  });

  it('carries on from where the grid was when a slide took over one still sliding home', () => {
    expect(gridGestureTransform(swipe(60, '@1', 'tracking'), 800, 600, -140)).toBe(
      'translate3d(-80px, 0, 0)',
    );
    expect(gridGestureTransform(swipe(-935, '@1', 'finishing'), 800, 600, -140)).toBe(
      'translate3d(-1075px, 0, 0)',
    );
    // Wherever it started, sliding back means rest.
    expect(gridGestureTransform(swipe(0, '@1', 'cancelling'), 800, 600, -140)).toBeNull();
  });

  it('shrinks the grid about its centre on a pinch in, and leaves it to the pane or the card otherwise', () => {
    const pinch = (mode: 'overview' | 'zoom' | 'enter', scale: number) =>
      gridGestureTransform(
        { kind: 'pinch', mode, scale, paneId: '%0', phase: 'tracking' },
        800,
        600,
      );
    expect(pinch('overview', 0.5)).toBe('translate(200px, 150px) scale(0.5)');
    expect(pinch('zoom', 1.5)).toBeNull();
    expect(pinch('enter', 1.5)).toBeNull();
    expect(gridGestureTransform(null, 800, 600)).toBeNull();
  });
});

describe('zoom geometry', () => {
  const pane = { left: 400, top: 0, width: 400, height: 600 };
  const full = { left: 0, top: 0, width: 800, height: 600 };

  it('grows a pinched pane from its slot to the full grid, and no further', () => {
    expect(zoomGrowBox(pane, full, 1)).toEqual(pane);
    expect(zoomGrowBox(pane, full, 1.3)).toEqual({ left: 200, top: 0, width: 600, height: 600 });
    expect(zoomGrowBox(pane, full, 3)).toEqual(full);
  });

  it('draws a box inside a grid scaled about its centre', () => {
    expect(scaledBox(full, 0.5, 800, 600)).toEqual({
      left: 200,
      top: 150,
      width: 400,
      height: 300,
    });
  });

  it('turns one box into another as a translate + scale', () => {
    expect(boxTransform(pane, full)).toBe('translate(-400px, 0px) scale(2, 1)');
  });

  it('draws the overview card transform part of the way back to full size', () => {
    expect(enterTransform(100, 40, 0.25, 0.5, 0)).toBe('translate(100px, 40px) scale(0.25, 0.5)');
    expect(enterTransform(100, 40, 0.25, 0.5, 0.5)).toBe(
      'translate(50px, 20px) scale(0.625, 0.75)',
    );
    expect(enterTransform(100, 40, 0.25, 0.5, 1)).toBe('translate(0px, 0px) scale(1, 1)');
  });
});
