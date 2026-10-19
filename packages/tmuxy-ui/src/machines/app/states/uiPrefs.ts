/**
 * uiPrefs state — the `on` slice for theme, font size, animations, and the
 * local action-trace switch (docs/TRACING.md).
 *
 * Owns context fields: themeName, themeMode, availableThemes, baseFontSize,
 * enableAnimations, animationsAllowed, cursorBlink, sendAsk, tabOverviewCols, gestureFlags,
 * traceSettings.
 *
 * Action implementations live in ../actions/uiPrefs.ts.
 *
 * All events here are global (work in any top-level state): uiPrefsState.on
 * is spread into the machine's root on:.
 */

import { notReadOnly } from '../readOnlyGuard';

export const uiPrefsState = {
  on: {
    SET_THEME: { actions: 'uiPrefs_applyTheme' },
    SET_THEME_MODE: { actions: 'uiPrefs_applyThemeMode' },
    THEME_SETTINGS_RECEIVED: { actions: 'uiPrefs_acceptThemeSettings' },
    TOGGLE_CURSOR_BLINK: { guard: notReadOnly, actions: 'uiPrefs_toggleCursorBlink' },
    TOGGLE_SEND_ASK: { guard: notReadOnly, actions: 'uiPrefs_toggleSendAsk' },
    THEMES_LIST_RECEIVED: { actions: 'uiPrefs_setAvailableThemes' },
    CSS_CHANGED: { actions: 'uiPrefs_reloadCss' },
    INCREASE_FONT_SIZE: { actions: 'uiPrefs_increaseFontSize' },
    DECREASE_FONT_SIZE: { actions: 'uiPrefs_decreaseFontSize' },
    RESET_FONT_SIZE: { actions: 'uiPrefs_resetFontSize' },
    FETCH_TRACE_SETTINGS: { actions: 'uiPrefs_fetchTraceSettings' },
    TRACE_SETTINGS_RECEIVED: { actions: 'uiPrefs_acceptTraceSettings' },
    SET_TRACE_ENABLED: { guard: notReadOnly, actions: 'uiPrefs_setTraceEnabled' },
    SET_TRACE_LEVEL: { guard: notReadOnly, actions: 'uiPrefs_setTraceLevel' },
    OPEN_TRACE_FILE: { actions: 'uiPrefs_openTraceFile' },
  },
} as const;
