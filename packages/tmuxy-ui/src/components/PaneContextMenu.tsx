/**
 * PaneContextMenu - Minimalist TUI-style context menu for pane operations
 *
 * Shows on right-click with operations and their tmux keymaps.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useAppSend } from '../machines/AppContext';
import './PaneContextMenu.css';

interface MenuItem {
  label: string;
  keymap: string;
  action: () => void;
  separator?: boolean;
}

interface PaneContextMenuProps {
  paneId: string;
  x: number;
  y: number;
  onClose: () => void;
}

export function PaneContextMenu({ paneId, x, y, onClose }: PaneContextMenuProps) {
  const send = useAppSend();
  const menuRef = useRef<HTMLDivElement>(null);

  const handleSplitHorizontal = useCallback(() => {
    send({ type: 'FOCUS_PANE', paneId });
    send({ type: 'SEND_COMMAND', command: 'split-window -v' });
    onClose();
  }, [send, paneId, onClose]);

  const handleSplitVertical = useCallback(() => {
    send({ type: 'FOCUS_PANE', paneId });
    send({ type: 'SEND_COMMAND', command: 'split-window -h' });
    onClose();
  }, [send, paneId, onClose]);

  const handleAddToGroup = useCallback(() => {
    send({ type: 'PANE_GROUP_ADD', paneId });
    onClose();
  }, [send, paneId, onClose]);

  const handleToggleZoom = useCallback(() => {
    send({ type: 'FOCUS_PANE', paneId });
    send({ type: 'SEND_COMMAND', command: 'resize-pane -Z' });
    onClose();
  }, [send, paneId, onClose]);

  const handleClosePane = useCallback(() => {
    send({ type: 'FOCUS_PANE', paneId });
    send({ type: 'SEND_COMMAND', command: 'kill-pane' });
    onClose();
  }, [send, paneId, onClose]);

  const menuItems: MenuItem[] = [
    { label: 'Split Horizontal', keymap: 'prefix "', action: handleSplitHorizontal },
    { label: 'Split Vertical', keymap: 'prefix %', action: handleSplitVertical },
    { label: 'Add to Group', keymap: '+', action: handleAddToGroup, separator: true },
    { label: 'Toggle Zoom', keymap: 'prefix z', action: handleToggleZoom },
    { label: 'Close Pane', keymap: 'prefix x', action: handleClosePane },
  ];

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (rect.right > viewportWidth) {
      menuRef.current.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > viewportHeight) {
      menuRef.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="pane-context-menu"
      style={{ left: x, top: y }}
    >
      <div className="pane-context-menu-border-top">┌────────────────────────────┐</div>
      {menuItems.map((item, index) => (
        <div key={item.label}>
          {item.separator && index > 0 && (
            <div className="pane-context-menu-separator">├────────────────────────────┤</div>
          )}
          <div
            className="pane-context-menu-item"
            onClick={item.action}
          >
            <span className="pane-context-menu-border">│</span>
            <span className="pane-context-menu-label">{item.label}</span>
            <span className="pane-context-menu-keymap">{item.keymap}</span>
            <span className="pane-context-menu-border">│</span>
          </div>
        </div>
      ))}
      <div className="pane-context-menu-border-bottom">└────────────────────────────┘</div>
    </div>
  );
}
