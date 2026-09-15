/**
 * The browser widget's `--color-filter`: recolour whatever a page or an image
 * draws into the current theme's colours.
 *
 * A page brings its own palette — usually black text on white — which sits in
 * a themed terminal like a window from another app. The filter reads each
 * pixel's luminance and maps it onto a ramp of theme colours: dark ink to the
 * theme's foreground, mid tones to its gray, light paper to its background. On
 * a dark theme that turns a white page dark with light text; on a light theme
 * the page keeps its polarity and takes the theme's tones.
 *
 * It is an SVG filter referenced from CSS, because that is the one kind of
 * filter a browser applies to a cross-origin frame's pixels as well as to an
 * image. The ramp is read from the live theme, so it follows a theme switch.
 */

/** An sRGB colour with 0–255 channels. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The theme colours the ramp runs through, from dark ink to light paper. */
export const THEME_RAMP_VARS = ['--term-foreground', '--term-bright-black', '--term-background'];

/**
 * `feFuncR/G/B` table values for a ramp: one stop per colour, each channel
 * scaled to 0–1. Luminance 0 lands on the first stop, 1 on the last, and the
 * filter interpolates linearly in between.
 */
export function rampTables(stops: Rgb[]): { r: string; g: string; b: string } {
  const channel = (key: keyof Rgb) =>
    stops.map((stop) => (stop[key] / 255).toFixed(4).replace(/\.?0+$/, '') || '0').join(' ');
  return { r: channel('r'), g: channel('g'), b: channel('b') };
}

/** Parse a computed `rgb()` / `rgba()` colour. */
export function parseRgb(value: string): Rgb | null {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/**
 * The theme's ramp colours as the document currently resolves them. A probe
 * element resolves each variable to a concrete colour, whatever form the theme
 * wrote it in (a hex, a name, another variable).
 */
export function readThemeRamp(): Rgb[] | null {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const stops = THEME_RAMP_VARS.map((name) => {
    probe.style.color = `var(${name})`;
    return parseRgb(getComputedStyle(probe).color);
  });
  probe.remove();
  return stops.every((stop): stop is Rgb => stop !== null) ? stops : null;
}

/** A filter id safe inside `url(#…)`: pane ids carry a `%`. */
export function themeFilterId(paneId: string): string {
  return `tmuxy-theme-filter-${paneId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
