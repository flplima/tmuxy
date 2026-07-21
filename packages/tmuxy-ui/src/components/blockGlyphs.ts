/**
 * Geometric rendering for Unicode Block Elements (U+2580–U+259F).
 *
 * Block art (`█`, `▀`, `▄`, …) is drawn on the assumption that each glyph fills
 * its cell exactly, so stacked rows tile into solid shapes. Font outlines do
 * not honour that: measured in FiraCode Nerd Font at 15px, `█` inks only 19px
 * of a 24px cell, leaving a 5px horizontal band between every row and slicing
 * block art into stripes.
 *
 * The cell height is a grid property, not a font property, so no font-size or
 * line-height choice fixes this in general. xterm.js sidesteps it by drawing
 * these glyphs itself instead of using the font; this module does the same with
 * CSS gradients, which fill the cell box exactly whatever the font does.
 *
 * The character stays in the DOM as text (painted transparent) so selection,
 * copy/paste and the accessibility tree are unaffected.
 */

/** `%C%` is substituted with the resolved foreground colour. */
const C = '%C%';

/** A solid fill covering the whole cell. */
const FULL = `linear-gradient(${C}, ${C})`;

/** Fill `fraction` of the cell measured from `side`. */
function slab(side: 'top' | 'bottom' | 'left' | 'right', fraction: number): string {
  const toward = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side];
  const pct = `${fraction * 100}%`;
  return `linear-gradient(to ${toward}, ${C} ${pct}, transparent ${pct})`;
}

/**
 * Quadrant layers. With `background-size: 50% 50%`, a background-position of
 * 0%/100% lands the layer exactly in the corresponding corner.
 */
const QUAD_POS = {
  ul: '0% 0%',
  ur: '100% 0%',
  ll: '0% 100%',
  lr: '100% 100%',
} as const;
type Quad = keyof typeof QUAD_POS;

function quadrants(...quads: Quad[]): { image: string; size: string; position: string } {
  return {
    image: quads.map(() => FULL).join(', '),
    size: quads.map(() => '50% 50%').join(', '),
    position: quads.map((q) => QUAD_POS[q]).join(', '),
  };
}

/**
 * Shades are a flat wash at reduced alpha rather than a dither pattern.
 * `color-mix` is used (not relative-colour syntax) because the foreground may
 * arrive as a `var(--…)` reference rather than a literal colour.
 */
function shade(percent: number): string {
  const mixed = `color-mix(in srgb, ${C} ${percent}%, transparent)`;
  return `linear-gradient(${mixed}, ${mixed})`;
}

export interface BlockGlyph {
  image: string;
  size?: string;
  position?: string;
}

const simple = (image: string): BlockGlyph => ({ image });

/**
 * Every Block Element that can be drawn as axis-aligned rectangles. The
 * quadrant characters carry explicit size/position; the rest cover the full
 * cell box, so they need neither.
 */
const BLOCK_GLYPHS: Record<string, BlockGlyph> = {
  // Horizontal slabs, growing from the bottom (U+2581–U+2587) then full.
  '▀': simple(slab('top', 0.5)), // ▀ upper half
  '▁': simple(slab('bottom', 0.125)), // ▁
  '▂': simple(slab('bottom', 0.25)), // ▂
  '▃': simple(slab('bottom', 0.375)), // ▃
  '▄': simple(slab('bottom', 0.5)), // ▄ lower half
  '▅': simple(slab('bottom', 0.625)), // ▅
  '▆': simple(slab('bottom', 0.75)), // ▆
  '▇': simple(slab('bottom', 0.875)), // ▇
  '█': simple(FULL), // █ full block
  // Vertical slabs, shrinking from the left (U+2589–U+258F).
  '▉': simple(slab('left', 0.875)), // ▉
  '▊': simple(slab('left', 0.75)), // ▊
  '▋': simple(slab('left', 0.625)), // ▋
  '▌': simple(slab('left', 0.5)), // ▌ left half
  '▍': simple(slab('left', 0.375)), // ▍
  '▎': simple(slab('left', 0.25)), // ▎
  '▏': simple(slab('left', 0.125)), // ▏
  '▐': simple(slab('right', 0.5)), // ▐ right half
  // Shades.
  '░': simple(shade(25)), // ░
  '▒': simple(shade(50)), // ▒
  '▓': simple(shade(75)), // ▓
  // Thin edges.
  '▔': simple(slab('top', 0.125)), // ▔
  '▕': simple(slab('right', 0.125)), // ▕
  // Quadrants.
  '▖': quadrants('ll'), // ▖
  '▗': quadrants('lr'), // ▗
  '▘': quadrants('ul'), // ▘
  '▙': quadrants('ul', 'll', 'lr'), // ▙
  '▚': quadrants('ul', 'lr'), // ▚
  '▛': quadrants('ul', 'ur', 'll'), // ▛
  '▜': quadrants('ul', 'ur', 'lr'), // ▜
  '▝': quadrants('ur'), // ▝
  '▞': quadrants('ur', 'll'), // ▞
  '▟': quadrants('ur', 'lr', 'll'), // ▟
};

/** Is this character one we draw geometrically instead of via the font? */
export function isBlockGlyph(ch: string): boolean {
  return Object.prototype.hasOwnProperty.call(BLOCK_GLYPHS, ch);
}

/**
 * CSS background properties that paint `ch` in `color`, filling the cell box
 * exactly. Returns null for characters the font should draw normally.
 */
export function blockGlyphStyle(
  ch: string,
  color: string,
): {
  backgroundImage: string;
  backgroundSize?: string;
  backgroundPosition?: string;
  backgroundRepeat: string;
} | null {
  const glyph = BLOCK_GLYPHS[ch];
  if (!glyph) return null;
  return {
    backgroundImage: glyph.image.split(C).join(color),
    ...(glyph.size ? { backgroundSize: glyph.size } : {}),
    ...(glyph.position ? { backgroundPosition: glyph.position } : {}),
    backgroundRepeat: 'no-repeat',
  };
}
