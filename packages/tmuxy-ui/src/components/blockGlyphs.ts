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

/**
 * One cell wide — the tile every glyph is painted into.
 *
 * A style group is one span covering however many cells share a style, so a
 * run of the same glyph (`▌▌▌▌`) is a single box. A background sized in
 * PERCENT is then a percentage of the run: `▌` painted one left half across
 * eight cells instead of eight left halves, and a quadrant stretched over half
 * the run. Sizing the tile in cells and repeating it makes a run of N glyphs
 * N copies of the glyph, which is what the characters say. The fallback keeps
 * component stories rendered outside the app working (see utils/cellMetrics).
 */
const CELL = 'var(--cell-w, 1ch)';

/** A solid fill covering the whole cell. */
const FULL = `linear-gradient(${C}, ${C})`;

/** Fill `fraction` of the cell measured from `side`. */
function slab(side: 'top' | 'bottom' | 'left' | 'right', fraction: number): string {
  const toward = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side];
  const pct = `${fraction * 100}%`;
  return `linear-gradient(to ${toward}, ${C} ${pct}, transparent ${pct})`;
}

/**
 * A quadrant glyph is two half-height rows, each empty, left, right or full —
 * which is every quadrant character (`▚` is left over right; `▙` is left over
 * full). Written as rows rather than as four corners because a row is one
 * layer: the tile is a cell wide and half a cell tall, and the side it fills
 * is the gradient inside it.
 */
type Half = 'none' | 'left' | 'right' | 'full';

const HALF_IMAGE: Record<Exclude<Half, 'none'>, string> = {
  left: `linear-gradient(to right, ${C} 50%, transparent 50%)`,
  right: `linear-gradient(to left, ${C} 50%, transparent 50%)`,
  full: FULL,
};

function halves(top: Half, bottom: Half): Layer[] {
  const layers: Layer[] = [];
  if (top !== 'none') layers.push({ image: HALF_IMAGE[top], height: '50%', edge: 'top' });
  if (bottom !== 'none') layers.push({ image: HALF_IMAGE[bottom], height: '50%', edge: 'bottom' });
  return layers;
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

/**
 * One background layer: an image, the height of its tile within the cell, and
 * which edge the tile sits against. The tile's width is always one cell.
 */
export interface Layer {
  image: string;
  height: string;
  edge: 'top' | 'bottom';
}

/** A glyph that fills the cell's full height, e.g. every slab and shade. */
const simple = (image: string): Layer[] => [{ image, height: '100%', edge: 'top' }];

/**
 * Every Block Element that can be drawn as axis-aligned rectangles. The
 * quadrant characters carry explicit size/position; the rest cover the full
 * cell box, so they need neither.
 */
const BLOCK_GLYPHS: Record<string, Layer[]> = {
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
  // Quadrants, as the top half over the bottom half.
  '▖': halves('none', 'left'), // ▖
  '▗': halves('none', 'right'), // ▗
  '▘': halves('left', 'none'), // ▘
  '▙': halves('left', 'full'), // ▙
  '▚': halves('left', 'right'), // ▚
  '▛': halves('full', 'left'), // ▛
  '▜': halves('full', 'right'), // ▜
  '▝': halves('right', 'none'), // ▝
  '▞': halves('right', 'left'), // ▞
  '▟': halves('right', 'full'), // ▟
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
  backgroundSize: string;
  backgroundPosition: string;
  backgroundRepeat: string;
} | null {
  const layers = BLOCK_GLYPHS[ch];
  if (!layers) return null;
  return {
    backgroundImage: layers.map((l) => l.image.split(C).join(color)).join(', '),
    backgroundSize: layers.map((l) => `${CELL} ${l.height}`).join(', '),
    backgroundPosition: layers.map((l) => `left ${l.edge}`).join(', '),
    // Across the run, not down it: one glyph per cell, one row of them.
    backgroundRepeat: layers.map(() => 'repeat-x').join(', '),
  };
}
