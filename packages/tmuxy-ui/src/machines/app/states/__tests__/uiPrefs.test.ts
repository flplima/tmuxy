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
      },
    });
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--app-opacity')).toBe('0.5');
    expect(root.getPropertyValue('--active-pane-opacity')).toBe('0.8');
    expect(root.getPropertyValue('--inactive-pane-opacity')).toBe('0.4');
    expect(root.getPropertyValue('--active-text-opacity')).toBe('0.9');
    expect(root.getPropertyValue('--inactive-text-opacity')).toBe('0.3');
  });

  it('THEMES_LIST_RECEIVED populates availableThemes', () => {
    const actor = mountState(uiPrefsState, uiPrefsActions, uiPrefsGuards);
    const themes = [
      { name: 'dark', displayName: 'Dark' },
      { name: 'light', displayName: 'Light' },
    ];
    const ctx = sendAndGetContext(actor, { type: 'THEMES_LIST_RECEIVED', themes });
    expect(ctx.availableThemes).toEqual(themes);
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
