import { describe, it, expect } from 'vitest';
import { rowEdgeBackground } from '../terminalRendering';

/**
 * Inverse video with the default colours swaps the THEME's foreground and
 * background, never a literal white on black: a light theme's reversed text
 * is its dark ink as the ground.
 */
describe('inverse video with default colours', () => {
  it('paints the theme foreground as the ground', () => {
    expect(rowEdgeBackground({ inverse: true })).toBe('var(--term-foreground)');
  });

  it('paints nothing for a plain cell, so the pane background shows', () => {
    expect(rowEdgeBackground({})).toBeUndefined();
  });
});
