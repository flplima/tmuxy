/**
 * PaneMenuItems - Shared pane menu items used by AppMenu, PaneContextMenu, and PaneHeader icon menu.
 */

import { MenuItem, MenuDivider } from '@szhsin/react-menu';
import { getKeybindingLabel } from './keybindingLabel';
import type { KeyBindings } from '../../machines/types';

function KeyLabel({ keybindings, command }: { keybindings: KeyBindings | null; command: string }) {
  const label = getKeybindingLabel(keybindings, command);
  if (!label) return null;
  return <span className="menu-keybinding">{label}</span>;
}

interface PaneMenuItemsProps {
  keybindings: KeyBindings | null;
  isSinglePane: boolean;
  onAction: (actionId: string) => void;
}

export function PaneMenuItems({ keybindings, isSinglePane, onAction }: PaneMenuItemsProps) {
  return (
    <>
      <MenuItem onClick={() => onAction('pane-split-below')}>
        New Pane Below
        <KeyLabel keybindings={keybindings} command="split-window -v" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-split-right')}>
        New Pane Right
        <KeyLabel keybindings={keybindings} command="split-window -h" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-navigate-up')} disabled={isSinglePane}>
        Navigate Up
        <KeyLabel keybindings={keybindings} command="select-pane -U" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-navigate-down')} disabled={isSinglePane}>
        Navigate Down
        <KeyLabel keybindings={keybindings} command="select-pane -D" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-navigate-left')} disabled={isSinglePane}>
        Navigate Left
        <KeyLabel keybindings={keybindings} command="select-pane -L" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-navigate-right')} disabled={isSinglePane}>
        Navigate Right
        <KeyLabel keybindings={keybindings} command="select-pane -R" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-next')} disabled={isSinglePane}>
        Next Pane
        <KeyLabel keybindings={keybindings} command="select-pane -t :.+" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-previous')} disabled={isSinglePane}>
        Previous Pane
        <KeyLabel keybindings={keybindings} command="last-pane" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-swap-prev')} disabled={isSinglePane}>
        Swap with Previous
        <KeyLabel keybindings={keybindings} command="swap-pane -U" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-swap-next')} disabled={isSinglePane}>
        Swap with Next
        <KeyLabel keybindings={keybindings} command="swap-pane -D" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-move-new-tab')}>
        Move to New Tab
        <KeyLabel keybindings={keybindings} command="break-pane" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-add-to-group')}>Add Pane to Group</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-copy-mode')}>
        Copy Mode
        <KeyLabel keybindings={keybindings} command="copy-mode" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-paste')}>
        Paste
        <KeyLabel keybindings={keybindings} command="paste-buffer" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-clear')}>Clear Screen</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('view-zoom')}>
        Zoom Pane
        <KeyLabel keybindings={keybindings} command="resize-pane -Z" />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-close')}>
        Close Pane
        <KeyLabel keybindings={keybindings} command="kill-pane" />
      </MenuItem>
    </>
  );
}
