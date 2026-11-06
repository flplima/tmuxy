import { useEffect, useState } from 'react';
import { isTauri } from '../infra/platform';
import { getWindowStyle } from '../infra/guiWindows';
import type { WindowStyleSlug } from '../domain/guiWindows';

/**
 * The style this window is in, kept current: the desktop app announces each
 * change (`window-style`) once it has landed, whichever menu asked for it.
 * `normal` in a browser.
 */
export function useWindowStyle(): WindowStyleSlug {
  const [style, setStyle] = useState<WindowStyleSlug>('normal');
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let gone = false;
    void getWindowStyle().then((s) => {
      if (!gone) setStyle(s);
    });
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<WindowStyleSlug>('window-style', (e) => setStyle(e.payload)).then((off) => {
        if (gone) off();
        else unlisten = off;
      }),
    );
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);
  return style;
}
