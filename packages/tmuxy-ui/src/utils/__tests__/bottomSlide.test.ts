import { describe, expect, it } from 'vitest';
import { neighborSide, otherView, releaseBottomSlide } from '../bottomSlide';
import { SWIPE_SETTLE_MAX_MS, SWIPE_SETTLE_MIN_MS } from '../gestures';

describe('neighborSide', () => {
  it('draws the other view on the side the finger pulls from', () => {
    expect(neighborSide(-40)).toBe('right');
    expect(neighborSide(40)).toBe('left');
    expect(neighborSide(0)).toBeNull();
  });
});

describe('otherView', () => {
  it('is the view not in front', () => {
    expect(otherView('tree')).toBe('dock');
    expect(otherView('dock')).toBe('tree');
  });
});

describe('releaseBottomSlide', () => {
  const width = 390;

  it('carries a slide past the commit mark on to the other view, a view wide', () => {
    const release = releaseBottomSlide(-200, 0, width);
    expect(release).toMatchObject({ flips: true, target: -width });
    expect(release.settleMs).toBeGreaterThanOrEqual(SWIPE_SETTLE_MIN_MS);
    expect(release.settleMs).toBeLessThanOrEqual(SWIPE_SETTLE_MAX_MS);
  });

  it('settles a short slide back to rest', () => {
    expect(releaseBottomSlide(-30, 0, width)).toMatchObject({ flips: false, target: 0 });
  });

  it('lets a flick commit however short, on its speed', () => {
    expect(releaseBottomSlide(-30, -2, width)).toMatchObject({ flips: true, target: -width });
  });

  it('goes the way the finger went', () => {
    expect(releaseBottomSlide(200, 0, width)).toMatchObject({ flips: true, target: width });
  });

  it('settles faster the less is left to cover', () => {
    const far = releaseBottomSlide(-120, -0.6, width).settleMs;
    const near = releaseBottomSlide(-360, -0.6, width).settleMs;
    expect(near).toBeLessThan(far);
  });
});
