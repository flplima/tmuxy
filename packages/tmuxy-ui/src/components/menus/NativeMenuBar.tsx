/**
 * The macOS menu bar, set from the page. Rebuilt, debounced, only when the
 * spec's shape changes (the context changes on every byte of output), and
 * whenever this window takes focus: the focused window owns the bar, and its
 * callbacks act on that window.
 */

import { useEffect, useRef } from 'react';
import { useAppSelector } from '../../machines/appHooks';
import { menuBarSpec } from './specs/menuBar';
import { itemIds, submenuOpeners, type MenuSpec } from '../../domain/menus/spec';
import { setNativeAppMenu } from '../../infra/menus/nativeMenu';
import { failing } from '../../infra/logFailure';
import { useMenuEnv } from './menuEnv';
import { useMenuHost } from './menuHost';
import { useAppMenuSurface } from './useAppMenuSurface';

const REBUILD_DEBOUNCE_MS = 120;

/** The spec with its actions left out: what decides whether the bar must be rebuilt. */
function shapeOf<A>(spec: MenuSpec<A>): string {
  return JSON.stringify(spec, (key, value: unknown) => (key === 'action' ? undefined : value));
}

export function NativeMenuBar() {
  const host = useMenuHost();
  const env = useMenuEnv();
  const { dispatch, options, dialogs } = useAppMenuSurface(env);
  const spec = useAppSelector((ctx) => menuBarSpec(ctx, env, options));
  const shape = shapeOf(spec);

  const latest = useRef({ spec, dispatch });
  latest.current = { spec, dispatch };

  const rebuild = () => {
    const { spec, dispatch } = latest.current;
    return setNativeAppMenu(spec, dispatch);
  };
  const rebuildReporting = () => void rebuild().catch(failing('native menu bar'));

  useEffect(() => {
    if (host !== 'native-bar') return;
    const timer = window.setTimeout(rebuildReporting, REBUILD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [host, shape]);

  // A native submenu says nothing when it opens, so what the submenus read
  // on opening (the Window lists, the trace settings) is read when the bar
  // is first set and whenever this window takes focus.
  useEffect(() => {
    if (host !== 'native-bar') return;
    const { spec, dispatch } = latest.current;
    submenuOpeners(spec).forEach(dispatch);
  }, [host]);

  useEffect(() => {
    if (host !== 'native-bar') return;
    let unlisten: (() => void) | null = null;
    let gone = false;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (!focused) return;
          const { spec, dispatch } = latest.current;
          submenuOpeners(spec).forEach(dispatch);
          rebuildReporting();
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
  }, [host]);

  // The bar's icons are drawn in the system's menu text colour
  // (`infra/menus/nativeIcons.ts`): a change of appearance draws them again.
  useEffect(() => {
    if (host !== 'native-bar' || typeof window.matchMedia !== 'function') return;
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', rebuildReporting);
    return () => scheme.removeEventListener('change', rebuildReporting);
  }, [host]);

  // For the desktop E2E suite: a WebDriver cannot click a native menu.
  useEffect(() => {
    const api: TmuxyMenusTestApi = {
      barIds: () => itemIds(latest.current.spec),
      rebuild: () => rebuild().then(() => true),
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
