/**
 * PaneMenu - Dropdown menu for pane operations
 *
 * Can be used in two ways:
 * 1. With position prop: renders as a context menu at the given coordinates
 * 2. Without position prop: renders a button that opens a dropdown menu
 */

import { useState, useRef, useEffect } from 'react';
import { useAppSend } from '../machines/AppContext';

interface MenuItem {
  icon: string;
  label: string;
  shortcut: string;
  action: () => void;
  disabled?: boolean;
}

interface PaneMenuProps {
  paneId: string;
  isGrouped: boolean;
  /** When provided, renders as context menu at this position */
  position?: { x: number; y: number };
  /** Called when menu should close (required when position is provided) */
  onClose?: () => void;
}

export function PaneMenu({ paneId, isGrouped, position, onClose }: PaneMenuProps) {
  const send = useAppSend();
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Context menu mode: position is provided externally
  const isContextMenu = position !== undefined;
  const showMenu = isContextMenu || isOpen;

  // Close menu when clicking outside
  useEffect(() => {
    if (!showMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        if (isContextMenu && onClose) {
          onClose();
        } else {
          setIsOpen(false);
        }
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isContextMenu && onClose) {
          onClose();
        } else {
          setIsOpen(false);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showMenu, isContextMenu, onClose]);

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPosition({ top: rect.bottom, left: rect.left });
    }
    setIsOpen(!isOpen);
  };

  const handleAction = (action: () => void) => {
    action();
    if (isContextMenu && onClose) {
      onClose();
    } else {
      setIsOpen(false);
    }
  };

  const menuItems: MenuItem[] = [
    {
      icon: '⊟',
      label: 'Split below',
      shortcut: 'prefix -',
      action: () => {
        send({ type: 'FOCUS_PANE', paneId });
        send({ type: 'SEND_COMMAND', command: 'split-window -v' });
      },
    },
    {
      icon: '◫',
      label: 'Split right',
      shortcut: 'prefix |',
      action: () => {
        send({ type: 'FOCUS_PANE', paneId });
        send({ type: 'SEND_COMMAND', command: 'split-window -h' });
      },
    },
    { icon: '', label: '', shortcut: '', action: () => {}, disabled: true }, // separator
    {
      icon: '⤢',
      label: 'Zoom toggle',
      shortcut: 'prefix z',
      action: () => {
        send({ type: 'FOCUS_PANE', paneId });
        send({ type: 'SEND_COMMAND', command: 'resize-pane -Z' });
      },
    },
    {
      icon: '↗',
      label: 'Move to new window',
      shortcut: 'prefix !',
      action: () => {
        send({ type: 'FOCUS_PANE', paneId });
        send({ type: 'SEND_COMMAND', command: 'break-pane' });
      },
    },
    { icon: '', label: '', shortcut: '', action: () => {}, disabled: true }, // separator
    {
      icon: '⊕',
      label: 'Add pane to group',
      shortcut: '',
      action: () => {
        send({ type: 'SEND_TMUX_COMMAND', command: 'tmuxy-pane-group-add' });
      },
    },
    {
      icon: '↔',
      label: 'Break out of group',
      shortcut: '',
      action: () => {
        send({ type: 'SEND_TMUX_COMMAND', command: `run-shell "/workspace/scripts/tmuxy/pane-group-close.sh ${paneId}"` });
      },
      disabled: !isGrouped,
    },
    { icon: '', label: '', shortcut: '', action: () => {}, disabled: true }, // separator
    {
      icon: '✕',
      label: 'Close pane',
      shortcut: 'prefix x',
      action: () => {
        send({ type: 'FOCUS_PANE', paneId });
        send({ type: 'SEND_COMMAND', command: 'kill-pane' });
      },
    },
  ];

  // Context menu mode - render menu directly at position
  if (isContextMenu) {
    return (
      <div
        ref={menuRef}
        className="pane-menu"
        role="menu"
        style={{ top: position.y, left: position.x }}
      >
        {menuItems.map((item, index) => {
          if (!item.label) {
            return <div key={index} className="pane-menu-separator" role="separator" />;
          }
          return (
            <button
              key={index}
              className={`pane-menu-item ${item.disabled ? 'pane-menu-item-disabled' : ''}`}
              onClick={() => !item.disabled && handleAction(item.action)}
              disabled={item.disabled}
              role="menuitem"
            >
              <span className="pane-menu-icon">{item.icon}</span>
              <span className="pane-menu-label">{item.label}</span>
              {item.shortcut && <span className="pane-menu-shortcut">{item.shortcut}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  // Button mode - render button with dropdown
  return (
    <div className="pane-menu-container">
      <button
        ref={buttonRef}
        className="pane-menu-button"
        onClick={handleToggle}
        title="Pane menu"
        aria-label="Pane menu"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        •
      </button>
      {isOpen && (
        <div
          ref={menuRef}
          className="pane-menu"
          role="menu"
          style={{ top: menuPosition.top, left: menuPosition.left }}
        >
          {menuItems.map((item, index) => {
            if (!item.label) {
              return <div key={index} className="pane-menu-separator" role="separator" />;
            }
            return (
              <button
                key={index}
                className={`pane-menu-item ${item.disabled ? 'pane-menu-item-disabled' : ''}`}
                onClick={() => !item.disabled && handleAction(item.action)}
                disabled={item.disabled}
                role="menuitem"
              >
                <span className="pane-menu-icon">{item.icon}</span>
                <span className="pane-menu-label">{item.label}</span>
                {item.shortcut && <span className="pane-menu-shortcut">{item.shortcut}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
