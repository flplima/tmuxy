/**
 * The rules every theme face keeps (public/themes/*.css).
 *
 * A theme is only a re-declaration of the token names `styles.css` reads:
 * nothing is drawn differently per theme. So each face declares the same
 * names the default dark face does, adds nothing but tokens `styles.css`
 * declares or helpers of its own (`--fallout-fg`), and picks values that keep
 * the design's rules — status line text and the accent readable at 4.5:1,
 * and on a dark face the chrome a step lighter than the panes.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The tmuxy-ui package. Not `new URL(…, import.meta.url)`: Vite rewrites that into an asset import. */
const UI_DIR = resolvePath(fileURLToPath(import.meta.url), '../../../..');

type Decls = Record<string, string>;

function declsOf(block: string): Decls {
  const out: Decls = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const STYLES = readFileSync(`${UI_DIR}/src/styles.css`, 'utf8');
const ROOT = declsOf(STYLES.match(/:root\s*\{([\s\S]*?)\n\}/)![1]);

interface Face {
  name: string;
  theme: string;
  mode: 'dark' | 'light';
  own: Decls;
  vars: Decls;
}

const THEME_FILES = readdirSync(`${UI_DIR}/public/themes`).filter((f) => f.endsWith('.css'));

function facesOf(file: string): Face[] {
  const css = readFileSync(`${UI_DIR}/public/themes/${file}`, 'utf8');
  const theme = file.replace(/\.css$/, '');
  return (['dark', 'light'] as const).flatMap((mode) => {
    const block = css.match(new RegExp(`:root\\.theme-${mode}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!block) return [];
    const own = declsOf(block[1]);
    return [{ name: `${theme} ${mode}`, theme, mode, own, vars: { ...ROOT, ...own } }];
  });
}

const FACES = THEME_FILES.flatMap(facesOf);
const DEFAULT_DARK = FACES.find((f) => f.name === 'default dark')!;

/** A token's value with every `var()` in it resolved against the face. */
function resolve(vars: Decls, value: string, depth = 0): string {
  if (depth > 20) throw new Error(`var() loop in ${value}`);
  return value.replace(
    /var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
    (_, name: string, fallback?: string) => {
      const next = vars[name] ?? fallback;
      if (next === undefined) throw new Error(`${name} is not declared`);
      return resolve(vars, next, depth + 1);
    },
  );
}

function rgbOf(color: string): [number, number, number] {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex)
    return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
  const triple = color.match(/^(?:rgba?\()?\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (triple) return [Number(triple[1]), Number(triple[2]), Number(triple[3])];
  throw new Error(`not a colour: ${color}`);
}

function colorOf(face: Face, token: string): [number, number, number] {
  return rgbOf(resolve(face.vars, `var(${token})`));
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme faces', () => {
  it('finds every theme with both faces', () => {
    expect(THEME_FILES.length).toBeGreaterThanOrEqual(7);
    expect(FACES).toHaveLength(THEME_FILES.length * 2);
  });

  it.each(FACES.map((f) => [f.name, f] as const))(
    '%s declares the names the default declares, and nothing it may not',
    (_, face) => {
      const missing = Object.keys(DEFAULT_DARK.own).filter((name) => !(name in face.own));
      expect(missing).toEqual([]);
      // Extra names are tokens styles.css already reads, or the theme's own
      // helpers, prefixed with its name (`--fallout-fg`).
      const prefix = `--${face.theme}-`;
      const stray = Object.keys(face.own).filter(
        (name) => !(name in DEFAULT_DARK.own) && !(name in ROOT) && !name.startsWith(prefix),
      );
      expect(stray).toEqual([]);
    },
  );

  it.each(THEME_FILES)('%s only re-declares tokens', (file) => {
    // Every rule is a face's token block; no theme restyles an element.
    const css = readFileSync(`${UI_DIR}/public/themes/${file}`, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const selectors = [...css.matchAll(/([^{}@;]+)\{/g)].map((m) => m[1].trim());
    expect(selectors.every((s) => /^:root\.theme-(dark|light)$/.test(s))).toBe(true);
  });

  it.each(FACES.map((f) => [f.name, f] as const))(
    '%s: the active pane outline and the accent are one colour',
    (_, face) => {
      const accent = colorOf(face, '--theme-accent');
      expect(colorOf(face, '--pane-focus-border')).toEqual(accent);
    },
  );

  it.each(FACES.map((f) => [f.name, f] as const))(
    '%s: the status line and the accent read at 4.5:1',
    (_, face) => {
      const ratios = {
        'status line text on its band': contrast(
          colorOf(face, '--text-dark'),
          colorOf(face, '--tmux-status-bg'),
        ),
        // The inverse chips: the accent on the pane ground.
        'accent on the panes': contrast(
          colorOf(face, '--theme-accent'),
          colorOf(face, '--term-background'),
        ),
        // The active tab: the accent on the chrome.
        'accent on the chrome': contrast(
          colorOf(face, '--theme-accent'),
          colorOf(face, '--window-bg-rgb'),
        ),
      };
      for (const [what, ratio] of Object.entries(ratios)) {
        expect({ what, ok: ratio >= 4.5 }).toEqual({ what, ok: true });
      }
    },
  );

  // The chrome's text is quiet by tier, never by opacity: each tier is a
  // colour that still reads at 4.5:1 on every ground it is drawn on — the
  // chrome (the strip, the tree's tab rows), the panes, the tree's pane rows
  // (--bg-medium), and the keyboard cursor's band in the tree (--bg-highlight).
  it.each(FACES.map((f) => [f.name, f] as const))(
    '%s: every text tier reads at 4.5:1 on the grounds it is drawn on',
    (_, face) => {
      const pairs: Array<[string, string]> = [
        ['--text-primary', '--window-bg-rgb'],
        ['--text-primary', '--bg-medium'],
        ['--text-primary', '--term-background'],
        ['--text-primary', '--bg-dark-alt'],
        ['--text-secondary', '--window-bg-rgb'],
        ['--text-secondary', '--bg-medium'],
        ['--text-dimmed', '--window-bg-rgb'],
        ['--text-dimmed', '--bg-medium'],
        ['--text-dimmed', '--term-background'],
        ['--pane-header-text-inactive', '--window-bg-rgb'],
        ['--theme-accent', '--bg-medium'],
        ['--text-primary', '--bg-highlight'],
        ['--theme-accent', '--bg-highlight'],
      ];
      for (const [fg, bg] of pairs) {
        const what = `${fg} on ${bg}`;
        const ratio = contrast(colorOf(face, fg), colorOf(face, bg));
        expect({ what, ok: ratio >= 4.5 }).toEqual({ what, ok: true });
      }
      // A pane's header: 30% of --border-medium over the pane (`.pane-header`).
      const border = colorOf(face, '--border-medium');
      const pane = colorOf(face, '--term-background');
      const header = border.map((c, i) => Math.round(c * 0.3 + pane[i] * 0.7)) as [
        number,
        number,
        number,
      ];
      for (const fg of [
        '--theme-accent',
        '--pane-header-text-active',
        '--pane-header-text-inactive',
      ]) {
        const what = `${fg} on a pane header`;
        const ratio = contrast(colorOf(face, fg), header);
        expect({ what, ok: ratio >= 4.5 }).toEqual({ what, ok: true });
      }
      // An inactive pane's header: the same 30% over a pane that is itself the
      // pane colour at the shipped --inactive-pane-opacity (0.7) over the window.
      const window = colorOf(face, '--window-bg-rgb');
      // Rounded at each step, as a browser composites one layer onto the next.
      const inactivePane = pane.map((c, i) => Math.round(c * 0.7 + window[i] * 0.3));
      const inactiveHeader = border.map((c, i) => Math.round(c * 0.3 + inactivePane[i] * 0.7)) as [
        number,
        number,
        number,
      ];
      const what = '--pane-header-text-inactive on an inactive pane header';
      const ratio = contrast(colorOf(face, '--pane-header-text-inactive'), inactiveHeader);
      expect({ what, ok: ratio >= 4.5 }).toEqual({ what, ok: true });
    },
  );

  it.each(FACES.filter((f) => f.mode === 'dark').map((f) => [f.name, f] as const))(
    '%s: the chrome is a step lighter than the panes',
    (_, face) => {
      expect(luminance(colorOf(face, '--window-bg-rgb'))).toBeGreaterThan(
        luminance(colorOf(face, '--term-background')),
      );
    },
  );
});
