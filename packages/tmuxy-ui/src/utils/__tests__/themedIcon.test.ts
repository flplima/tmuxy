import { describe, expect, it } from 'vitest';
import {
  filterColours,
  nearestColour,
  parseColour,
  recolourPixels,
  withCurrentColour,
  type Rgb,
  type ThemePalette,
} from '../themedIcon';

const dark: ThemePalette = {
  background: [0x28, 0x2a, 0x36],
  colours: {
    foreground: [0xf8, 0xf8, 0xf2],
    black: [0x21, 0x22, 0x2c],
    red: [0xff, 0x55, 0x55],
    yellow: [0xf1, 0xfa, 0x8c],
    blue: [0xbd, 0x93, 0xf9],
    'bright-black': [0x62, 0x72, 0xa4],
  },
};

describe('image icons in the theme', () => {
  it('moves every visible pixel to the nearest theme colour, and keeps its alpha', () => {
    const colours = filterColours('palette', dark);
    // Claude's orange, a half-transparent edge of it, and a clear pixel.
    const pixels = new Uint8ClampedArray([
      0xd9, 0x77, 0x57, 255, 0xd9, 0x77, 0x57, 128, 9, 9, 9, 0,
    ]);
    recolourPixels(pixels, colours);
    expect([...pixels.slice(0, 4)]).toEqual([0xff, 0x55, 0x55, 255]);
    expect([...pixels.slice(4, 8)]).toEqual([0xff, 0x55, 0x55, 128]);
    expect([...pixels.slice(8)]).toEqual([9, 9, 9, 0]);
  });

  it('leaves out the colours lost against the background', () => {
    const colours = filterColours('palette', dark);
    expect(colours).not.toContainEqual(dark.colours.black);
    // So a black mark comes out in the theme grey that shows.
    expect(nearestColour([0, 0, 0], colours)).toEqual(dark.colours.foreground);
  });

  it("keeps a pixel's hue against a saturated terminal palette rather than going grey", () => {
    const xterm: Rgb[] = [
      [0xe5, 0xe5, 0xe5],
      [0x7f, 0x7f, 0x7f],
      [0xcd, 0x00, 0x00],
      [0x00, 0xcd, 0x00],
      [0xcd, 0xcd, 0x00],
      [0x00, 0x00, 0xee],
      [0x5c, 0x5c, 0xff],
    ];
    // Claude's orange, Google's blue and green.
    expect(nearestColour([0xd9, 0x77, 0x57], xterm)).toEqual([0xcd, 0x00, 0x00]);
    expect(nearestColour([0x42, 0x85, 0xf4], xterm)).toEqual([0x5c, 0x5c, 0xff]);
    expect(nearestColour([0x34, 0xa8, 0x53], xterm)).toEqual([0x00, 0xcd, 0x00]);
    // A grey stays a grey.
    expect(nearestColour([0x90, 0x90, 0x90], xterm)).toEqual([0x7f, 0x7f, 0x7f]);
  });

  it('paints the whole icon in a colour the filter names', () => {
    expect(filterColours('yellow', dark)).toEqual([dark.colours.yellow]);
    const pixels = new Uint8ClampedArray([1, 2, 3, 255, 200, 100, 50, 255]);
    recolourPixels(pixels, filterColours('foreground', dark));
    expect([...pixels]).toEqual([0xf8, 0xf8, 0xf2, 255, 0xf8, 0xf8, 0xf2, 255]);
  });

  it('reads the theme colours as the themes write them', () => {
    expect(parseColour(' #f8f8f2 ')).toEqual([0xf8, 0xf8, 0xf2]);
    expect(parseColour('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parseColour('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseColour('red')).toBeNull();
  });

  it("spells an SVG's currentColor as the foreground", () => {
    const fg: Rgb = [0xf8, 0xf8, 0xf2];
    const svg = '<svg><path fill="currentColor"/></svg>';
    const out = withCurrentColour(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      fg,
    );
    expect(decodeURIComponent(out.slice(out.indexOf(',') + 1))).toBe(
      '<svg><path fill="#f8f8f2"/></svg>',
    );
    const base64 = withCurrentColour(`data:image/svg+xml;base64,${btoa(svg)}`, fg);
    expect(decodeURIComponent(base64)).toContain('#f8f8f2');
    const png = 'data:image/png;base64,AAAA';
    expect(withCurrentColour(png, fg)).toBe(png);
  });
});
