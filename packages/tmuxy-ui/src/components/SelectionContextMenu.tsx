/**
 * SelectionContextMenu - Right-click context menu for selected text.
 *
 * Two things to do with a selection: copy it, or type it into the pane.
 * Uses @szhsin/react-menu ControlledMenu (same pattern as PaneContextMenu).
 */

import { ControlledMenu, MenuItem } from '@szhsin/react-menu';
import '@szhsin/react-menu/dist/index.css';
import { useAppSend } from '../machines/AppContext';
import { escapeLiteralText } from '../tmux/keyBatching';
import { CopyIcon, SendKeysIcon } from './menus/MenuIcons';
import './menus/AppMenu.css';

interface SelectionContextMenuProps {
  paneId: string;
  x: number;
  y: number;
  selectedText: string;
  onClose: () => void;
}

export function SelectionContextMenu({
  paneId,
  x,
  y,
  selectedText,
  onClose,
}: SelectionContextMenuProps) {
  const send = useAppSend();

  // Either action is the end of the selection's job: the scrollback view (or
  // copy mode) closes with the menu.
  const exitAndClose = () => {
    send({ type: 'EXIT_COPY_MODE', paneId });
    onClose();
  };

  return (
    <ControlledMenu state="open" anchorPoint={{ x, y }} onClose={onClose} transition={false}>
      <MenuItem
        onClick={() => {
          navigator.clipboard.writeText(selectedText);
          exitAndClose();
        }}
      >
        <CopyIcon />
        Copy
      </MenuItem>
      <MenuItem
        onClick={() => {
          send({
            type: 'SEND_COMMAND',
            command: `send-keys -t ${paneId} -l ${escapeLiteralText(selectedText)}`,
          });
          exitAndClose();
        }}
      >
        <SendKeysIcon />
        Send keys
      </MenuItem>
    </ControlledMenu>
  );
}
