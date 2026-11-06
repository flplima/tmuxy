/**
 * The macOS menu bar: the application menu's submenus laid out as top-level
 * menus, with the `tmuxy` menu (the app section in HIG order) first and the
 * platform's Edit and Window menus before Debug. Derived from `appMenuSpec`,
 * so the bar and the hamburger list the same submenus, each with the same
 * items and the same `onOpen`.
 */

import type { AppMachineContext } from '../../../machines/types/context';
import { tidy, type MenuEnv } from '../../../domain/menus/spec';
import { appItemsSpec, appMenuSpec, type AppMenuOptions } from './appMenu';
import type { AppMenuAction, AppMenuNode, AppMenuSpec } from './actions';

export function menuBarSpec(
  ctx: AppMachineContext,
  env: MenuEnv,
  options: AppMenuOptions = {},
): AppMenuSpec {
  const top = (id: string, label: string, children: AppMenuSpec): AppMenuNode => ({
    kind: 'submenu',
    id,
    label,
    children,
  });
  // The Window submenu goes after Edit here (HIG), not where the hamburger has it.
  const submenus = appMenuSpec(ctx, env, { widgetItems: options.widgetItems }).filter(
    (node) => node.kind === 'submenu',
  );
  const debug = submenus.findIndex((node) => node.id === 'menu-debug');
  const before = debug === -1 ? submenus : submenus.slice(0, debug);
  const after = debug === -1 ? [] : submenus.slice(debug);
  return tidy<AppMenuAction>([
    top('menu-app', 'tmuxy', appItemsSpec(env, 'native-bar')),
    ...before,
    // No Select All: over a terminal grid it selects the whole document,
    // which means nothing.
    top('menu-edit', 'Edit', [
      { kind: 'predefined', which: 'copy' },
      { kind: 'predefined', which: 'paste' },
    ]),
    options.windowMenu,
    ...after,
  ]);
}
