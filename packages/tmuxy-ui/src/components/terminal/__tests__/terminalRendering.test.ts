import { describe, it, expect } from 'vitest';
import { renderLineToDOM } from '../terminalRendering';
import { rowEdgeBackground } from '../cellPaint';
import { sanitizeTerminalCell } from '../terminalShared';

/**
 * Inverse video with the default colours swaps the THEME's foreground and
 * background, never a literal white on black: a light theme's reversed text
 * is its dark ink as the ground.
 */
describe('inverse video with default colours', () => {
  it('paints the theme foreground as the ground', () => {
    expect(rowEdgeBackground({ inverse: true })).toBe('var(--term-foreground)');
  });

  it('paints nothing for a plain cell, so the pane background shows', () => {
    expect(rowEdgeBackground({})).toBeUndefined();
  });
});

it('dims only the foreground on a painted background, including reverse video', () => {
  const row = document.createElement('div');
  renderLineToDOM(
    row,
    [
      { c: 'a', s: { bg: 4, dim: true } },
      { c: 'b', s: { fg: 1, bg: 4, dim: true, inverse: true } },
    ],
    null,
  );
  const [plain, reversed] = row.querySelectorAll('span');
  expect(plain.style.opacity).toBe('');
  expect(plain.style.backgroundColor).toBe('var(--term-blue)');
  expect(plain.style.color).toBe('color-mix(in srgb, var(--term-foreground) 50%, transparent)');
  expect(reversed.style.backgroundColor).toBe('var(--term-red)');
  expect(reversed.style.color).toBe('color-mix(in srgb, var(--term-blue) 50%, transparent)');
});

describe('terminal BiDi neutralization and hyperlink destination preview', () => {
  it('strips BiDi override code points from combined cells and replaces standalone BiDi cells', () => {
    expect(sanitizeTerminalCell('a\u202E')).toBe('a');
    expect(sanitizeTerminalCell('x\u2066\u2069')).toBe('x');
    expect(sanitizeTerminalCell('\u202E')).toBe('\uFFFD');
    expect(sanitizeTerminalCell('plain')).toBe('plain');
  });

  it('exposes the sanitized destination URL via title on OSC 8 hyperlinks and strips BiDi overrides in DOM lines', () => {
    const row = document.createElement('div');
    renderLineToDOM(
      row,
      [
        { c: 'o\u202E', s: { url: 'https://attacker.example/login' } },
        { c: 'k', s: { url: 'https://attacker.example/login' } },
        { c: '\u202D' },
      ],
      null,
    );
    const link = row.querySelector('a.terminal-hyperlink') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('ok');
    expect(link?.getAttribute('title')).toBe('https://attacker.example/login');
    expect(row.textContent).toBe('ok\uFFFD');
    expect(row.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });
});
