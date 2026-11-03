/**
 * Image process icons drawn in the theme's own colours (`@tmuxy-icon-filter`):
 * `palette` moves every pixel to the nearest terminal colour, so a logo keeps
 * its shape and its colour scheme but speaks the theme's; a colour's name
 * (`foreground`, `red`, `bright-blue`…) paints the whole icon in it; `none`
 * leaves the image as it is.
 *
 * The recolouring is done once per image, filter and palette, on a canvas,
 * and the result cached as a PNG `data:` URL. The palette is read from the
 * theme's `--term-*` variables, so a theme switch (themeManager calls
 * `paletteChanged`) redraws every icon in the new one.
 *
 * An SVG's `currentColor` is the theme's foreground: a one-colour mark (the
 * built-in Codex icon) reads as text does, rather than as the black an image
 * defaults to — which the palette would keep black, on a dark theme unseen.
 */

export type Rgb = readonly [number, number, number];

/** The terminal colours a filter may name, as the themes call them. */
export const THEME_COLOURS = [
  'foreground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
] as const;

/**
 * How far a palette colour must be from the background to be used: one the
 * eye cannot tell from it would make those pixels vanish.
 */
const MIN_BACKGROUND_DISTANCE = 90;

/** Perceptual distance between two colours ("redmean"). */
export function colourDistance(a: Rgb, b: Rgb): number {
  const mean = (a[0] + b[0]) / 2;
  const [dr, dg, db] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return Math.sqrt((2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db);
}

/** A colour in OKLab: perceived lightness, and the two opponent axes. */
function oklab([r, g, b]: Rgb): readonly [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Below this OKLab chroma a colour reads as grey. */
const NEUTRAL_CHROMA = 0.05;

interface Lch {
  rgb: Rgb;
  l: number;
  c: number;
  h: number;
}

function lch(rgb: Rgb): Lch {
  const [l, a, b] = oklab(rgb);
  return { rgb, l, c: Math.hypot(a, b), h: Math.atan2(b, a) };
}

/**
 * The colour of `palette` nearest to `rgb` as the eye groups them: a
 * coloured pixel goes to the theme colour of the nearest hue (then
 * lightness), a grey one to the theme grey of the nearest lightness. A plain
 * distance sent an orange mark to a mid grey, not to the theme's red: a
 * terminal palette's colours are saturated, and grey sits between them all.
 */
export function nearestColour(rgb: Rgb, palette: readonly Rgb[]): Rgb {
  const pixel = lch(rgb);
  const all = palette.map(lch);
  const coloured = pixel.c >= NEUTRAL_CHROMA;
  const kind = all.filter((p) => p.c >= NEUTRAL_CHROMA === coloured);
  const candidates = kind.length > 0 ? kind : all;
  let best = candidates[0];
  let bestCost = Infinity;
  for (const p of candidates) {
    let dh = Math.abs(pixel.h - p.h);
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    const cost = (coloured ? 4 * (dh / Math.PI) ** 2 : 0) + (pixel.l - p.l) ** 2;
    if (cost < bestCost) {
      best = p;
      bestCost = cost;
    }
  }
  return best.rgb;
}

/**
 * Recolour RGBA pixels in place: each visible pixel to the nearest of
 * `palette`, or to `palette[0]` when there is only one. Alpha is kept, so
 * the edges stay smooth.
 */
export function recolourPixels(data: Uint8ClampedArray, palette: readonly Rgb[]): void {
  if (palette.length === 0) return;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [r, g, b] =
      palette.length === 1
        ? palette[0]
        : nearestColour([data[i], data[i + 1], data[i + 2]], palette);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** The theme's terminal colours as the page has them now. */
export interface ThemePalette {
  background: Rgb | null;
  colours: Partial<Record<(typeof THEME_COLOURS)[number], Rgb>>;
}

/**
 * The colours `filter` paints in: one for a colour's name, the theme's
 * terminal colours less those lost against its background for `palette`.
 */
export function filterColours(filter: string, theme: ThemePalette): Rgb[] {
  const named = theme.colours[filter as (typeof THEME_COLOURS)[number]];
  if (named) return [named];
  const all = THEME_COLOURS.map((name) => theme.colours[name]).filter((c): c is Rgb => !!c);
  const { background } = theme;
  if (!background) return all;
  const visible = all.filter((c) => colourDistance(c, background) >= MIN_BACKGROUND_DISTANCE);
  return visible.length > 0 ? visible : all;
}

/** `#rgb`, `#rrggbb` or `rgb(r, g, b)` as an `Rgb`. */
export function parseColour(value: string): Rgb | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function readPalette(): ThemePalette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => parseColour(style.getPropertyValue(`--term-${name}`));
  const colours: ThemePalette['colours'] = {};
  for (const name of THEME_COLOURS) {
    const colour = read(name);
    if (colour) colours[name] = colour;
  }
  return { background: read('background'), colours };
}

const hex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/** An SVG `data:` URL with `currentColor` spelled out; any other URL as it is. */
export function withCurrentColour(src: string, colour: Rgb | undefined): string {
  if (!colour || !src.startsWith('data:image/svg+xml')) return src;
  const comma = src.indexOf(',');
  const head = src.slice(0, comma);
  const body = src.slice(comma + 1);
  const svg = head.endsWith(';base64')
    ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))
    : decodeURIComponent(body);
  if (!svg.includes('currentColor')) return src;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.split('currentColor').join(hex(colour)))}`;
}

/** Side of the square an icon is drawn on: text size, at the screen's density. */
const ICON_CSS_PX = 16;

async function draw(src: string, colours: readonly Rgb[]): Promise<string | null> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const side = Math.ceil(ICON_CSS_PX * Math.min(window.devicePixelRatio || 1, 3));
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const width = image.naturalWidth || side;
  const height = image.naturalHeight || side;
  const scale = Math.min(side / width, side / height);
  const [w, h] = [width * scale, height * scale];
  context.drawImage(image, (side - w) / 2, (side - h) / 2, w, h);
  const pixels = context.getImageData(0, 0, side, side);
  recolourPixels(pixels.data, colours);
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

const drawn = new Map<string, string>();
const drawing = new Map<string, Promise<string>>();

let version = 0;
const listeners = new Set<() => void>();

/** The theme's colours may have changed: icons are drawn again. */
export function paletteChanged(): void {
  version += 1;
  drawn.clear();
  drawing.clear();
  for (const listener of listeners) listener();
}

export function subscribePalette(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const paletteVersion = (): number => version;

function key(src: string, filter: string): string {
  return `${version}\u0000${filter}\u0000${src}`;
}

/** The icon as drawn already, if it has been: `src` itself for `none`. */
export function themedIconNow(src: string, filter: string): string | null {
  return filter === 'none' ? src : (drawn.get(key(src, filter)) ?? null);
}

/**
 * `src` in the theme's colours, by `filter`. Where the page cannot draw it
 * (no canvas, an image that does not decode), the image as it is.
 */
export function themedIcon(src: string, filter: string): Promise<string> {
  const now = themedIconNow(src, filter);
  if (now) return Promise.resolve(now);
  const k = key(src, filter);
  let pending = drawing.get(k);
  if (!pending) {
    const theme = readPalette();
    const colours = filterColours(filter, theme);
    pending = draw(withCurrentColour(src, theme.colours.foreground), colours)
      .catch(() => null)
      .then((url) => {
        const result = url ?? src;
        if (drawing.get(k) === pending) drawn.set(k, result);
        return result;
      });
    drawing.set(k, pending);
  }
  return pending;
}
