/**
 * PaneContextMenu - Right-click context menu for pane operations
 *
 * Uses @szhsin/react-menu ControlledMenu with anchor point positioning.
 */

import { ControlledMenu, MenuItem, MenuDivider } from '@szhsin/react-menu';
import '@szhsin/react-menu/dist/index.css';
import {
  useAppSend,
  useAppSelector,
  selectKeyBindings,
  selectVisiblePanes,
} from '../machines/AppContext';
import { getKeybindingLabel } from './menus/keybindingLabel';
import { executeMenuAction } from './menus/menuActions';
import type { KeyBindings } from '../machines/types';
import './menus/AppMenu.css';

interface PaneContextMenuProps {
  paneId: string;
  x: number;
  y: number;
  onClose: () => void;
}

function KeyLabel({ keybindings, command }: { keybindings: KeyBindings | null; command: string }) {
  const label = getKeybindingLabel(keybindings, command);
  if (!label) return null;
  return <span className="menu-keybinding">{label}</span>;
}

export function PaneContextMenu({ paneId, x, y, onClose }: PaneContextMenuProps) {
  const send = useAppSend();
  const keybindings = useAppSelector(selectKeyBindings);
  const visiblePanes = useAppSelector(selectVisiblePanes);
  const isSinglePane = visiblePanes.length <= 1;

  const handleAction = (actionId: string) => {
    send({ type: 'FOCUS_PANE', paneId });
    executeMenuAction(send, actionId);
    onClose();
  };

  return (
    <ControlledMenu state="open" anchorPoint={{ x, y }} onClose={onClose} transition={false}>
      <MenuItem onClick={() => handleAction('pane-split-below')}>
        New Pane Below
        <KeyLabel keybindings={keybindings} command="split-window -v" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('pane-split-right')}>
        New Pane Right
        <KeyLabel keybindings={keybindings} command="split-window -h" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => handleAction('pane-navigate-up')} disabled={isSinglePane}>
        Navigate Up
        <KeyLabel keybindings={keybindings} command="select-pane -U" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('pane-navigate-down')} disabled={isSinglePane}>
        Navigate Down
        <KeyLabel keybindings={keybindings} command="select-pane -D" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('pane-navigate-left')} disabled={isSinglePane}>
        Navigate Left
        <KeyLabel keybindings={keybindings} command="select-pane -L" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('pane-navigate-right')} disabled={isSinglePane}>
        Navigate Right
        <KeyLabel keybindings={keybindings} command="select-pane -R" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => handleAction('pane-swap-prev')} disabled={isSinglePane}>
        Swap with Previous
        <KeyLabel keybindings={keybindings} command="swap-pane -U" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('pane-swap-next')} disabled={isSinglePane}>
        Swap with Next
        <KeyLabel keybindings={keybindings} command="swap-pane -D" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('pane-move-new-tab')}>
        Move to New Tab
        <KeyLabel keybindings={keybindings} command="break-pane" />
      </MenuItem>
      <MenuItem
        onClick={() => {
          send({
            type: 'SEND_TMUX_COMMAND',
            command:
              'run-shell "scripts/tmuxy/pane-group-add.sh #{pane_id} #{pane_width} #{pane_height}"',
          });
          onClose();
        }}
      >
        Add Pane to Group
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => handleAction('pane-copy-mode')}>
        Copy Mode
        <KeyLabel keybindings={keybindings} command="copy-mode" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('pane-paste')}>
        Paste
        <KeyLabel keybindings={keybindings} command="paste-buffer" />
      </MenuItem>
      <MenuItem onClick={() => handleAction('pane-clear')}>Clear Screen</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => handleAction('view-zoom')}>
        Zoom Pane
        <KeyLabel keybindings={keybindings} command="resize-pane -Z" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => handleAction('pane-close')}>
        Close Pane
        <KeyLabel keybindings={keybindings} command="kill-pane" />
      </MenuItem>
    </ControlledMenu>
  );
}
