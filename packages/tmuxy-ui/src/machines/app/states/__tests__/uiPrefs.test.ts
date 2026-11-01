import { describe, it, expect } from 'vitest';
import { uiPrefsState } from '../uiPrefs';
import { uiPrefsActions } from '../../actions/uiPrefs';
const uiPrefsGuards = {};
import { mountState, sendAndGetContext } from './testHarness';

describe('uiPrefs state', () => {
  it('SET_THEME updates themeName', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards, {
      themeName: 'default',
    });
    const ctx = sendAndGetContext(actor, { type: 'SET_THEME', name: 'dracula' });
    expect(ctx.themeName).toBe('dracula');
  });

  it('SET_THEME_MODE updates themeMode', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards, {
      themeMode: 'dark',
    });
    const ctx = sendAndGetContext(actor, { type: 'SET_THEME_MODE', mode: 'light' });
    expect(ctx.themeMode).toBe('light');
  });

  it('THEME_SETTINGS_RECEIVED updates both name and mode', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
    const ctx = sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'monokai',
      mode: 'dark',
    });
    expect(ctx.themeName).toBe('monokai');
    expect(ctx.themeMode).toBe('dark');
  });

  // Issue #124: a page that never ran main.tsx's startup apply (a story in
  // a browser an earlier story saved a theme in) kept the saved choice and got
  // no stylesheet at all.
  it('THEME_SETTINGS_RECEIVED applies a saved theme, not just the server default', () => {
    localStorage.clear();
    document.getElementById('tmuxy-theme')?.remove();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
    localStorage.setItem('tmuxy-theme-name', 'nord');
    localStorage.setItem('tmuxy-theme-mode', 'light');
    try {
      const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
      const ctx = sendAndGetContext(actor, {
        type: 'THEME_SETTINGS_RECEIVED',
        theme: 'default',
        mode: 'dark',
      });
      expect(ctx.themeName).toBe('nord');
      expect(ctx.themeMode).toBe('light');
      expect(document.getElementById('tmuxy-theme')?.getAttribute('href')).toMatch(
        /themes\/nord\.css$/,
      );
      expect(document.documentElement.classList.contains('theme-light')).toBe(true);
      // The saved choice stays the saved choice.
      expect(localStorage.getItem('tmuxy-theme-name')).toBe('nord');
    } finally {
      localStorage.clear();
    }
  });

  // Config beats menu state: a theme tmuxy.conf pins wins over the one this
  // client last picked, and the menu cannot change it; the saved choice is
  // kept for when the pin goes.
  it('a theme tmuxy.conf pins wins over the saved one and survives a menu change', () => {
    localStorage.clear();
    localStorage.setItem('tmuxy-theme-name', 'dracula');
    localStorage.setItem('tmuxy-theme-mode', 'dark');
    try {
      const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
      let ctx = sendAndGetContext(actor, {
        type: 'THEME_SETTINGS_RECEIVED',
        theme: 'nord',
        mode: 'dark',
        pinned: ['@tmuxy-theme'],
      });
      expect(ctx.themeName).toBe('nord');
      expect(ctx.pinnedOptions).toEqual(['@tmuxy-theme']);
      expect(document.getElementById('tmuxy-theme')?.getAttribute('href')).toMatch(
        /themes\/nord\.css$/,
      );

      ctx = sendAndGetContext(actor, { type: 'SET_THEME', name: 'gruvbox' });
      expect(ctx.themeName).toBe('nord');
      expect(localStorage.getItem('tmuxy-theme-name')).toBe('dracula');

      // The pin goes: the client's own choice is back.
      ctx = sendAndGetContext(actor, {
        type: 'THEME_SETTINGS_RECEIVED',
        theme: 'nord',
        mode: 'dark',
        pinned: [],
      });
      expect(ctx.themeName).toBe('dracula');
    } finally {
      localStorage.clear();
    }
  });

  it('THEME_SETTINGS_RECEIVED applies the appearance as CSS variables', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
    sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: {
        opacity: 0.5,
        activePaneOpacity: 0.8,
        inactivePaneOpacity: 0.4,
        activeTextOpacity: 0.9,
        inactiveTextOpacity: 0.3,
        blur: false,
        animations: true,
      },
    });
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--app-opacity')).toBe('0.5');
    expect(root.getPropertyValue('--active-pane-opacity')).toBe('0.8');
    expect(root.getPropertyValue('--inactive-pane-opacity')).toBe('0.4');
    expect(root.getPropertyValue('--active-text-opacity')).toBe('0.9');
    expect(root.getPropertyValue('--inactive-text-opacity')).toBe('0.3');
  });

  it('THEME_SETTINGS_RECEIVED with transparency off paints the surfaces opaque, and keeps the text dim', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
    const appearance = {
      opacity: 0.5,
      activePaneOpacity: 0.8,
      inactivePaneOpacity: 0.4,
      activeTextOpacity: 0.9,
      inactiveTextOpacity: 0.3,
      blur: true,
      animations: true,
    };
    const root = document.documentElement.style;
    const off = sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: { ...appearance, transparency: false },
    });
    expect(off.transparency).toBe(false);
    expect(root.getPropertyValue('--app-opacity')).toBe('1');
    expect(root.getPropertyValue('--active-pane-opacity')).toBe('1');
    expect(root.getPropertyValue('--inactive-pane-opacity')).toBe('1');
    expect(root.getPropertyValue('--active-text-opacity')).toBe('0.9');
    expect(root.getPropertyValue('--inactive-text-opacity')).toBe('0.3');
    // Back on, the configured opacities return: the switch never rewrote them.
    const on = sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: { ...appearance, transparency: true },
    });
    expect(on.transparency).toBe(true);
    expect(root.getPropertyValue('--app-opacity')).toBe('0.5');
    expect(root.getPropertyValue('--inactive-pane-opacity')).toBe('0.4');
  });

  it('THEME_SETTINGS_RECEIVED carries the config’s animation switch', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
    const appearance = {
      opacity: 0.7,
      activePaneOpacity: 1,
      inactivePaneOpacity: 0.7,
      activeTextOpacity: 1,
      inactiveTextOpacity: 0.7,
      blur: false,
      animations: false,
    };
    const off = sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance,
    });
    expect(off.animationsAllowed).toBe(false);
    // `source-file` re-pushes the settings: turning it back on lands too.
    const on = sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: { ...appearance, animations: true },
    });
    expect(on.animationsAllowed).toBe(true);
    // An adapter without a config (demo, v86) sends no appearance: allowed.
    const none = sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
    });
    expect(none.animationsAllowed).toBe(true);
  });

  it('THEMES_LIST_RECEIVED populates availableThemes', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
    const themes = [
      { name: 'dark', displayName: 'Dark', modes: ['dark'] },
      { name: 'light', displayName: 'Light', modes: ['dark', 'light'] },
    ];
    const ctx = sendAndGetContext(actor, { type: 'THEMES_LIST_RECEIVED', themes });
    expect(ctx.availableThemes).toEqual(themes);
  });

  it('THEME_SETTINGS_RECEIVED declares the config CSS variables, and CSS_CHANGED re-fetches the sheets', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards, {
      themeName: 'nord',
      themeMode: 'dark',
    });
    sendAndGetContext(actor, { type: 'SET_THEME', name: 'nord' });
    sendAndGetContext(actor, {
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'nord',
      mode: 'dark',
      cssVars: { 'term-background': '#101010' },
    });
    const declared = () => document.getElementById('tmuxy-css-vars')?.textContent ?? '';
    expect(declared()).toContain('--term-background: #101010;');

    const href = () => document.getElementById('tmuxy-theme')?.getAttribute('href');
    const before = href();
    expect(before).toContain('/themes/nord.css');
    const ctx = sendAndGetContext(actor, { type: 'CSS_CHANGED' });
    expect(href()).not.toBe(before);
    expect(href()).toContain('/themes/nord.css?v=');
    // The name and the inline variables survive the re-fetch.
    expect(ctx.themeName).toBe('nord');
    expect(declared()).toContain('--term-background: #101010;');
  });

  it('INCREASE_FONT_SIZE bumps baseFontSize', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards, {
      baseFontSize: 14,
    });
    const ctx = sendAndGetContext(actor, { type: 'INCREASE_FONT_SIZE' });
    expect(ctx.baseFontSize).toBe(15);
  });

  it('DECREASE_FONT_SIZE drops baseFontSize', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards, {
      baseFontSize: 14,
    });
    const ctx = sendAndGetContext(actor, { type: 'DECREASE_FONT_SIZE' });
    expect(ctx.baseFontSize).toBe(13);
  });

  it('RESET_FONT_SIZE resets to DEFAULT_FONT_SIZE', async () => {
    const { DEFAULT_FONT_SIZE } = await import('../../../../utils/fontSizeManager');
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards, {
      baseFontSize: 22,
    });
    const ctx = sendAndGetContext(actor, { type: 'RESET_FONT_SIZE' });
    expect(ctx.baseFontSize).toBe(DEFAULT_FONT_SIZE);
  });
});
