/**
 * What this client remembers between visits, in localStorage: the theme and
 * mode picked from the menu and the font size — every key, its default, and
 * the one guarded read and write.
 */

import { parseThemeMode, type ThemeMode } from '../domain/wireSettings';
import { DEFAULT_FONT_SIZE, isFontSize } from './fontSizeManager';

const KEYS = {
  themeName: 'tmuxy-theme-name',
  themeMode: 'tmuxy-theme-mode',
  fontSize: 'tmuxy-font-size',
} as const;

type PrefKey = (typeof KEYS)[keyof typeof KEYS];

// localStorage throws where it is unavailable (private browsing, a sandboxed
// frame): a preference that cannot be read is its default, and one that
// cannot be written is simply not remembered.
function read(key: PrefKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: PrefKey, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

/** The theme a client starts with before it has chosen one. */
export const DEFAULT_THEME: { readonly theme: string; readonly mode: ThemeMode } = {
  theme: 'default',
  mode: 'dark',
};

/** The saved theme and mode; the defaults when no theme was saved. */
export function loadThemePref(): { theme: string; mode: ThemeMode } {
  const theme = read(KEYS.themeName);
  return theme ? { theme, mode: parseThemeMode(read(KEYS.themeMode)) } : { ...DEFAULT_THEME };
}

export function saveThemePref(theme: string, mode: ThemeMode): void {
  write(KEYS.themeName, theme);
  write(KEYS.themeMode, mode);
}

/** The saved font size; the default when none was saved or it is out of range. */
export function loadFontSizePref(): number {
  const size = parseInt(read(KEYS.fontSize) ?? '', 10);
  return isFontSize(size) ? size : DEFAULT_FONT_SIZE;
}

export function saveFontSizePref(size: number): void {
  write(KEYS.fontSize, String(size));
}
