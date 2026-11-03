import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyCssVars,
  applyTheme,
  applyThemeMode,
  parseThemeMode,
  reloadThemeCss,
  resolveThemeMode,
} from '../themeManager';

const links = () =>
  [...document.head.querySelectorAll('link[rel="stylesheet"]')].map((l) => ({
    id: l.id,
    href: l.getAttribute('href'),
  }));

/** What the browser does when a pending stylesheet arrives (jsdom fetches none). */
const loadPending = () =>
  document.head
    .querySelectorAll('link[data-pending-for]')
    .forEach((link) => link.dispatchEvent(new Event('load')));

describe('themeManager', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('style');
  });

  it('loads the theme, the config variables and custom.css in that order, and re-fetches on a css-changed push', () => {
    applyTheme('nord', 'dark');
    expect(links()).toEqual([
      { id: 'tmuxy-theme', href: '/themes/nord.css' },
      { id: 'tmuxy-custom-css', href: '/custom.css' },
    ]);
    // The cascade order is the precedence: theme < config variables < custom.css.
    expect([...document.head.children].map((el) => el.id)).toEqual([
      'tmuxy-theme',
      'tmuxy-css-vars',
      'tmuxy-custom-css',
    ]);

    // The href has to change, or the browser answers from its cache and the
    // save never shows. The theme stays the one the user picked.
    reloadThemeCss();
    loadPending();
    expect(links()).toEqual([
      { id: 'tmuxy-theme', href: '/themes/nord.css?v=1' },
      { id: 'tmuxy-custom-css', href: '/custom.css?v=1' },
    ]);

    applyTheme('gruvbox', 'dark');
    loadPending();
    expect(links()[0].href).toBe('/themes/gruvbox.css?v=1');
    expect(links()).toHaveLength(2);
  });

  // Re-pointing the one link dropped the old sheet before the new one had
  // arrived: for the length of the fetch the page was on styles.css's
  // defaults, the status line green whatever either theme said.
  it('keeps the old theme on screen until the new one has loaded, and keeps it when the new one fails', () => {
    // The cache-busting `?v=` an earlier test's reload left is not this test's.
    const sheets = () => links().map((l) => ({ ...l, href: l.href?.replace(/\?v=\d+$/, '') }));
    applyTheme('nord', 'dark');
    applyTheme('gruvbox', 'dark');
    expect(sheets().map((l) => l.href)).toEqual([
      '/themes/nord.css',
      '/themes/gruvbox.css',
      '/custom.css',
    ]);
    expect(sheets()[0].id).toBe('tmuxy-theme');

    // A quicker second pick supersedes the switch still loading.
    applyTheme('dracula', 'dark');
    expect(sheets().map((l) => l.href)).toEqual([
      '/themes/nord.css',
      '/themes/dracula.css',
      '/custom.css',
    ]);
    loadPending();
    expect(sheets()).toEqual([
      { id: 'tmuxy-theme', href: '/themes/dracula.css' },
      { id: 'tmuxy-custom-css', href: '/custom.css' },
    ]);

    applyTheme('missing', 'dark');
    document.head.querySelector('link[data-pending-for]')?.dispatchEvent(new Event('error'));
    expect(sheets()[0]).toEqual({ id: 'tmuxy-theme', href: '/themes/dracula.css' });
    expect(sheets()).toHaveLength(2);
  });

  it("tints the browser's own bars with the theme's window colour", () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#000000';
    document.head.appendChild(meta);
    document.documentElement.style.setProperty('--window-bg-rgb', '40, 42, 54');
    applyThemeMode('dark');
    expect(meta.content).toBe('rgb(40, 42, 54)');
  });

  it('declares the config variables with the themes own selectors and drops the ones a later push lost', () => {
    const rule = () => document.getElementById('tmuxy-css-vars')?.textContent ?? '';
    applyCssVars({ 'term-background': '#101010', 'accent-blue': 'red' });
    expect(rule()).toBe(
      ':root.theme-dark, :root.theme-light {\n  --term-background: #101010;\n  --accent-blue: red;\n}\n',
    );

    applyCssVars({ 'term-background': '#202020' });
    expect(rule()).toContain('--term-background: #202020;');
    expect(rule()).not.toContain('accent-blue');
    applyCssVars({});
    expect(rule()).toBe('');
  });

  it('auto resolves to the OS scheme and the class on <html> is the resolved one', () => {
    expect(parseThemeMode('auto')).toBe('auto');
    expect(parseThemeMode('light')).toBe('light');
    expect(parseThemeMode('anything else')).toBe('dark');
    // jsdom has no matchMedia: the OS scheme is unknown, and dark is the answer.
    expect(resolveThemeMode('auto')).toBe('dark');
    applyThemeMode('auto');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    applyThemeMode('light');
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    expect(document.documentElement.classList.contains('theme-dark')).toBe(false);
  });
});
