import { describe, it, expect } from 'vitest';
import { fromCallback } from 'xstate';
import { uiPrefsState } from '../uiPrefs';
import { uiPrefsActions } from '../../actions/uiPrefs';
const uiPrefsGuards = {};

/** What the browser does when a pending theme sheet arrives (jsdom fetches none). */
const loadPendingSheets = () =>
  document.head
    .querySelectorAll('link[data-pending-for]')
    .forEach((link) => link.dispatchEvent(new Event('load')));
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

  // The theme is the session's: tmux holds it, whichever client picked it,
  // and a client's own saved choice is only the cache its next load paints
  // the first frame with — a phone kept the theme it was last opened with
  // while the desktop beside it had moved on. Issue #124 holds too: the theme
  // is applied here, for a page that never ran main.tsx's startup apply.
  it("THEME_SETTINGS_RECEIVED applies the backend's theme over a saved one, and saves it", () => {
    localStorage.clear();
    document.getElementById('tmuxy-theme')?.remove();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
    localStorage.setItem('tmuxy-theme-name', 'nord');
    localStorage.setItem('tmuxy-theme-mode', 'light');
    try {
      const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
      const ctx = sendAndGetContext(actor, {
        type: 'THEME_SETTINGS_RECEIVED',
        theme: 'dracula',
        mode: 'dark',
      });
      expect(ctx.themeName).toBe('dracula');
      expect(ctx.themeMode).toBe('dark');
      expect(document.getElementById('tmuxy-theme')?.getAttribute('href')).toMatch(
        /themes\/dracula\.css$/,
      );
      expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
      expect(localStorage.getItem('tmuxy-theme-name')).toBe('dracula');
      expect(localStorage.getItem('tmuxy-theme-mode')).toBe('dark');
    } finally {
      localStorage.clear();
    }
  });

  // A pick is sent to the backend on every transport (it used to stay in a
  // web client's localStorage), and a pick on another client — tmux's
  // `<theme>:<mode>` moving — has this one read the settings again. The first
  // value is the one the connection's own read already answered.
  it('a theme is picked for the session, and a pick elsewhere is read again', () => {
    const sent: { type: string; cmd?: string; args?: unknown }[] = [];
    const tmux = fromCallback<{ type: string }>(({ receive }) => {
      receive((event) => sent.push(event));
    });
    const actor = mountState(
      uiPrefsState,
      uiPrefsActions,
      uiPrefsGuards,
      {},
      {
        extraActors: { tmux },
      },
    );
    sendAndGetContext(actor, { type: 'SET_THEME', name: 'gruvbox' });
    sendAndGetContext(actor, { type: 'SET_THEME_MODE', mode: 'light' });
    expect(sent).toEqual([
      { type: 'INVOKE', cmd: 'set_theme', args: { name: 'gruvbox' } },
      { type: 'INVOKE', cmd: 'set_theme_mode', args: { mode: 'light' } },
    ]);

    sent.length = 0;
    let ctx = sendAndGetContext(actor, { type: 'THEME_REV_CHANGED', rev: 'gruvbox:light' });
    expect(ctx.themeRev).toBe('gruvbox:light');
    expect(sent).toEqual([]);
    ctx = sendAndGetContext(actor, { type: 'THEME_REV_CHANGED', rev: 'nord:dark' });
    expect(ctx.themeRev).toBe('nord:dark');
    expect(sent).toEqual([{ type: 'FETCH_THEME_SETTINGS' }]);
  });

  // Config beats menu state: a theme tmuxy.conf pins is the one, and the
  // menu cannot change it, on any client.
  it('a theme tmuxy.conf pins is drawn, and a menu pick does not move it', () => {
    localStorage.clear();
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

      ctx = sendAndGetContext(actor, { type: 'SET_THEME', name: 'gruvbox' });
      expect(ctx.themeName).toBe('nord');
      expect(localStorage.getItem('tmuxy-theme-name')).toBe('nord');
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
    loadPendingSheets();

    const href = () => document.getElementById('tmuxy-theme')?.getAttribute('href');
    const before = href();
    expect(before).toContain('/themes/nord.css');
    const ctx = sendAndGetContext(actor, { type: 'CSS_CHANGED' });
    // The saved sheet replaces the old one once it has loaded (themeManager).
    loadPendingSheets();
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
