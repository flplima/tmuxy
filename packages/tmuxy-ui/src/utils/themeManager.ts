import { isTauri, tauriSchemeUrl } from './platform';

const THEME_LINK_ID = 'tmuxy-theme';
/** The user's own `custom.css`, loaded after the theme so it wins. */
const CUSTOM_LINK_ID = 'tmuxy-custom-css';
/** The `@tmuxy-css-*` options, as one rule between the two links. */
const VARS_STYLE_ID = 'tmuxy-css-vars';

/** What the Theme menu offers: a palette, or the operating system's choice. */
export type ThemeMode = 'dark' | 'light' | 'auto';
export type ResolvedThemeMode = Exclude<ThemeMode, 'auto'>;

/** A theme entry as `get_themes_list` answers it. */
export interface ThemeInfo {
  name: string;
  displayName: string;
  /** The modes the file declares a palette for; absent from adapters without the file. */
  modes?: readonly string[];
}

const LS_THEME_KEY = 'tmuxy-theme-name';
const LS_MODE_KEY = 'tmuxy-theme-mode';

/**
 * Bumped on every `css-changed` push: the href carries it as a query so the
 * browser fetches the saved file instead of answering from its cache.
 */
let cssVersion = 0;

/**
 * The stylesheets are the server's: the config dir's copy of a theme, or the
 * user's own. The web build reaches them at the app's origin; the desktop app
 * serves no HTTP and hands them out through its `tmuxycss:` scheme.
 */
function cssHref(path: string): string {
  const base = isTauri() ? tauriSchemeUrl('tmuxycss', `/${path}`) : `/${path}`;
  return cssVersion === 0 ? base : `${base}?v=${cssVersion}`;
}

/**
 * Point the stylesheet link `id` at `href`, creating it before `before` the
 * first time.
 *
 * A link that already exists is not re-pointed in place: changing its href
 * drops the old sheet at once and applies the new one only when it has
 * loaded, so for the length of a fetch — long on a phone over the LAN — the
 * page fell back to styles.css's defaults (the status line flashed green, the
 * chrome went to the built-in grey) between one theme and the next. The new
 * sheet loads in a link of its own beside the old one, and the old one goes
 * when the new one has loaded: one switch, from one theme to the other. A
 * sheet that fails to load is dropped and the old one stays.
 */
function ensureLink(id: string, href: string, before: Element | null): void {
  const current = document.getElementById(id) as HTMLLinkElement | null;
  // A switch still loading is superseded by this one.
  document.querySelector(`link[data-pending-for="${id}"]`)?.remove();
  if (current && current.getAttribute('href') === href) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  if (!current) {
    link.id = id;
    link.addEventListener('load', syncThemeColor);
    if (before) document.head.insertBefore(link, before);
    else document.head.appendChild(link);
    return;
  }
  link.dataset.pendingFor = id;
  link.addEventListener('load', () => {
    if (link.dataset.pendingFor !== id) return;
    delete link.dataset.pendingFor;
    current.remove();
    link.id = id;
    syncThemeColor();
  });
  link.addEventListener('error', () => {
    if (link.dataset.pendingFor === id) link.remove();
  });
  current.after(link);
}

/**
 * The browser's own chrome in the theme's window colour: `theme-color` is
 * what a phone's browser and an installed web app tint their bars with, and
 * a fixed `#000000` left them black, or white, whatever the theme.
 */
function syncThemeColor(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const rgb = getComputedStyle(document.documentElement).getPropertyValue('--window-bg-rgb').trim();
  if (rgb) meta.setAttribute('content', `rgb(${rgb})`);
}

/**
 * The sheet the `@tmuxy-css-*` options are written into. It sits between the
 * theme link and the custom.css link: later in the cascade than the theme at
 * the same specificity, so its variables win; earlier than `custom.css`, so
 * the user's own file still has the last word.
 */
function ensureVarsStyle(): HTMLStyleElement {
  let style = document.getElementById(VARS_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = VARS_STYLE_ID;
    document.head.insertBefore(style, document.getElementById(CUSTOM_LINK_ID));
  }
  return style;
}

let currentThemeName = 'default';

/** Load a theme CSS file by name, then the config variables, then the user's `custom.css`. */
function loadTheme(name: string): void {
  currentThemeName = name;
  ensureLink(THEME_LINK_ID, cssHref(`themes/${name}.css`), ensureVarsStyle());
  ensureLink(CUSTOM_LINK_ID, cssHref('custom.css'), null);
}

/**
 * A stylesheet under the config dir was saved: fetch both again. Nothing
 * else changes — the theme name, the mode and the variables set from the
 * config all stay as they were.
 */
export function reloadThemeCss(): void {
  cssVersion += 1;
  loadTheme(currentThemeName);
}

const darkScheme = () =>
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/** The palette `auto` means right now. */
export function resolveThemeMode(mode: ThemeMode): ResolvedThemeMode {
  if (mode !== 'auto') return mode;
  return darkScheme()?.matches === false ? 'light' : 'dark';
}

let currentMode: ThemeMode = 'dark';
let followingSystem = false;

function setModeClass(mode: ResolvedThemeMode): void {
  const html = document.documentElement;
  html.classList.remove('theme-dark', 'theme-light');
  html.classList.add(`theme-${mode}`);
  syncThemeColor();
}

/** Set theme-dark or theme-light class on <html>; `auto` follows the OS from here on. */
export function applyThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  setModeClass(resolveThemeMode(mode));
  if (mode === 'auto' && !followingSystem) {
    followingSystem = true;
    darkScheme()?.addEventListener('change', () => {
      if (currentMode === 'auto') setModeClass(resolveThemeMode('auto'));
    });
  }
}

/** Load theme CSS and apply mode class. */
export function applyTheme(name: string, mode: ThemeMode): void {
  loadTheme(name);
  applyThemeMode(mode);
}

/**
 * The `@tmuxy-css-<name>` options from the config, as `--<name>` declared on
 * the root with the themes' own selectors. Each push replaces the previous
 * set, so an option removed from the config is removed from the page.
 */
export function applyCssVars(vars: Readonly<Record<string, string>>): void {
  const declarations = Object.entries(vars)
    .map(([name, value]) => `  --${name}: ${value};`)
    .join('\n');
  ensureVarsStyle().textContent = declarations
    ? `:root.theme-dark, :root.theme-light {\n${declarations}\n}\n`
    : '';
}

/** Save theme name and mode to localStorage. */
export function saveThemeToStorage(name: string, mode: ThemeMode): void {
  try {
    localStorage.setItem(LS_THEME_KEY, name);
    localStorage.setItem(LS_MODE_KEY, mode);
  } catch {
    // localStorage unavailable (e.g. private browsing)
  }
}

export function parseThemeMode(mode: unknown): ThemeMode {
  return mode === 'light' || mode === 'auto' ? mode : 'dark';
}

/** Load saved theme from localStorage. Returns null if nothing saved. */
export function loadThemeFromStorage(): { theme: string; mode: ThemeMode } | null {
  try {
    const theme = localStorage.getItem(LS_THEME_KEY);
    const mode = localStorage.getItem(LS_MODE_KEY);
    if (theme) {
      return { theme, mode: parseThemeMode(mode) };
    }
  } catch {
    // localStorage unavailable
  }
  return null;
}
