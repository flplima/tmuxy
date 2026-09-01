/**
 * uiPrefs state — parallel state for theme, font size, animations, and the
 * local action-trace switch (docs/TELEMETRY.md).
 *
 * Owns context fields: themeName, themeMode, availableThemes, baseFontSize,
 * enableAnimations, traceSettings.
 *
 * Action implementations live in ../actions/uiPrefs.ts.
 *
 * All events here are intentionally global (work in any top-level state).
 * The current appMachine still has flat top-level on:; for now we spread
 * uiPrefsState.on into the machine's root on:. When the full parallel
 * conversion lands, this state's on: will become its dedicated region's on:.
 */

export const uiPrefsState = {
  on: {
    SET_THEME: { actions: 'uiPrefs_applyTheme' },
    SET_THEME_MODE: { actions: 'uiPrefs_applyThemeMode' },
    THEME_SETTINGS_RECEIVED: { actions: 'uiPrefs_acceptThemeSettings' },
    THEMES_LIST_RECEIVED: { actions: 'uiPrefs_setAvailableThemes' },
    INCREASE_FONT_SIZE: { actions: 'uiPrefs_increaseFontSize' },
    DECREASE_FONT_SIZE: { actions: 'uiPrefs_decreaseFontSize' },
    RESET_FONT_SIZE: { actions: 'uiPrefs_resetFontSize' },
    FETCH_TRACE_SETTINGS: { actions: 'uiPrefs_fetchTraceSettings' },
    TRACE_SETTINGS_RECEIVED: { actions: 'uiPrefs_acceptTraceSettings' },
    SET_TRACE_ENABLED: { actions: 'uiPrefs_setTraceEnabled' },
    SET_TRACE_LEVEL: { actions: 'uiPrefs_setTraceLevel' },
    OPEN_TRACE_FILE: { actions: 'uiPrefs_openTraceFile' },
  },
} as const;
