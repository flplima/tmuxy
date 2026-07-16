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
