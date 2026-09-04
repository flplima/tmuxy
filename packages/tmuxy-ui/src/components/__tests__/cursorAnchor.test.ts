import { describe, it, expect } from 'vitest';
import {
  attachCursorAnchor,
  getCursorAnchor,
  getCursorAnchorVersion,
  subscribeCursorAnchor,
} from '../cursorAnchor';

describe('cursorAnchor', () => {
  it('the latest attached element is the anchor, and detaching it clears it', () => {
    const a = document.createElement('span');
    const detachA = attachCursorAnchor(a);
    expect(getCursorAnchor()).toBe(a);
    detachA();
    expect(getCursorAnchor()).toBeNull();
  });

  it('a stale detach does not clear a newer anchor (React re-attaches on every commit)', () => {
    const a = document.createElement('span');
    const b = document.createElement('span');
    const detachA = attachCursorAnchor(a);
    attachCursorAnchor(b);
    detachA();
    expect(getCursorAnchor()).toBe(b);
  });

  it('every attach and detach bumps the version and notifies subscribers', () => {
    let notified = 0;
    const unsubscribe = subscribeCursorAnchor(() => {
      notified += 1;
    });
    const before = getCursorAnchorVersion();
    const detach = attachCursorAnchor(document.createElement('span'));
    detach();
    expect(getCursorAnchorVersion()).toBe(before + 2);
    expect(notified).toBe(2);
    unsubscribe();
    attachCursorAnchor(document.createElement('span'));
    expect(notified).toBe(2);
  });
});
