/**
 * The theme a preview is drawn in: the app's tokens, resolved. Mermaid computes
 * its palette in script and a framed page is another document, so neither can
 * read a CSS variable. The theme sheet loads after the switch that asked for it,
 * so the tokens are re-read on the root's class or style changing and on any
 * stylesheet finishing its load.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

export interface PreviewTheme {
  mode: 'dark' | 'light';
  foreground: string;
  background: string;
  accent: string;
  muted: string;
  /** Code blocks, table headers: a step off the background. */
  surface: string;
  border: string;
  fontMono: string;
  /** The pane's font size: the root's here, the pane's own once the widget reads it (`usePaneFontSize`). */
  fontSize: string;
}

const TOKENS: Record<Exclude<keyof PreviewTheme, 'mode'>, string> = {
  foreground: '--term-foreground',
  background: '--term-background',
  accent: '--theme-accent',
  muted: '--text-dimmed',
  surface: '--bg-medium',
  border: '--border-medium',
  fontMono: '--font-mono',
  fontSize: '--tmuxy-font-size',
};

let cached: { key: string; theme: PreviewTheme } | null = null;

function snapshot(): PreviewTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const entries = Object.entries(TOKENS).map(([name, token]) => [
    name,
    style.getPropertyValue(token).trim(),
  ]);
  const mode = root.classList.contains('theme-light') ? 'light' : 'dark';
  const key = `${mode}|${entries.map(([, v]) => v).join('|')}`;
  if (cached?.key !== key) {
    cached = { key, theme: { mode, ...Object.fromEntries(entries) } as PreviewTheme };
  }
  return cached.theme;
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  // A `load` on a <link> does not bubble; the capture phase still sees it.
  document.addEventListener('load', onChange, true);
  return () => {
    observer.disconnect();
    document.removeEventListener('load', onChange, true);
  };
}

export function usePreviewTheme(): PreviewTheme {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * `theme` with the font size of the pane `el` sits in. The phone fits its own
 * type to its grid on an element below the root, so the root's size is not
 * the one the pane's terminal is drawn in. Read again when the element is
 * resized (a new fit) and when the theme is (the root's size changed).
 */
export function usePaneTheme(theme: PreviewTheme, el: HTMLElement | null): PreviewTheme {
  const [fontSize, setFontSize] = useState('');
  useEffect(() => {
    if (!el) return;
    const read = () =>
      setFontSize(getComputedStyle(el).getPropertyValue('--tmuxy-font-size').trim());
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, theme]);
  return useMemo(
    () => (fontSize && fontSize !== theme.fontSize ? { ...theme, fontSize } : theme),
    [theme, fontSize],
  );
}
