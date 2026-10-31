import { describe, expect, it } from 'vitest';
import { contentAnchorFor } from '../paneContentAnchor';

const box = (top: number, height: number) => ({ left: 0, top, width: 400, height });

describe('the edge a morphing pane hangs its screen from', () => {
  it('is the top while the pane grows or shrinks below a top edge that holds', () => {
    expect(contentAnchorFor(box(37, 360), box(37, 720))).toBe('top');
    expect(contentAnchorFor(box(37, 720), box(37, 360))).toBe('top');
  });

  it('stays the bottom while the pane changes above a bottom edge that holds', () => {
    expect(contentAnchorFor(box(397, 360), box(37, 720))).toBe('bottom');
    expect(contentAnchorFor(box(37, 720), box(397, 360))).toBe('bottom');
  });

  it('follows whichever edge moves less when both do', () => {
    expect(contentAnchorFor(box(100, 300), box(90, 400))).toBe('top');
    expect(contentAnchorFor(box(100, 300), box(10, 400))).toBe('bottom');
  });

  it('has nothing to say while the height holds', () => {
    expect(contentAnchorFor(box(37, 360), box(37, 360))).toBeNull();
    expect(contentAnchorFor(box(37, 360), box(200, 360))).toBeNull();
  });
});
