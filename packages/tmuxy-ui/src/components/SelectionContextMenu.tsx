/**
 * SelectionContextMenu - Right-click context menu for selected text.
 *
 * Appears on right-click with Copy, Search Google, and Ask ChatGPT actions.
 * Uses @szhsin/react-menu ControlledMenu (same pattern as PaneContextMenu).
 */

import { ControlledMenu, MenuItem } from '@szhsin/react-menu';
import '@szhsin/react-menu/dist/index.css';
import { useAppSend } from '../machines/AppContext';
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
        Copy
      </MenuItem>
      <MenuItem
        onClick={() => {
          window.open(
            'https://www.google.com/search?q=' + encodeURIComponent(selectedText),
            '_blank',
          );
          exitAndClose();
        }}
      >
        Search Google
      </MenuItem>
      <MenuItem
        onClick={() => {
          window.open('https://chatgpt.com/?q=' + encodeURIComponent(selectedText), '_blank');
          exitAndClose();
        }}
      >
        Ask ChatGPT
      </MenuItem>
    </ControlledMenu>
  );
}
