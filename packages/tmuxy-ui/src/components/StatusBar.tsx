/**
 * StatusBar - Top bar with window tabs and tmux menu
 *
 * Uses hooks to access all state - no props needed.
 * Prefix/command mode is handled natively by tmux.
 */

import { useState, useRef, useCallback } from 'react';
import {
  useAppSend,
} from '../machines/AppContext';
import { PREFIX_BINDINGS, type TmuxMenuItem } from '../constants/menuItems';
import { useClickOutside } from '../hooks';
import { TmuxMenu } from './TmuxMenu';
import { WindowTabs } from './WindowTabs';
import { FilePicker, FilePickerButton } from './FilePicker';

export function StatusBar() {
  const send = useAppSend();

  const [menuOpen, setMenuOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  const handleCloseMenu = useCallback(() => setMenuOpen(false), []);
  useClickOutside(menuRef, handleCloseMenu, menuOpen);

  const handleMenuItemClick = useCallback(
    (item: TmuxMenuItem) => {
      setMenuOpen(false);
      const command = PREFIX_BINDINGS[item.key];
      if (command) {
        send({ type: 'SEND_COMMAND', command });
      }
    },
    [send]
  );

  const toggleFilePicker = useCallback(() => {
    setFilePickerOpen((open) => !open);
  }, []);

  const closeFilePicker = useCallback(() => {
    setFilePickerOpen(false);
  }, []);

  return (
    <div className="statusbar">
      <WindowTabs />

      <div className="statusbar-actions">
        <FilePickerButton onClick={toggleFilePicker} isOpen={filePickerOpen} />

        <div className="tmux-button-container" ref={menuRef}>
          <button
            className={`tmux-button ${menuOpen ? 'tmux-button-active' : ''}`}
            onClick={() => setMenuOpen(!menuOpen)}
            title="Tmux commands (Ctrl+a)"
            aria-label="Open tmux menu"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <i className="fa-solid fa-terminal"></i>
            <span className="tmux-button-label">tmux</span>
          </button>

          {menuOpen && <TmuxMenu onItemClick={handleMenuItemClick} />}
        </div>
      </div>

      <FilePicker isOpen={filePickerOpen} onClose={closeFilePicker} rootPath="/" />
    </div>
  );
}
