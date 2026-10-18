/**
 * The macOS menu bar: the application menu's submenus laid out as top-level
 * menus, with the `tmuxy` menu (the app section in HIG order) first and the
 * platform's Edit and Window menus among them.
 */

import type { AppMachineContext } from '../../machines/types/context';
import {
  appItemsSpec,
  debugMenuSpec,
  helpMenuSpec,
  sessionMenuSpec,
  themeMenuSpec,
  viewMenuSpec,
  type AppMenuOptions,
} from './appMenu';
import { paneMenuSpec } from './paneMenu';
import { tabMenuSpec } from './tabMenu';
import { tidy, type MenuEnv, type MenuNode, type MenuSpec } from './spec';

export function menuBarSpec(
  ctx: AppMachineContext,
  env: MenuEnv,
  options: AppMenuOptions = {},
): MenuSpec {
  const top = (id: string, label: string, children: MenuSpec): MenuNode => ({
    kind: 'submenu',
    id,
    label,
    children,
  });
  return tidy([
    top('menu-app', 'tmuxy', appItemsSpec(env, 'native-bar')),
    !env.readOnly &&
      top(
        'menu-pane',
        'Pane',
        paneMenuSpec(ctx, { paneId: null, widgetItems: options.widgetItems }),
      ),
    top('menu-tab', 'Tab', tabMenuSpec(ctx, env, { windowId: null })),
    !env.readOnly && top('menu-session', 'Session', sessionMenuSpec(ctx, env)),
    top('menu-theme', 'Theme', themeMenuSpec(ctx)),
    top('menu-view', 'View', viewMenuSpec(ctx, env)),
    // No Select All: over a terminal grid it selects the whole document,
    // which means nothing.
    top('menu-edit', 'Edit', [
      { kind: 'predefined', which: 'copy' },
      { kind: 'predefined', which: 'paste' },
    ]),
    options.windowMenu,
    !env.readOnly && top('menu-debug', 'Debug', debugMenuSpec(ctx, env)),
    top('menu-help', 'Help', helpMenuSpec(env)),
  ]);
}
