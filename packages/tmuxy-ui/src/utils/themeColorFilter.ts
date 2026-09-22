/**
 * The browser widget's `--color-filter`: recolour whatever a page or an image
 * draws into the current theme's colours.
 *
 * A page brings its own palette — usually black text on white — which sits in
 * a themed terminal like a window from another app. The filter reads each
 * pixel's luminance and maps it onto a ramp of the theme's own tones, KEEPING
 * THE PAGE'S POLARITY: the darkest pixels land on the theme's darkest tone,
 * the lightest on its lightest, the mid tones on the gray between them. Full
 * black in a page therefore comes out as the theme's background, not as its
 * foreground.
 *
 * It used to map ink to foreground and paper to background by role, which
 * inverted every page on a dark theme: a black website came back light. Tone,
 * not role, is what a recolouring has to preserve — a page's own contrast is
 * information (a heading is dark BECAUSE it matters), and flipping it turns
 * emphasis into its opposite.
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

/**
 * The theme colours the ramp runs through. Named by ROLE; the ramp itself is
 * ordered by TONE (see `readThemeRamp`), so which of these is the dark end
 * depends on whether the theme is a dark or a light one.
 */
export const THEME_RAMP_VARS = ['--term-foreground', '--term-bright-black', '--term-background'];

/**
 * Relative luminance (Rec. 709), the same weighting the filter's own colour
 * matrix uses — so the ramp is ordered by exactly the quantity the filter
 * looks each pixel up by.
 */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The ramp's stops in tonal order, darkest first — which is what makes the
 * filter preserve a page's polarity instead of inverting it.
 *
 * Sorted rather than listed in a fixed order because the roles swap between a
 * dark theme and a light one: `--term-background` is the dark end of the first
 * and the light end of the second. One rule, both themes.
 */
export function sortByTone(stops: Rgb[]): Rgb[] {
  return [...stops].sort((a, b) => luminance(a) - luminance(b));
}

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
 * The theme's ramp colours as the document currently resolves them, DARKEST
 * FIRST. A probe element resolves each variable to a concrete colour, whatever
 * form the theme wrote it in (a hex, a name, another variable), and the stops
 * are then sorted by luminance rather than trusted to arrive in tonal order:
 * `--term-background` is the dark end of a dark theme and the light end of a
 * light one, and sorting is what makes one ramp correct for both.
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
  if (!stops.every((stop): stop is Rgb => stop !== null)) return null;
  return sortByTone(stops);
}

/** A filter id safe inside `url(#…)`: pane ids carry a `%`. */
export function themeFilterId(paneId: string): string {
  return `tmuxy-theme-filter-${paneId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
