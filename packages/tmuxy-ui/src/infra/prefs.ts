/**
 * What this client remembers between visits, in localStorage: the theme and
 * mode picked from the menu, the font size and the phone's split — every
 * key, its default, and the one guarded read and write.
 */

import { parseThemeMode, type ThemeInfo, type ThemeMode } from '../domain/wireSettings';
import type { BackendCall } from '../domain/backendCalls';
import { BUNDLED_THEMES } from '../domain/tmuxyConstants.gen';
import { parsePhoneSplit, type PhoneSplit } from '../domain/phoneSplit';
import { DEFAULT_FONT_SIZE, isFontSize } from './fontSizeManager';

const KEYS = {
  themeName: 'tmuxy-theme-name',
  themeMode: 'tmuxy-theme-mode',
  fontSize: 'tmuxy-font-size',
  phoneSplit: 'tmuxy-phone-split',
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

function forget(key: PrefKey): void {
  try {
    localStorage.removeItem(key);
  } catch {
    return;
  }
}

export const DEFAULT_THEME: { readonly theme: string; readonly mode: ThemeMode } = {
  theme: 'default',
  mode: 'dark',
};

export function loadThemePref(): { theme: string; mode: ThemeMode } {
  const theme = read(KEYS.themeName);
  return theme ? { theme, mode: parseThemeMode(read(KEYS.themeMode)) } : { ...DEFAULT_THEME };
}

export function saveThemePref(theme: string, mode: ThemeMode): void {
  write(KEYS.themeName, theme);
  write(KEYS.themeMode, mode);
}

type ThemeCall = Extract<
  BackendCall,
  { cmd: 'set_theme' | 'set_theme_mode' | 'get_theme_settings' | 'get_themes_list' }
>;

const THEME_CALLS: ReadonlySet<BackendCall['cmd']> = new Set([
  'set_theme',
  'set_theme_mode',
  'get_theme_settings',
  'get_themes_list',
]);

export function isThemeCall(call: BackendCall): call is ThemeCall {
  return THEME_CALLS.has(call.cmd);
}

/**
 * The theme calls of a transport with no server, answered from these prefs
 * the way the demo site answers them: the shipped themes, the saved choice.
 */
export function answerThemeCall(
  call: ThemeCall,
): { theme: string; mode: ThemeMode } | readonly ThemeInfo[] | null {
  const saved = loadThemePref();
  switch (call.cmd) {
    case 'set_theme': {
      const { name, mode } = call.args;
      saveThemePref(name || saved.theme, mode == null ? saved.mode : parseThemeMode(mode));
      return null;
    }
    case 'set_theme_mode':
      saveThemePref(saved.theme, parseThemeMode(call.args.mode));
      return null;
    case 'get_theme_settings':
      return saved;
    case 'get_themes_list':
      return BUNDLED_THEMES;
  }
}

export function loadFontSizePref(): number {
  const size = parseInt(read(KEYS.fontSize) ?? '', 10);
  return isFontSize(size) ? size : DEFAULT_FONT_SIZE;
}

export function saveFontSizePref(size: number): void {
  write(KEYS.fontSize, String(size));
}

export function loadPhoneSplitPref(): PhoneSplit {
  return parsePhoneSplit(read(KEYS.phoneSplit));
}

export function savePhoneSplitPref(split: PhoneSplit): void {
  write(KEYS.phoneSplit, JSON.stringify(split));
}

/** The next load starts from the default split (a story's clean slate). */
export function forgetPhoneSplitPref(): void {
  forget(KEYS.phoneSplit);
}
