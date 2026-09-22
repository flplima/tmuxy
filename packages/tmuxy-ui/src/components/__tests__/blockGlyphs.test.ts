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
    expect(s!.backgroundSize).toBe('var(--cell-w, 1ch) 100%');
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
    // A quadrant is a half-height tile against one edge, filling one side of
    // the cell it is drawn in.
    const ul = blockGlyphStyle('▘', 'red')!;
    expect(ul.backgroundSize).toBe('var(--cell-w, 1ch) 50%');
    expect(ul.backgroundPosition).toBe('left top');
    expect(ul.backgroundImage).toBe('linear-gradient(to right, red 50%, transparent 50%)');

    const lr = blockGlyphStyle('▗', 'red')!;
    expect(lr.backgroundPosition).toBe('left bottom');
    expect(lr.backgroundImage).toBe('linear-gradient(to left, red 50%, transparent 50%)');

    // Three-quadrant glyphs are one half filled whole over the other half's side.
    const three = blockGlyphStyle('▙', 'red')!;
    expect(three.backgroundPosition).toBe('left top, left bottom');
    expect(three.backgroundSize).toBe('var(--cell-w, 1ch) 50%, var(--cell-w, 1ch) 50%');
    expect(three.backgroundImage).toBe(
      'linear-gradient(to right, red 50%, transparent 50%), linear-gradient(red, red)',
    );
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

  /**
   * A style group is ONE span across every cell that shares a style, so a run
   * of the same glyph is a single box. Sized in percent, `▌` drew one left
   * half across the whole run — the ASCII-art logos that use it came out
   * stretched — and a quadrant covered half the run. The tile is a cell.
   */
  it('tiles one glyph per cell, so a run is a run of glyphs', () => {
    for (const ch of ['█', '▌', '▐', '▀', '▖', '▚', '░']) {
      const s = blockGlyphStyle(ch, 'red')!;
      // Split before each layer's tile, not on every comma: `var(--cell-w,
      // 1ch)` has one of its own.
      const sizes = s.backgroundSize.split(/,\s(?=var\()/);
      const repeats = s.backgroundRepeat.split(', ');
      expect(sizes.length, `${ch} sizes one tile per layer`).toBe(repeats.length);
      for (const size of sizes) {
        expect(size, `${ch} tiles a cell wide`).toMatch(/^var\(--cell-w, 1ch\) (100|50)%$/);
      }
      for (const repeat of repeats) {
        expect(repeat, `${ch} repeats across the run`).toBe('repeat-x');
      }
    }
  });
});
