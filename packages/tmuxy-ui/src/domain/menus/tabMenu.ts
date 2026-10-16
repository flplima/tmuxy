/**
 * The tab menus: the hamburger's and the native Tab menu (about the active
 * tab, with navigation), and a tab's own context menu (about that tab).
 */

import type { AppMachineContext } from '../../machines/types';
import {
  MENU_OPS,
  STACK_TOGGLE_KEY_OP,
  TAB_RENAME_KEY_OP,
} from '../../components/menus/menuActions';
import { TmuxOp } from '../commands';
import type { WindowId } from '../ids';
import { keyHint } from './keyHint';
import {
  action,
  event,
  local,
  separator,
  tidy,
  type MenuEnv,
  type MenuNode,
  type MenuSpec,
} from './spec';

export interface TabMenuOptions {
  /** The tab the menu is about; null for the app menu, which acts on the active one. */
  windowId: WindowId | null;
  /** Next / Previous / Last Tab: the app menu's, not a context menu's. */
  navigation?: boolean;
}

export function tabMenuSpec(
  ctx: AppMachineContext,
  env: MenuEnv,
  options: TabMenuOptions,
): MenuSpec {
  const { keybindings } = ctx;
  const tabs = ctx.windows.filter((w) => w.windowType === 'tab');
  const single = tabs.length <= 1;
  const windowId = options.windowId ?? ctx.activeWindowId;
  const target = ctx.windows.find((w) => w.id === windowId);
  const navigation = options.navigation ?? true;
  const contextMenu = options.windowId !== null;
  const hint = (id: keyof typeof MENU_OPS) => keyHint(keybindings, MENU_OPS[id]);

  const nav = (id: keyof typeof MENU_OPS, label: string): MenuNode => ({
    kind: 'item',
    id,
    label,
    keyHint: hint(id),
    disabled: single,
    action: action(id),
  });

  return tidy([
    !env.readOnly && {
      kind: 'item',
      id: 'tab-new',
      label: 'New Tab',
      keyHint: keyHint(keybindings, TmuxOp.NewWindow()),
      accelerator: 'CmdOrCtrl+T',
      action: action('tab-new'),
    },
    {
      kind: 'item',
      id: 'tab-overview',
      label: 'Show All Tabs',
      keyHint: 'ctrl+0',
      action: action('tab-overview'),
    },
    navigation && separator,
    navigation && nav('tab-next', 'Next Tab'),
    navigation && nav('tab-previous', 'Previous Tab'),
    navigation && nav('tab-last', 'Last Tab'),
    !env.readOnly && separator,
    // A window option, so a checkbox: on, only the row holding the active
    // pane stays expanded (docs/TMUX.md).
    !env.readOnly && {
      kind: 'checkbox',
      id: 'tab-stack-toggle',
      label: 'Stacked Panes',
      checked: Boolean(target?.collapsible),
      keyHint: keyHint(keybindings, STACK_TOGGLE_KEY_OP),
      action: contextMenu && windowId ? local('tab-stack-toggle') : action('tab-stack-toggle'),
    },
    // Renaming happens in the tab itself — the strip owns the field, because
    // that is where the name is.
    !env.readOnly && {
      kind: 'item',
      id: 'tab-rename',
      label: 'Rename Tab',
      keyHint: keyHint(keybindings, TAB_RENAME_KEY_OP),
      action: contextMenu ? local('tab-rename') : action('tab-rename'),
    },
    !env.readOnly && separator,
    !env.readOnly && {
      kind: 'item',
      id: 'tab-close',
      label: 'Close Tab',
      keyHint: hint('tab-close'),
      accelerator: 'CmdOrCtrl+W',
      action:
        contextMenu && windowId
          ? event({ type: 'DISPATCH_OP', op: TmuxOp.KillWindow({ windowId }) })
          : action('tab-close'),
    },
  ]);
}
