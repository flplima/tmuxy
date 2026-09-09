/**
 * SelectionContextMenu - Right-click context menu for selected text.
 *
 * Two things to do with a selection: copy it, or type it into the pane.
 * Uses @szhsin/react-menu ControlledMenu (same pattern as PaneContextMenu).
 */

import { useEffect } from 'react';
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
  /** The browser's selection the menu is about, kept on screen while it is up. */
  selectionRange?: Range | null;
  onClose: () => void;
}

/**
 * Pin the browser's selection to `range` for as long as the menu is mounted.
 *
 * The menu takes focus when it opens and every item takes it on hover, and
 * WebKit collapses the document selection whenever focus moves — Chrome
 * leaves it alone — so on the desktop the text the user had just
 * right-clicked vanished under the menu that was about it. The range comes
 * from the right-click itself (reading the selection here would be too
 * late: the menu has focus before this effect runs), and whenever the
 * selection collapses while the menu is up, it is put back.
 */
function useSelectionPinned(range: Range | null): void {
  useEffect(() => {
    if (!range || range.collapsed || typeof window === 'undefined') return;
    const restore = () => {
      const current = window.getSelection();
      if (!current || (current.rangeCount > 0 && !current.isCollapsed)) return;
      current.removeAllRanges();
      current.addRange(range);
    };
    restore();
    document.addEventListener('selectionchange', restore);
    return () => document.removeEventListener('selectionchange', restore);
  }, [range]);
}

export function SelectionContextMenu({
  paneId,
  x,
  y,
  selectedText,
  selectionRange = null,
  onClose,
}: SelectionContextMenuProps) {
  const send = useAppSend();
  useSelectionPinned(selectionRange);

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
