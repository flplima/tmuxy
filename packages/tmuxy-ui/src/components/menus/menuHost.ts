import { useAppSelector } from '../../machines/appHooks';
import { isMacPlatform, isTauri } from '../../utils/platform';

/**
 * Who draws a menu.
 *
 * - `native-bar`: Tauri on macOS — the menu bar is native and so are the
 *   popups; the hamburger is not shown.
 * - `native-popup`: Tauri elsewhere — native popups; the hamburger stays,
 *   since Linux has no global menu bar and a GTK in-window menubar would
 *   fight the transparent custom status bar.
 * - `in-app`: the web, the demo, Storybook, a read-only viewer, and the
 *   desktop with `@tmuxy-native-menus off`.
 */
export type MenuHost = 'native-bar' | 'native-popup' | 'in-app';

export function menuHost(nativeMenus: boolean): MenuHost {
  if (!isTauri() || !nativeMenus) return 'in-app';
  return isMacPlatform() ? 'native-bar' : 'native-popup';
}

export function useMenuHost(): MenuHost {
  const nativeMenus = useAppSelector((c) => c.nativeMenus);
  return menuHost(nativeMenus);
}
