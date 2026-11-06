import { describe, expect, it } from 'vitest';
import {
  BOTTOM_VIEWS,
  EDGE_RESISTANCE,
  neighborSide,
  neighborView,
  releaseBottomSlide,
  trackOffset,
} from '../bottomSlide';
import { SWIPE_SETTLE_MAX_MS, SWIPE_SETTLE_MIN_MS } from '../gestures';

describe('neighborSide', () => {
  it('draws the neighbour on the side the finger pulls from', () => {
    expect(neighborSide(-40)).toBe('right');
    expect(neighborSide(40)).toBe('left');
    expect(neighborSide(0)).toBeNull();
  });
});

describe('neighborView', () => {
  it('lays the menu, the tree and the side pane out left to right', () => {
    expect(BOTTOM_VIEWS).toEqual(['menu', 'tree', 'dock']);
    expect(neighborView('tree', 'left')).toBe('menu');
    expect(neighborView('tree', 'right')).toBe('dock');
    expect(neighborView('menu', 'right')).toBe('tree');
    expect(neighborView('dock', 'left')).toBe('tree');
  });

  it('has nothing past either end', () => {
    expect(neighborView('menu', 'left')).toBeNull();
    expect(neighborView('dock', 'right')).toBeNull();
  });
});

describe('trackOffset', () => {
  it('follows the finger toward a neighbour, and a third of it past an end', () => {
    expect(trackOffset('tree', 90)).toBe(90);
    expect(trackOffset('tree', -90)).toBe(-90);
    expect(trackOffset('menu', 90)).toBeCloseTo(90 * EDGE_RESISTANCE);
    expect(trackOffset('dock', -90)).toBeCloseTo(-90 * EDGE_RESISTANCE);
  });
});

describe('releaseBottomSlide', () => {
  const width = 390;

  it('carries a slide past the commit mark on to the neighbour, a view wide', () => {
    const release = releaseBottomSlide('tree', -200, 0, width);
    expect(release).toMatchObject({ next: 'dock', target: -width });
    expect(release.settleMs).toBeGreaterThanOrEqual(SWIPE_SETTLE_MIN_MS);
    expect(release.settleMs).toBeLessThanOrEqual(SWIPE_SETTLE_MAX_MS);
    expect(releaseBottomSlide('tree', 200, 0, width)).toMatchObject({
      next: 'menu',
      target: width,
    });
  });

  it('settles a short slide back to rest', () => {
    expect(releaseBottomSlide('tree', -30, 0, width)).toMatchObject({ next: null, target: 0 });
  });

  it('lets a flick commit however short, on its speed', () => {
    expect(releaseBottomSlide('tree', -30, -2, width)).toMatchObject({
      next: 'dock',
      target: -width,
    });
  });

  it('goes back to rest past an end, however far or fast', () => {
    expect(releaseBottomSlide('menu', 300, 2, width)).toMatchObject({ next: null, target: 0 });
    expect(releaseBottomSlide('dock', -300, -2, width)).toMatchObject({ next: null, target: 0 });
  });

  it('settles faster the less is left to cover', () => {
    const far = releaseBottomSlide('tree', -120, -0.6, width).settleMs;
    const near = releaseBottomSlide('tree', -360, -0.6, width).settleMs;
    expect(near).toBeLessThan(far);
  });
});
