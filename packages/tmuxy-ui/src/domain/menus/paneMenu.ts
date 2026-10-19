/**
 * The pane menu: the hamburger's Pane submenu, the native Pane menu, a
 * pane header's right-click and ⋮ menu, and the sidebar tree's pane rows —
 * one list, with the parts a surface leaves out named by the options.
 */

import type { AppMachineContext } from '../../machines/types/context';
import { selectMarkedPaneId } from '../../machines/selectors/panesAndSidebars';
import type { WidgetMenuItem } from '../../components/widgets/registry';
import { MENU_OPS } from '../../components/menus/menuActions';
import { TmuxOp } from '../commands';
import type { PaneId } from '../ids';
import { keyHint } from './keyHint';
import type { MenuIconName } from './icons';
import { action, event, local, separator, tidy, type MenuNode, type MenuSpec } from './spec';

export interface PaneMenuOptions {
  /** The pane the menu is about; null for the app menu, which acts on the active one. */
  paneId: PaneId | null;
  /** The pane's widget's own items, shown as a section above the generic ones. */
  widgetItems?: ReadonlyArray<WidgetMenuItem>;
  /**
   * Next / Previous Pane and the adjacent swaps. The app menu offers them; a
   * context menu is about the pane it was opened on, so it leaves them out.
   */
  navigation?: boolean;
  /** Offer "Rename Pane" (the surface showing the title owns the field). */
  rename?: boolean;
}

export function paneMenuSpec(ctx: AppMachineContext, options: PaneMenuOptions): MenuSpec {
  const { keybindings } = ctx;
  const hint = (id: keyof typeof MENU_OPS) => keyHint(keybindings, MENU_OPS[id]);
  const paneId = options.paneId ?? ctx.activePaneId;
  const markedPaneId = selectMarkedPaneId(ctx);
  const isMarked = markedPaneId !== null && markedPaneId === paneId;
  const hasMarked = markedPaneId !== null;
  const single = ctx.panes.filter((p) => p.windowId === ctx.activeWindowId).length <= 1;
  const navigation = options.navigation ?? true;

  const widget: MenuNode[] = (options.widgetItems ?? []).map((item) => ({
    kind: 'item',
    id: `widget:${item.id}`,
    label: item.label,
    keyHint: item.keyHint,
    disabled: item.disabled,
    data: { 'widget-action': item.id },
    action: event(item.event),
  }));

  const op = (
    id: keyof typeof MENU_OPS,
    label: string,
    icon: MenuIconName,
    disabled = false,
  ): MenuNode => ({
    kind: 'item',
    id,
    label,
    icon,
    keyHint: hint(id),
    disabled,
    action: action(id),
  });

  return tidy([
    ...widget,
    widget.length > 0 && separator,
    options.rename && {
      kind: 'item',
      id: 'pane-rename',
      label: 'Rename Pane',
      icon: 'rename',
      action: local('pane-rename'),
    },
    options.rename && separator,
    op('pane-split-below', 'Split Pane Below', 'split-below'),
    op('pane-split-right', 'Split Pane Right', 'split-right'),
    separator,
    navigation && op('pane-next', 'Next Pane', 'next', single),
    navigation && op('pane-previous', 'Previous Pane', 'previous', single),
    navigation && separator,
    navigation && op('pane-swap-prev', 'Swap with Previous', 'swap', single),
    navigation && op('pane-swap-next', 'Swap with Next', 'swap', single),
    navigation && separator,
    isMarked ? op('pane-unmark', 'Unmark Pane', 'mark') : op('pane-mark', 'Mark Pane', 'mark'),
    {
      kind: 'item',
      id: 'pane-swap-marked',
      label: 'Swap with Marked Pane',
      icon: 'swap',
      disabled: !hasMarked || isMarked,
      action: action('pane-swap-marked'),
    },
    {
      kind: 'item',
      id: 'pane-join-marked',
      label: 'Join Marked Pane Here',
      icon: 'join',
      disabled: !hasMarked || isMarked,
      action: action('pane-join-marked'),
    },
    separator,
    op('pane-move-new-tab', 'Move to New Tab', 'move-out'),
    {
      kind: 'item',
      id: 'pane-add-to-group',
      label: 'Add Pane to Group',
      icon: 'group',
      action: action('pane-add-to-group'),
    },
    separator,
    op('pane-copy-mode', 'Copy Mode', 'copy-mode'),
    op('pane-paste', 'Paste', 'paste'),
    {
      kind: 'item',
      id: 'pane-clear',
      label: 'Clear Screen',
      icon: 'clear',
      action: action('pane-clear'),
    },
    separator,
    op('view-zoom', 'Zoom Pane', 'zoom'),
    separator,
    {
      kind: 'item',
      id: 'pane-close',
      label: 'Close Pane',
      icon: 'close',
      keyHint: keyHint(keybindings, TmuxOp.KillPane({ paneId: null })),
      action: action('pane-close'),
    },
  ]);
}
