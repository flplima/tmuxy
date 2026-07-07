/**
 * Action implementations for the uiPrefs parallel state.
 *
 * Each action is prefixed `uiPrefs_` to avoid name collisions across states
 * when spread into setup({ actions }).
 *
 * Side effects (applyTheme, saveThemeToStorage, applyFontSize,
 * saveFontSizeToStorage) run imperatively inside enqueueActions before the
 * assigned context update; this matches the original appMachine behavior
 * where DOM/localStorage write happen synchronously with state mutation.
 */

import { assign, enqueueActions, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';
import {
  applyTheme,
  applyThemeMode,
  saveThemeToStorage,
  loadThemeFromStorage,
} from '../../../utils/themeManager';
import {
  applyFontSize,
  saveFontSizeToStorage,
  increaseFontSize,
  decreaseFontSize,
  DEFAULT_FONT_SIZE,
} from '../../../utils/fontSizeManager';
import { isTauri } from '../../../tmux/adapters';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

export const uiPrefsActions = {
  uiPrefs_setAnimationRoot: assign<Ctx, Evt, undefined, Evt, never>(() => ({})),

  uiPrefs_applyTheme: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, context, enqueue }) => {
      if (event.type !== 'SET_THEME') return;
      applyTheme(event.name, context.themeMode);
      saveThemeToStorage(event.name, context.themeMode);
      enqueue(assign({ themeName: event.name }));
      // Only persist to server in Tauri — web clients use localStorage only
      // so multiple users on the same session each keep their own theme.
      if (isTauri()) {
        enqueue(
          sendTo('tmux', {
            type: 'INVOKE' as const,
            cmd: 'set_theme',
            args: { name: event.name },
          }),
        );
      }
    },
  ),

  uiPrefs_applyThemeMode: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, context, enqueue }) => {
    if (event.type !== 'SET_THEME_MODE') return;
    applyThemeMode(event.mode);
    saveThemeToStorage(context.themeName, event.mode);
    enqueue(assign({ themeMode: event.mode }));
    // Only persist to server in Tauri — web clients use localStorage only.
    if (isTauri()) {
      enqueue(
        sendTo('tmux', {
          type: 'INVOKE' as const,
          cmd: 'set_theme_mode',
          args: { mode: event.mode },
        }),
      );
      enqueue(
        sendTo('tmux', {
          type: 'INVOKE' as const,
          cmd: 'set_theme',
          args: { name: context.themeName, mode: event.mode },
        }),
      );
    }
  }),

  uiPrefs_acceptThemeSettings: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ event, enqueue }) => {
    if (event.type !== 'THEME_SETTINGS_RECEIVED') return;
    // localStorage takes precedence — server defaults only apply when
    // the user hasn't chosen a theme yet (e.g. first visit).
    const saved = loadThemeFromStorage();
    if (saved) return;
    applyTheme(event.theme, event.mode);
    saveThemeToStorage(event.theme, event.mode);
    enqueue(assign({ themeName: event.theme, themeMode: event.mode }));
  }),

  uiPrefs_setAvailableThemes: assign<Ctx, Evt, undefined, Evt, never>(({ event }) => {
    if (event.type !== 'THEMES_LIST_RECEIVED') return {};
    return { availableThemes: event.themes };
  }),

  uiPrefs_increaseFontSize: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ context, enqueue }) => {
    const newSize = increaseFontSize(context.baseFontSize);
    applyFontSize(newSize);
    saveFontSizeToStorage(newSize);
    enqueue(assign({ baseFontSize: newSize }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),

  uiPrefs_decreaseFontSize: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ context, enqueue }) => {
    const newSize = decreaseFontSize(context.baseFontSize);
    applyFontSize(newSize);
    saveFontSizeToStorage(newSize);
    enqueue(assign({ baseFontSize: newSize }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),

  uiPrefs_resetFontSize: enqueueActions<
    Ctx,
    Evt,
    undefined,
    Evt,
    never,
    never,
    never,
    never,
    never
  >(({ enqueue }) => {
    applyFontSize(DEFAULT_FONT_SIZE);
    saveFontSizeToStorage(DEFAULT_FONT_SIZE);
    enqueue(assign({ baseFontSize: DEFAULT_FONT_SIZE }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),
};
