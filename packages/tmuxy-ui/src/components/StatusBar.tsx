/**
 * StatusBar - Top bar with window tabs and tmux menu
 *
 * Uses hooks to access all state - no props needed.
 * Prefix/command mode is handled natively by tmux.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  useAppSend,
} from '../machines/AppContext';
import { type TmuxMenuItem } from '../constants/menuItems';
import { TmuxMenu } from './TmuxMenu';
import { WindowTabs } from './WindowTabs';

export function StatusBar() {
  const send = useAppSend();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const handleMenuItemClick = useCallback(
    (item: TmuxMenuItem) => {
      setMenuOpen(false);
      if (item.command) {
        send({ type: 'SEND_COMMAND', command: item.command });
      }
    },
    [send]
  );

  return (
    <div className="statusbar">
      <WindowTabs />

      <div className="statusbar-actions">
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
    </div>
  );
}
