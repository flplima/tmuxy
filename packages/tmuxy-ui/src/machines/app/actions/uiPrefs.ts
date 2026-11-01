/**
 * Action implementations for the uiPrefs state slice.
 *
 * Each action is prefixed `uiPrefs_` to avoid name collisions across states
 * when spread into setup({ actions }).
 *
 * Side effects (applyTheme, saveThemeToStorage, applyFontSize,
 * saveFontSizeToStorage) run imperatively inside enqueueActions before the
 * assigned context update; this matches the original appMachine behavior
 * where DOM/localStorage write happen synchronously with state mutation.
 */

import { assign, sendTo } from 'xstate';
import { act, assignCtx } from '../actionTypes';
import {
  applyTheme,
  applyThemeMode,
  applyCssVars,
  reloadThemeCss,
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
import { isTauri } from '../../../utils/platform';
import { applyAppearance } from '../../../utils/appearanceManager';
import { DEFAULT_SIZE_POLICY, sameSizePolicy } from '../../../utils/gridFit';
import { PINNABLE } from '../../../domain/pins';

export const uiPrefsActions = {
  uiPrefs_applyTheme: act(({ event, context, enqueue }) => {
    if (event.type !== 'SET_THEME') return;
    // tmuxy.conf pins it: the config's theme stays, whatever asked.
    if (context.pinnedOptions.includes(PINNABLE.theme)) return;
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
  }),

  uiPrefs_applyThemeMode: act(({ event, context, enqueue }) => {
    if (event.type !== 'SET_THEME_MODE') return;
    if (context.pinnedOptions.includes(PINNABLE.themeMode)) return;
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

  uiPrefs_acceptThemeSettings: act(({ context, event, enqueue }) => {
    if (event.type !== 'THEME_SETTINGS_RECEIVED') return;
    const sizePolicy = event.appearance?.size ?? DEFAULT_SIZE_POLICY;
    if (!sameSizePolicy(sizePolicy, context.sizePolicy)) {
      enqueue(assign({ sizePolicy }));
      // The size this client asks for and the cell its grid is drawn in both
      // follow the policy.
      enqueue(sendTo('size', { type: 'RESEND_SIZE' as const }));
      enqueue.raise({ type: 'REFIT_GRID' as const });
    }
    // The appearance and the CSS variables have no client-side setting: the
    // config is their only source, so they always apply (and re-apply after
    // a source-file).
    if (event.appearance) applyAppearance(event.appearance);
    if (event.cssVars) applyCssVars(event.cssVars);
    enqueue(
      assign({
        animationsAllowed: event.appearance?.animations ?? true,
        cursorBlink: event.appearance?.cursorBlink ?? true,
        sendAsk: event.appearance?.sendAsk ?? true,
        transparency: event.appearance?.transparency ?? true,
        tabOverviewCols: event.appearance?.tabOverviewCols ?? 3,
        gestureFlags: {
          swipeTabs: event.appearance?.gestureSwipeTabs ?? true,
          pinchZoom: event.appearance?.gesturePinchZoom ?? true,
          pinchOverview: event.appearance?.gesturePinchOverview ?? true,
        },
        nativeMenus: event.appearance?.nativeMenus ?? true,
        pinnedOptions: event.pinned ?? [],
      }),
    );
    // localStorage takes precedence — server defaults only apply when
    // the user hasn't chosen a theme yet (e.g. first visit) — except over a
    // theme or mode tmuxy.conf pins: config beats menu state, on every client.
    // Either way the theme is applied HERE: a page that never ran main.tsx's
    // startup apply (a story) would otherwise keep a saved choice and no
    // stylesheet.
    const pinned = event.pinned ?? [];
    const saved = loadThemeFromStorage();
    const theme = pinned.includes(PINNABLE.theme) ? event.theme : (saved?.theme ?? event.theme);
    const mode = pinned.includes(PINNABLE.themeMode) ? event.mode : (saved?.mode ?? event.mode);
    applyTheme(theme, mode);
    if (!saved) saveThemeToStorage(theme, mode);
    enqueue(assign({ themeName: theme, themeMode: mode }));
  }),

  // The blinking cursor is one setting for the machine, not one per client:
  // it lives in the tmux options the config seeds, so the flip goes to the
  // backend on every transport and comes back through THEME_SETTINGS_RECEIVED.
  uiPrefs_toggleCursorBlink: act(({ event, context, enqueue }) => {
    if (event.type !== 'TOGGLE_CURSOR_BLINK') return;
    if (context.pinnedOptions.includes(PINNABLE.cursorBlink)) return;
    const enabled = !context.cursorBlink;
    enqueue(assign({ cursorBlink: enabled }));
    enqueue(
      sendTo('tmux', {
        type: 'INVOKE' as const,
        cmd: 'set_cursor_blink',
        args: { enabled },
      }),
    );
  }),

  uiPrefs_toggleSendAsk: act(({ event, context, enqueue }) => {
    if (event.type !== 'TOGGLE_SEND_ASK') return;
    if (context.pinnedOptions.includes(PINNABLE.sendAsk)) return;
    const enabled = !context.sendAsk;
    enqueue(assign({ sendAsk: enabled }));
    enqueue(
      sendTo('tmux', {
        type: 'INVOKE' as const,
        cmd: 'set_send_ask',
        args: { enabled },
      }),
    );
  }),

  // The desktop app answers with fresh theme settings, which repaint the
  // surfaces (applyAppearance) as it puts every window's blur on or off.
  uiPrefs_toggleTransparency: act(({ event, context, enqueue }) => {
    if (event.type !== 'TOGGLE_TRANSPARENCY') return;
    if (context.pinnedOptions.includes(PINNABLE.transparency)) return;
    const enabled = !context.transparency;
    enqueue(assign({ transparency: enabled }));
    enqueue(
      sendTo('tmux', {
        type: 'INVOKE' as const,
        cmd: 'set_transparency',
        args: { enabled },
      }),
    );
  }),

  uiPrefs_setAvailableThemes: assignCtx(({ event }) => {
    if (event.type !== 'THEMES_LIST_RECEIVED') return {};
    return { availableThemes: event.themes };
  }),

  // A stylesheet under the config dir was saved: fetch the CSS again, and the
  // list, since the save may have been a theme added or removed.
  uiPrefs_reloadCss: act(({ enqueue }) => {
    reloadThemeCss();
    enqueue(sendTo('tmux', { type: 'FETCH_THEMES_LIST' as const }));
  }),

  // --- Local action tracing (docs/TRACING.md) -----------------------------
  // Each mutation asks the backend and then re-reads it, rather than assuming
  // the request took: a kill switch can refuse an enable, and the level is
  // normalised server-side, so the menu must render the backend's answer.

  uiPrefs_fetchTraceSettings: act(({ enqueue }) => {
    enqueue(sendTo('tmux', { type: 'FETCH_TRACE_SETTINGS' as const }));
  }),

  uiPrefs_acceptTraceSettings: assignCtx(({ event }) => {
    if (event.type !== 'TRACE_SETTINGS_RECEIVED') return {};
    return { traceSettings: event.settings };
  }),

  uiPrefs_setTraceEnabled: act(({ event, enqueue }) => {
    if (event.type !== 'SET_TRACE_ENABLED') return;
    enqueue(sendTo('tmux', { type: 'SET_TRACE_ENABLED' as const, enabled: event.enabled }));
  }),

  uiPrefs_setTraceLevel: act(({ event, enqueue }) => {
    if (event.type !== 'SET_TRACE_LEVEL') return;
    enqueue(sendTo('tmux', { type: 'SET_TRACE_LEVEL' as const, level: event.level }));
  }),

  uiPrefs_openTraceFile: act(({ enqueue }) => {
    enqueue(sendTo('tmux', { type: 'OPEN_TRACE_FILE' as const }));
  }),

  uiPrefs_increaseFontSize: act(({ context, enqueue }) => {
    const newSize = increaseFontSize(context.baseFontSize);
    applyFontSize(newSize);
    saveFontSizeToStorage(newSize);
    enqueue(assign({ baseFontSize: newSize }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),

  uiPrefs_decreaseFontSize: act(({ context, enqueue }) => {
    const newSize = decreaseFontSize(context.baseFontSize);
    applyFontSize(newSize);
    saveFontSizeToStorage(newSize);
    enqueue(assign({ baseFontSize: newSize }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),

  uiPrefs_resetFontSize: act(({ enqueue }) => {
    applyFontSize(DEFAULT_FONT_SIZE);
    saveFontSizeToStorage(DEFAULT_FONT_SIZE);
    enqueue(assign({ baseFontSize: DEFAULT_FONT_SIZE }));
    enqueue(sendTo('size', { type: 'REMEASURE' as const }));
  }),
};
