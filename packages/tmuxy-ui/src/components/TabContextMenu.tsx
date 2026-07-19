/**
 * TabContextMenu - Right-click context menu for tab (window) operations.
 *
 * Extracted from WindowTabs so the sidebar tree's tab rows get the identical
 * menu. Follows PaneContextMenu's pattern: always `state="open"`, mounted only
 * while visible by the caller, positioned at an anchor point.
 */

import { ControlledMenu, MenuItem, MenuDivider } from '@szhsin/react-menu';
import '@szhsin/react-menu/dist/index.css';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  selectKeyBindings,
  selectWindows,
} from '../machines/AppContext';
import { executeMenuAction } from './menus/menuActions';
import { KeyLabel } from './menus/KeyLabel';
import './menus/AppMenu.css';

interface TabContextMenuProps {
  /** tmux window index the actions target (Close/Rename operate on this tab). */
  windowIndex: number;
  x: number;
  y: number;
  onClose: () => void;
}

export function TabContextMenu({ windowIndex, x, y, onClose }: TabContextMenuProps) {
  const send = useAppSend();
  const keybindings = useAppSelector(selectKeyBindings);
  const allWindows = useAppSelectorShallow(selectWindows);
  const isSingleWindow = allWindows.filter((w) => w.windowType === 'tab').length <= 1;

  const handleAction = (actionId: string) => {
    executeMenuAction(send, actionId);
    onClose();
  };

  const handleCloseSpecificTab = () => {
    send({ type: 'SEND_COMMAND', command: `kill-window -t :${windowIndex}` });
    onClose();
  };

  const handleRenameSpecificTab = () => {
    // Select the window first, then prompt rename
    send({ type: 'SEND_COMMAND', command: `select-window -t ${windowIndex}` });
    setTimeout(() => {
      send({
        type: 'SEND_COMMAND',
        command: 'command-prompt -I "#W" "rename-window -- \'%%\'"',
      });
    }, 50);
    onClose();
  };

  return (
    <ControlledMenu state="open" anchorPoint={{ x, y }} onClose={onClose} transition={false}>
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
    </ControlledMenu>
  );
}
