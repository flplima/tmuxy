/**
 * The tab menus: the hamburger's and the native Tab menu (about the active
 * tab, with navigation), and a tab's own context menu (about that tab).
 */

import type { AppMachineContext } from '../../../machines/types/context';
import { TmuxOp } from '../../../domain/commands';
import type { WindowId } from '../../../domain/ids';
import { keyHint } from '../../../domain/keyLabels';
import { separator, tidy } from '../../../domain/menus/spec';
import { command, commandHint, local, op, type AppMenuNode, type AppMenuSpec } from './actions';

const TAB_OPS = {
  'tab-next': TmuxOp.SelectWindow({ target: 'next' }),
  'tab-previous': TmuxOp.SelectWindow({ target: 'previous' }),
  'tab-last': TmuxOp.LastWindow(),
} as const satisfies Record<string, TmuxOp>;

export interface TabMenuOptions {
  /** The tab the menu is about; null for the app menu, which acts on the active one. */
  windowId: WindowId | null;
  /** Next / Previous / Last Tab: the app menu's, not a context menu's. */
  navigation?: boolean;
}

export function tabMenuSpec(ctx: AppMachineContext, options: TabMenuOptions): AppMenuSpec {
  const { keybindings } = ctx;
  const tabs = ctx.windows.filter((w) => w.windowType === 'tab');
  const single = tabs.length <= 1;
  const windowId = options.windowId ?? ctx.activeWindowId;
  const target = ctx.windows.find((w) => w.id === windowId);
  const navigation = options.navigation ?? true;
  const contextMenu = options.windowId !== null;
  const closeOp = TmuxOp.KillWindow({ windowId: contextMenu ? windowId : null });

  const nav = (id: keyof typeof TAB_OPS, label: string): AppMenuNode => ({
    kind: 'item',
    id,
    label,
    keyHint: keyHint(keybindings, TAB_OPS[id]),
    disabled: single,
    action: op(TAB_OPS[id]),
  });

  return tidy([
    {
      kind: 'item',
      id: 'tab-new',
      label: 'New Tab',
      icon: 'new',
      keyHint: commandHint(keybindings, 'tab-new'),
      accelerator: 'CmdOrCtrl+T',
      action: command('tab-new'),
    },
    {
      kind: 'item',
      id: 'tab-overview',
      label: 'Show All Tabs',
      icon: 'tabs',
      keyHint: commandHint(keybindings, 'tab-overview'),
      action: command('tab-overview'),
    },
    navigation && separator,
    navigation && nav('tab-next', 'Next Tab'),
    navigation && nav('tab-previous', 'Previous Tab'),
    navigation && nav('tab-last', 'Last Tab'),
    separator,
    // A window option, so a checkbox: on, only the row holding the active
    // pane stays expanded (docs/TMUX.md).
    {
      kind: 'checkbox',
      id: 'tab-stack-toggle',
      label: 'Stacked Panes',
      checked: Boolean(target?.collapsible),
      keyHint: commandHint(keybindings, 'tab-stack-toggle'),
      action:
        contextMenu && windowId
          ? op(
              TmuxOp.SetWindowTag({
                windowId,
                tag: 'collapsible',
                value: target?.collapsible ? null : '1',
              }),
            )
          : command('tab-stack-toggle'),
    },
    {
      kind: 'item',
      id: 'tab-rename',
      label: 'Rename Tab',
      icon: 'rename',
      keyHint: commandHint(keybindings, 'tab-rename'),
      action: contextMenu ? local({ verb: 'rename' }) : command('tab-rename'),
    },
    separator,
    {
      kind: 'item',
      id: 'tab-close',
      label: 'Close Tab',
      icon: 'close',
      keyHint: keyHint(keybindings, TmuxOp.KillWindow({ windowId: null })),
      accelerator: 'CmdOrCtrl+W',
      action: op(closeOp),
    },
  ]);
}
