/**
 * A colour's red, green and blue on 0–255: hex, `rgb()` or `color(srgb …)`.
 * A computed colour comes back in whichever form its value was written in —
 * a `color-mix()` resolves to `color(srgb …)` — so stories compare channels,
 * never the string.
 */
export function channels(colour: string): number[] {
  const hex = colour.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const srgb = colour.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  if (srgb) return srgb.slice(1, 4).map((c) => Math.round(Number(c) * 255));
  return (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((c) => Math.round(Number(c)));
}
