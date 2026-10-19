/**
 * NativeMenuBar — the macOS menu bar, set from the page.
 *
 * The bar is the `menuBarSpec` (domain/menus) handed to the platform through
 * `setNativeAppMenu`, so its check marks and disabled states are the live
 * ones and its item callbacks run here — dispatching exactly as the hamburger
 * does. It is rebuilt when what it shows changes (debounced, and only when
 * the spec itself differs: the context changes on every byte of output, the
 * menu only when one of its inputs does) and when this window takes focus,
 * so the focused window owns the bar and its callbacks act on it. Renders
 * nothing but the menu's dialogs.
 */

import { useEffect, useRef } from 'react';
import { useAppSelector } from '../../machines/appHooks';
import { menuBarSpec } from '../../domain/menus/menuBar';
import { itemIds, type MenuSpec } from '../../domain/menus/spec';
import { setNativeAppMenu } from '../../infra/menus/nativeMenu';
import { useMenuEnv } from './menuEnv';
import { useMenuHost } from './menuHost';
import { useAppMenuSurface } from './useAppMenuSurface';

const REBUILD_DEBOUNCE_MS = 120;

/** The spec with its actions left out: what decides whether the bar must be rebuilt. */
function shapeOf(spec: MenuSpec): string {
  return JSON.stringify(spec, (key, value: unknown) => (key === 'action' ? undefined : value));
}

export function NativeMenuBar() {
  const host = useMenuHost();
  const env = useMenuEnv();
  const { dispatch, options, refreshWindows, dialogs } = useAppMenuSurface(env);
  const spec = useAppSelector((ctx) => menuBarSpec(ctx, env, options));
  const shape = shapeOf(spec);

  const latest = useRef({ spec, dispatch });
  latest.current = { spec, dispatch };

  useEffect(() => {
    if (host !== 'native-bar') return;
    const timer = window.setTimeout(() => {
      const { spec, dispatch } = latest.current;
      void setNativeAppMenu(spec, dispatch).catch((e: unknown) =>
        console.error('native menu bar not set:', e),
      );
    }, REBUILD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [host, shape]);

  // The bar belongs to the focused window: on focus this window sets it so
  // the callbacks act here, and the Window submenu's lists are re-read.
  useEffect(() => {
    if (host !== 'native-bar') return;
    let unlisten: (() => void) | null = null;
    let gone = false;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (!focused) return;
          refreshWindows();
          const { spec, dispatch } = latest.current;
          void setNativeAppMenu(spec, dispatch).catch(() => {});
        })
        .then((off) => {
          if (gone) off();
          else unlisten = off;
        }),
    );
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [host, refreshWindows]);

  // The bar's icons are drawn in the system's menu text colour
  // (`infra/menus/nativeIcons.ts`): a change of appearance draws them again.
  useEffect(() => {
    if (host !== 'native-bar' || typeof window.matchMedia !== 'function') return;
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const redraw = () => {
      const { spec, dispatch } = latest.current;
      void setNativeAppMenu(spec, dispatch).catch(() => {});
    };
    scheme.addEventListener('change', redraw);
    return () => scheme.removeEventListener('change', redraw);
  }, [host]);

  // The seam the desktop E2E suite tests: the bar's spec and setting it. A
  // WebDriver cannot click a native menu, so this is how the suite checks that
  // the spec is built and that the platform takes it.
  useEffect(() => {
    const api: TmuxyMenusTestApi = {
      barIds: () => itemIds(latest.current.spec),
      rebuild: () =>
        setNativeAppMenu(latest.current.spec, latest.current.dispatch).then(() => true),
    };
    (window as unknown as { tmuxyMenus?: TmuxyMenusTestApi }).tmuxyMenus = api;
    return () => {
      delete (window as unknown as { tmuxyMenus?: TmuxyMenusTestApi }).tmuxyMenus;
    };
  }, []);

  return <>{dialogs}</>;
}

interface TmuxyMenusTestApi {
  barIds: () => string[];
  rebuild: () => Promise<boolean>;
}
