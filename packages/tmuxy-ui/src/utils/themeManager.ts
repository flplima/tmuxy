const THEME_LINK_ID = 'tmuxy-theme';
const LS_THEME_KEY = 'tmuxy-theme-name';
const LS_MODE_KEY = 'tmuxy-theme-mode';

/** Load a theme CSS file by name. Creates or replaces the <link> element. */
export function loadTheme(name: string): void {
  let link = document.getElementById(THEME_LINK_ID) as HTMLLinkElement | null;
  const href = `/themes/${name}.css`;

  if (link) {
    if (link.getAttribute('href') !== href) {
      link.setAttribute('href', href);
    }
  } else {
    link = document.createElement('link');
    link.id = THEME_LINK_ID;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
}

/** Set theme-dark or theme-light class on <html>. */
export function applyThemeMode(mode: 'dark' | 'light'): void {
  const html = document.documentElement;
  html.classList.remove('theme-dark', 'theme-light');
  html.classList.add(`theme-${mode}`);
}

/** Load theme CSS and apply mode class. */
export function applyTheme(name: string, mode: 'dark' | 'light'): void {
  loadTheme(name);
  applyThemeMode(mode);
}

/** Save theme name and mode to localStorage. */
export function saveThemeToStorage(name: string, mode: 'dark' | 'light'): void {
  try {
    localStorage.setItem(LS_THEME_KEY, name);
    localStorage.setItem(LS_MODE_KEY, mode);
  } catch {
    // localStorage unavailable (e.g. private browsing)
  }
}

/** Load saved theme from localStorage. Returns null if nothing saved. */
export function loadThemeFromStorage(): { theme: string; mode: 'dark' | 'light' } | null {
  try {
    const theme = localStorage.getItem(LS_THEME_KEY);
    const mode = localStorage.getItem(LS_MODE_KEY);
    if (theme) {
      return { theme, mode: mode === 'light' ? 'light' : 'dark' };
    }
  } catch {
    // localStorage unavailable
  }
  return null;
}
