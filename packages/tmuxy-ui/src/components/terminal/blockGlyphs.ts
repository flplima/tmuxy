/**
 * Unicode Block Elements (U+2580–U+259F) drawn as CSS gradients.
 *
 * Block art assumes each glyph fills its cell so stacked rows tile. Font
 * outlines do not: in FiraCode Nerd Font at 15px `█` inks 19px of a 24px cell,
 * slicing block art into stripes. xterm.js draws these glyphs itself for the
 * same reason. The character stays as transparent text for selection,
 * copy/paste and the accessibility tree.
 */

/** Substituted with the resolved foreground colour. */
const C = '%C%';

/**
 * The tile is one cell wide: a run of the same glyph (`▌▌▌▌`) is one span, and
 * a background sized in percent would be a percentage of the whole run.
 */
const CELL = 'var(--cell-w, 1ch)';

const FULL = `linear-gradient(${C}, ${C})`;

function slab(side: 'top' | 'bottom' | 'left' | 'right', fraction: number): string {
  const toward = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side];
  const pct = `${fraction * 100}%`;
  return `linear-gradient(to ${toward}, ${C} ${pct}, transparent ${pct})`;
}

/** A quadrant glyph as its top and bottom half-rows (`▚` is left over right). */
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
 * `color-mix`, not relative-colour syntax: the foreground may arrive as a
 * `var(--…)` reference rather than a literal colour.
 */
function shade(percent: number): string {
  const mixed = `color-mix(in srgb, ${C} ${percent}%, transparent)`;
  return `linear-gradient(${mixed}, ${mixed})`;
}

export interface Layer {
  image: string;
  height: string;
  edge: 'top' | 'bottom';
}

const simple = (image: string): Layer[] => [{ image, height: '100%', edge: 'top' }];

const BLOCK_GLYPHS: Record<string, Layer[]> = {
  '▀': simple(slab('top', 0.5)),
  '▁': simple(slab('bottom', 0.125)),
  '▂': simple(slab('bottom', 0.25)),
  '▃': simple(slab('bottom', 0.375)),
  '▄': simple(slab('bottom', 0.5)),
  '▅': simple(slab('bottom', 0.625)),
  '▆': simple(slab('bottom', 0.75)),
  '▇': simple(slab('bottom', 0.875)),
  '█': simple(FULL),
  '▉': simple(slab('left', 0.875)),
  '▊': simple(slab('left', 0.75)),
  '▋': simple(slab('left', 0.625)),
  '▌': simple(slab('left', 0.5)),
  '▍': simple(slab('left', 0.375)),
  '▎': simple(slab('left', 0.25)),
  '▏': simple(slab('left', 0.125)),
  '▐': simple(slab('right', 0.5)),
  '░': simple(shade(25)),
  '▒': simple(shade(50)),
  '▓': simple(shade(75)),
  '▔': simple(slab('top', 0.125)),
  '▕': simple(slab('right', 0.125)),
  '▖': halves('none', 'left'),
  '▗': halves('none', 'right'),
  '▘': halves('left', 'none'),
  '▙': halves('left', 'full'),
  '▚': halves('left', 'right'),
  '▛': halves('full', 'left'),
  '▜': halves('full', 'right'),
  '▝': halves('right', 'none'),
  '▞': halves('right', 'left'),
  '▟': halves('right', 'full'),
};

export function isBlockGlyph(ch: string): boolean {
  return Object.prototype.hasOwnProperty.call(BLOCK_GLYPHS, ch);
}

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
    backgroundRepeat: layers.map(() => 'repeat-x').join(', '),
  };
}
