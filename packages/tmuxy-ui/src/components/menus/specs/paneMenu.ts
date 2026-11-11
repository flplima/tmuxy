/**
 * The pane menu: the hamburger's Pane submenu, the native Pane menu, a
 * pane header's right-click and ⋮ menu, and the sidebar tree's pane rows —
 * one list, with the parts a surface leaves out named by the options.
 */

import type { AppMachineContext } from '../../../machines/types/context';
import type { AppMachineEvent } from '../../../machines/types/events';
import { markedPaneId, paneTakesCopyMode } from '../../../domain/client';
import { TmuxOp } from '../../../domain/commands';
import type { PaneId } from '../../../domain/ids';
import { keyHint } from '../../../domain/keyLabels';
import { pluginsSubmenu } from './pluginMenu';
import type { MenuIconName } from '../../../domain/menus/icons';
import { separator, tidy } from '../../../domain/menus/spec';
import {
  event as eventAction,
  local,
  op as opAction,
  type AppMenuNode,
  type AppMenuSpec,
} from './actions';

export interface PaneMenuOptions {
  /** The pane the menu is about; null for the app menu, which acts on the active one. */
  paneId: PaneId | null;
  /** The pane's widget's own items, shown as a section above the generic ones. */
  widgetItems?: AppMenuSpec;
  /**
   * Next / Previous Pane and the adjacent swaps. The app menu offers them; a
   * context menu is about the pane it was opened on, so it leaves them out.
   */
  navigation?: boolean;
  /** Offer "Rename Pane" (the surface showing the title owns the field). */
  rename?: boolean;
}

/**
 * The pane menu's ops. Mark/unmark act on the pane the menu was opened for
 * (the caller focuses it first); swap/join take tmux's default source, which
 * is the marked pane whenever one exists.
 */
const PANE_OPS = {
  'pane-split-below': TmuxOp.Split({ direction: 'horizontal' }),
  'pane-split-right': TmuxOp.Split({ direction: 'vertical' }),
  'pane-next': TmuxOp.CyclePane({ windowId: null }),
  'pane-previous': TmuxOp.LastPane(),
  'pane-swap-prev': TmuxOp.SwapAdjacent({ direction: 'U' }),
  'pane-swap-next': TmuxOp.SwapAdjacent({ direction: 'D' }),
  'pane-mark': TmuxOp.MarkPane({ marked: true }),
  'pane-unmark': TmuxOp.MarkPane({ marked: false }),
  'pane-swap-marked': TmuxOp.SwapMarked(),
  'pane-join-marked': TmuxOp.JoinMarked(),
  'pane-move-new-tab': TmuxOp.BreakPane({ paneId: null }),
  'pane-add-to-group': TmuxOp.GroupAdd({ pane: null }),
  'pane-copy-mode': TmuxOp.EnterCopyMode({ paneId: null }),
  'pane-paste': TmuxOp.PasteBuffer(),
  'pane-clear': TmuxOp.ClearPane(),
  'view-zoom': TmuxOp.ZoomToggle({ paneId: null }),
} as const satisfies Record<string, TmuxOp>;

/**
 * The shell's prompts (OSC 133): the jump between them and the copy of the
 * newest command's output. `disabled` for a full-screen application, which
 * has no scrollback of the shell's behind it.
 */
function promptItems(paneId: PaneId | undefined, disabled: boolean): AppMenuNode[] {
  const item = (
    id: string,
    label: string,
    icon: MenuIconName,
    event: AppMachineEvent,
  ): AppMenuNode => ({ kind: 'item', id, label, icon, disabled, action: eventAction(event) });
  return [
    item('pane-prompt-previous', 'Previous Prompt', 'previous', {
      type: 'PROMPT_JUMP',
      paneId,
      direction: 'previous',
    }),
    item('pane-prompt-next', 'Next Prompt', 'next', {
      type: 'PROMPT_JUMP',
      paneId,
      direction: 'next',
    }),
    item('pane-copy-last-output', 'Copy Last Output', 'copy-mode', {
      type: 'COPY_LAST_OUTPUT',
      paneId,
    }),
  ];
}

export function paneMenuSpec(ctx: AppMachineContext, options: PaneMenuOptions): AppMenuSpec {
  const { keybindings } = ctx;
  const paneId = options.paneId ?? ctx.activePaneId;
  const marked = markedPaneId(ctx.panes);
  const isMarked = marked !== null && marked === paneId;
  const hasMarked = marked !== null;
  const single = ctx.panes.filter((p) => p.windowId === ctx.activeWindowId).length <= 1;
  const navigation = options.navigation ?? true;

  const widget = options.widgetItems ?? [];

  const op = (
    id: keyof typeof PANE_OPS,
    label: string,
    icon: MenuIconName,
    disabled = false,
  ): AppMenuNode => ({
    kind: 'item',
    id,
    label,
    icon,
    keyHint: keyHint(keybindings, PANE_OPS[id]),
    disabled,
    action: opAction(PANE_OPS[id]),
  });

  return tidy([
    ...widget,
    widget.length > 0 && separator,
    options.rename && {
      kind: 'item',
      id: 'pane-rename',
      label: 'Rename Pane',
      icon: 'rename',
      action: local({ verb: 'rename' }),
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
    op('pane-swap-marked', 'Swap with Marked Pane', 'swap', !hasMarked || isMarked),
    op('pane-join-marked', 'Join Marked Pane Here', 'join', !hasMarked || isMarked),
    separator,
    op('pane-move-new-tab', 'Move to New Tab', 'move-out'),
    op('pane-add-to-group', 'Add Pane to Group', 'group'),
    separator,
    op(
      'pane-copy-mode',
      'Copy Mode',
      'copy-mode',
      !paneId || !paneTakesCopyMode(ctx.panes, paneId),
    ),
    op('pane-paste', 'Paste', 'paste'),
    op('pane-clear', 'Clear Screen', 'clear'),
    separator,
    ...promptItems(options.paneId ?? undefined, !paneId || !paneTakesCopyMode(ctx.panes, paneId)),
    separator,
    pluginsSubmenu(ctx.plugins, 'pane', paneId, keybindings),
    separator,
    op('view-zoom', 'Zoom Pane', 'zoom'),
    separator,
    {
      kind: 'item',
      id: 'pane-close',
      label: 'Close Pane',
      icon: 'close',
      keyHint: keyHint(keybindings, TmuxOp.KillPane({ paneId: null })),
      // The group-aware close (CLOSE_PANE) swaps a sibling into view and
      // degroups the survivor, which a raw kill-pane does not. With no pane
      // named, the machine closes the one the keyboard is in.
      action: eventAction({ type: 'CLOSE_PANE', paneId: options.paneId }),
    },
  ]);
}
