/**
 * PaneMenuItems - Shared pane menu items used by AppMenu, PaneContextMenu, and PaneHeader icon menu.
 */

import { MenuItem, MenuDivider } from '@szhsin/react-menu';
import type { KeyBindings } from '../../machines/types';
import { KeyLabel } from './KeyLabel';

interface PaneMenuItemsProps {
  keybindings: KeyBindings | null;
  isSinglePane: boolean;
  /** The pane these items act on is tmux's marked pane. */
  isMarked?: boolean;
  /** Some pane (possibly another one) is marked, so swap/join with it make sense. */
  hasMarked?: boolean;
  onAction: (actionId: string) => void;
}

export function PaneMenuItems({
  keybindings,
  isSinglePane,
  isMarked = false,
  hasMarked = false,
  onAction,
}: PaneMenuItemsProps) {
  return (
    <>
      <MenuItem onClick={() => onAction('pane-split-below')}>
        Split Pane Below
        <KeyLabel keybindings={keybindings} command="split-window -v" />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-split-right')}>
        Split Pane Right
        <KeyLabel keybindings={keybindings} command="split-window -h" />
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
      <MenuDivider />
      {isMarked ? (
        <MenuItem onClick={() => onAction('pane-unmark')}>
          Unmark Pane
          <KeyLabel keybindings={keybindings} command="select-pane -M" />
        </MenuItem>
      ) : (
        <MenuItem onClick={() => onAction('pane-mark')}>
          Mark Pane
          <KeyLabel keybindings={keybindings} command="select-pane -m" />
        </MenuItem>
      )}
      <MenuItem onClick={() => onAction('pane-swap-marked')} disabled={!hasMarked || isMarked}>
        Swap with Marked Pane
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-join-marked')} disabled={!hasMarked || isMarked}>
        Join Marked Pane Here
      </MenuItem>
      <MenuDivider />
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
