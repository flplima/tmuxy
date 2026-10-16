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
    expect(links()).toEqual([
      { id: 'tmuxy-theme', href: '/themes/nord.css?v=1' },
      { id: 'tmuxy-custom-css', href: '/custom.css?v=1' },
    ]);

    applyTheme('gruvbox', 'dark');
    expect(links()[0].href).toBe('/themes/gruvbox.css?v=1');
    expect(links()).toHaveLength(2);
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
