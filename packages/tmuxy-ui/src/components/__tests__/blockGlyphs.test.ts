import { describe, it, expect } from 'vitest';
import { isBlockGlyph, blockGlyphStyle } from '../blockGlyphs';

/**
 * Block Elements are painted as CSS rectangles rather than font glyphs so a
 * cell is filled edge to edge. Font outlines do not do this — `█` inks 19px of
 * a 24px cell in the terminal font — which sliced stacked block art into
 * horizontal stripes.
 */
describe('blockGlyphs', () => {
  it('claims the Block Elements it can draw and nothing else', () => {
    for (const ch of ['█', '▀', '▄', '▌', '▐', '░', '▒', '▓', '▁', '▇', '▖', '▟']) {
      expect(isBlockGlyph(ch), `${ch} should be drawn geometrically`).toBe(true);
    }
    // Box drawing already fills the cell in the font, and ordinary text must
    // keep its glyphs — neither should be replaced by a rectangle.
    for (const ch of ['║', '═', '╗', 'A', ' ', '你', '🎉']) {
      expect(isBlockGlyph(ch), `${ch} should use the font`).toBe(false);
    }
  });

  it('fills the whole cell for a full block', () => {
    const s = blockGlyphStyle('█', 'rgb(1, 2, 3)');
    expect(s).not.toBeNull();
    // A gradient with no stops covers the entire box.
    expect(s!.backgroundImage).toBe('linear-gradient(rgb(1, 2, 3), rgb(1, 2, 3))');
    expect(s!.backgroundSize).toBeUndefined();
  });

  it('splits the cell at the right edge and fraction for half blocks', () => {
    // Upper half paints from the top down, so the gradient runs "to bottom".
    expect(blockGlyphStyle('▀', 'red')!.backgroundImage).toBe(
      'linear-gradient(to bottom, red 50%, transparent 50%)',
    );
    expect(blockGlyphStyle('▄', 'red')!.backgroundImage).toBe(
      'linear-gradient(to top, red 50%, transparent 50%)',
    );
    expect(blockGlyphStyle('▌', 'red')!.backgroundImage).toBe(
      'linear-gradient(to right, red 50%, transparent 50%)',
    );
    expect(blockGlyphStyle('▐', 'red')!.backgroundImage).toBe(
      'linear-gradient(to left, red 50%, transparent 50%)',
    );
  });

  it('scales eighth blocks by eighths', () => {
    expect(blockGlyphStyle('▁', 'red')!.backgroundImage).toContain('red 12.5%');
    expect(blockGlyphStyle('▇', 'red')!.backgroundImage).toContain('red 87.5%');
    expect(blockGlyphStyle('▏', 'red')!.backgroundImage).toContain('red 12.5%');
  });

  it('places quadrants in their corners', () => {
    const ul = blockGlyphStyle('▘', 'red')!;
    expect(ul.backgroundSize).toBe('50% 50%');
    expect(ul.backgroundPosition).toBe('0% 0%');

    const lr = blockGlyphStyle('▗', 'red')!;
    expect(lr.backgroundPosition).toBe('100% 100%');

    // Three-quadrant glyphs stack one layer per quadrant.
    const three = blockGlyphStyle('▙', 'red')!;
    expect(three.backgroundPosition).toBe('0% 0%, 0% 100%, 100% 100%');
    expect(three.backgroundSize).toBe('50% 50%, 50% 50%, 50% 50%');
  });

  it('renders shades as a partial wash of the foreground', () => {
    expect(blockGlyphStyle('░', 'red')!.backgroundImage).toContain(
      'color-mix(in srgb, red 25%, transparent)',
    );
    expect(blockGlyphStyle('▓', 'red')!.backgroundImage).toContain('red 75%');
  });

  it('accepts a CSS variable as the colour', () => {
    // The foreground is often inherited rather than an explicit colour, so the
    // substitution must survive a var() reference — hence color-mix over
    // relative-colour syntax for shades.
    const s = blockGlyphStyle('▒', 'var(--terminal-fg, #fff)')!;
    expect(s.backgroundImage).toContain('var(--terminal-fg, #fff) 50%');
  });

  it('returns null for characters the font should draw', () => {
    expect(blockGlyphStyle('A', 'red')).toBeNull();
    expect(blockGlyphStyle('║', 'red')).toBeNull();
  });

  it('never repeats a fill, so a run of cells stays one flat shape', () => {
    expect(blockGlyphStyle('█', 'red')!.backgroundRepeat).toBe('no-repeat');
  });
});
