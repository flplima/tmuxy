const THEME_LINK_ID = 'tmuxy-theme';

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
