/**
 * TabContextMenu - Right-click context menu for tab (window) operations.
 *
 * Extracted from WindowTabs so the sidebar tree's tab rows get the identical
 * menu. Mounted only while the caller wants it, anchored at the point that was
 * right-clicked — or, when the tab's preview was up, AT THE CARD: the strip
 * hands over the card's box (`morphFrom`) and the menu grows out of it rather
 * than appearing beside the ghost of something that just vanished.
 */

import { FloatingMenu, MenuItem, MenuDivider } from './floating/Menu';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  selectKeyBindings,
  selectWindows,
} from '../machines/AppContext';
import { executeMenuAction } from './menus/menuActions';
import { KeyLabel } from './menus/KeyLabel';

interface TabContextMenuProps {
  /** tmux window index the actions target (Close/Rename operate on this tab). */
  windowId: string;
  x: number;
  y: number;
  /** The tab's button, when the menu is replacing that tab's preview card. */
  anchorEl?: HTMLElement | null;
  /** The preview card's box, when this menu is what it turns into. */
  morphFrom?: DOMRect | null;
  onClose: () => void;
  /** Start renaming this tab where it is drawn; the caller owns the field. */
  onRename: () => void;
}

export function TabContextMenu({
  windowId,
  x,
  y,
  anchorEl = null,
  morphFrom = null,
  onClose,
  onRename,
}: TabContextMenuProps) {
  const send = useAppSend();
  const keybindings = useAppSelector(selectKeyBindings);
  const allWindows = useAppSelectorShallow(selectWindows);
  const isSingleWindow = allWindows.filter((w) => w.windowType === 'tab').length <= 1;
  const target = allWindows.find((w) => w.id === windowId);
  const collapsible = Boolean(target?.collapsible);

  const handleAction = (actionId: string) => {
    executeMenuAction(send, actionId);
    onClose();
  };

  const handleCloseSpecificTab = () => {
    send({ type: 'SEND_TMUX_COMMAND', command: `kill-window -t ${windowId}` });
    onClose();
  };

  // Collapsible panes: a window option the backend reads (docs/TMUX.md). On,
  // only the active pane's first-level row stays expanded; off evens the rows
  // back out.
  const handleToggleCollapsible = () => {
    if (!target) return;
    send({
      type: 'SEND_TMUX_COMMAND',
      command: collapsible
        ? `set-option -u -w -t ${target.id} @tmuxy-collapsible`
        : `set-option -w -t ${target.id} @tmuxy-collapsible 1`,
    });
    onClose();
  };

  // Renaming happens in the tab itself — the strip owns the field, because
  // that is where the name is. A prompt at the bottom of the window asked you
  // to type a new name a long way from the thing being named.
  const handleRenameSpecificTab = () => {
    onRename();
    onClose();
  };

  return (
    <FloatingMenu
      // One floating surface at a time: opening this puts away the tab preview
      // it is replacing, and any other menu (components/floating).
      id="tab-context-menu"
      label="Tab"
      // Where the card was, when there was one: the menu is that card becoming
      // something else, so it belongs under the tab rather than at the pointer.
      anchor={anchorEl ? { kind: 'element', element: anchorEl } : { kind: 'point', x, y }}
      placement={anchorEl ? { align: 'center' } : undefined}
      morphFrom={morphFrom}
      onClose={onClose}
    >
      <MenuItem onClick={() => handleAction('tab-new')}>
        New Tab
        <KeyLabel keybindings={keybindings} command="new-window" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => handleAction('tab-next')} disabled={isSingleWindow}>
        Next Tab
        <KeyLabel keybindings={keybindings} command="next-window" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('tab-previous')} disabled={isSingleWindow}>
        Previous Tab
        <KeyLabel keybindings={keybindings} command="previous-window" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('tab-last')} disabled={isSingleWindow}>
        Last Tab
        <KeyLabel keybindings={keybindings} command="last-window" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={handleToggleCollapsible}>
        Toggle stacked Panes
        <KeyLabel keybindings={keybindings} command="tmuxy-stack-toggle" />
      </MenuItem>

      <MenuItem onClick={handleRenameSpecificTab}>
        Rename Tab
        <KeyLabel
          keybindings={keybindings}
          command={'command-prompt -I "#W" "rename-window -- \'%%\'"'}
        />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={handleCloseSpecificTab}>
        Close Tab
        <KeyLabel keybindings={keybindings} command="kill-window" />
      </MenuItem>
    </FloatingMenu>
  );
}
