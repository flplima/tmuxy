/**
 * uiPrefs state — parallel state for theme, font size, animations.
 *
 * Owns context fields: themeName, themeMode, availableThemes, baseFontSize,
 * enableAnimations, suppressLayoutTransition.
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
    SET_ANIMATION_ROOT: { actions: 'uiPrefs_setAnimationRoot' },
    SET_THEME: { actions: 'uiPrefs_applyTheme' },
    SET_THEME_MODE: { actions: 'uiPrefs_applyThemeMode' },
    THEME_SETTINGS_RECEIVED: { actions: 'uiPrefs_acceptThemeSettings' },
    THEMES_LIST_RECEIVED: { actions: 'uiPrefs_setAvailableThemes' },
    INCREASE_FONT_SIZE: { actions: 'uiPrefs_increaseFontSize' },
    DECREASE_FONT_SIZE: { actions: 'uiPrefs_decreaseFontSize' },
    RESET_FONT_SIZE: { actions: 'uiPrefs_resetFontSize' },
  },
} as const;
