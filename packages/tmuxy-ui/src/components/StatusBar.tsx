import { useState, useRef, useEffect } from 'react';
import { useAppSend, useAppSelector, selectCommandInput } from '../machines/AppContext';
import type { TmuxWindow } from '../machines/types';
import './StatusBar.css';

interface TmuxMenuItem {
  label: string;
  icon: string;
  key: string;
  description: string;
}

// Fallback menu items
const DEFAULT_MENU_ITEMS: TmuxMenuItem[] = [
  {
    label: 'Split Horizontal',
    icon: 'fa-arrows-left-right-to-line',
    key: '"',
    description: 'Split pane horizontally',
  },
  {
    label: 'Split Vertical',
    icon: 'fa-arrows-up-to-line',
    key: '%',
    description: 'Split pane vertically',
  },
  {
    label: 'Toggle Fullscreen',
    icon: 'fa-expand',
    key: 'z',
    description: 'Toggle pane fullscreen',
  },
  {
    label: 'Last Active Pane',
    icon: 'fa-arrow-right-arrow-left',
    key: ';',
    description: 'Switch to last active pane',
  },
  {
    label: 'Toggle Layout',
    icon: 'fa-table-columns',
    key: 'Space',
    description: 'Cycle through pane layouts',
  },
  {
    label: 'Pane to Window',
    icon: 'fa-window-restore',
    key: '!',
    description: 'Convert pane to window',
  },
  {
    label: 'Copy Mode',
    icon: 'fa-copy',
    key: '[',
    description: 'Enter copy mode',
  },
  {
    label: 'Command Mode',
    icon: 'fa-terminal',
    key: ':',
    description: 'Enter command mode',
  },
];

// Map menu keys to tmux commands
const PREFIX_BINDINGS: Record<string, string> = {
  '"': 'split-window -v',
  '%': 'split-window -h',
  z: 'resize-pane -Z',
  ';': 'last-pane',
  Space: 'next-layout',
  '!': 'break-pane',
  '[': 'copy-mode',
  ':': '', // Command mode is handled specially
};

interface StatusBarProps {
  windows: TmuxWindow[];
  commandMode: boolean;
  prefixMode: boolean;
  isDraggingToNewWindow: boolean;
  onTmuxMenuAction?: (key: string) => void;
}

export function StatusBar({
  windows,
  commandMode,
  prefixMode,
  isDraggingToNewWindow,
  onTmuxMenuAction,
}: StatusBarProps) {
  const send = useAppSend();
  // Command input state from machine (single source of truth)
  const commandInput = useAppSelector(selectCommandInput);

  const [hoveredWindow, setHoveredWindow] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Filter out stack windows (they are hidden and managed separately)
  const visibleWindows = windows.filter((w) => !w.isStackWindow);
  const hasMultipleWindows = visibleWindows.length > 1;
  const prefixKey = 'C-a';

  useEffect(() => {
    if (commandMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [commandMode]);

  // Close menu when any key is pressed or clicking outside
  useEffect(() => {
    if (!menuOpen) return;

    const handleKeyDown = () => setMenuOpen(false);
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [menuOpen]);

  const handleWindowClick = (windowIndex: number) => {
    send({ type: 'SEND_COMMAND', command: `select-window -t ${windowIndex}` });
  };

  const handleCloseWindow = (e: React.MouseEvent, windowIndex: number) => {
    e.stopPropagation();
    send({ type: 'SEND_COMMAND', command: `select-window -t ${windowIndex}` });
    send({ type: 'SEND_COMMAND', command: 'kill-window' });
  };

  const handleNewWindow = () => {
    send({ type: 'SEND_COMMAND', command: 'new-window' });
  };

  const handleCommandKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send({ type: 'COMMAND_SUBMIT' });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      send({ type: 'COMMAND_MODE_EXIT' });
    }
  };

  const handleCommandChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    send({ type: 'COMMAND_INPUT', value: e.target.value });
  };

  const handleBlur = () => {
    // Small delay to allow Enter key to fire first
    setTimeout(() => {
      if (commandMode) {
        send({ type: 'COMMAND_MODE_EXIT' });
      }
    }, 100);
  };

  const handleTmuxButtonClick = () => {
    setMenuOpen(!menuOpen);
  };

  const handleMenuItemClick = (item: TmuxMenuItem) => {
    setMenuOpen(false);
    if (onTmuxMenuAction) {
      onTmuxMenuAction(item.key);
    } else if (item.key === ':') {
      // Enter command mode
      send({ type: 'COMMAND_MODE_ENTER' });
    } else {
      // Execute the prefix binding
      const command = PREFIX_BINDINGS[item.key];
      if (command) {
        send({ type: 'SEND_COMMAND', command });
      }
    }
  };

  if (commandMode) {
    return (
      <div className="statusbar statusbar-command">
        <span className="command-prefix">:</span>
        <input
          ref={inputRef}
          type="text"
          className="command-input"
          value={commandInput}
          onChange={handleCommandChange}
          onKeyDown={handleCommandKeyDown}
          onBlur={handleBlur}
          placeholder="tmux command..."
        />
      </div>
    );
  }

  return (
    <div className={`statusbar ${prefixMode ? 'statusbar-prefix' : ''}`}>
      <div className="window-tabs">
        {visibleWindows.map((window) => (
          <div
            key={window.index}
            className={`window-tab ${window.active ? 'window-tab-active' : ''}`}
            onClick={() => handleWindowClick(window.index)}
            onMouseEnter={() => setHoveredWindow(window.index)}
            onMouseLeave={() => setHoveredWindow(null)}
            role="button"
            tabIndex={0}
            aria-label={`Window ${window.index}: ${window.name}${window.active ? ' (active)' : ''}`}
            aria-pressed={window.active}
          >
            <span className="window-index">{window.index}</span>
            <span className="window-name">{window.name}</span>
            {hasMultipleWindows && hoveredWindow === window.index && (
              <button
                className="window-close"
                onClick={(e) => handleCloseWindow(e, window.index)}
                title="Close window"
                aria-label={`Close window ${window.index}`}
              >
                &times;
              </button>
            )}
          </div>
        ))}
        {isDraggingToNewWindow ? (
          <div className="window-tab window-tab-placeholder">
            <span className="window-name">New Window</span>
          </div>
        ) : (
          <button
            className="window-new"
            onClick={handleNewWindow}
            title="New window"
            aria-label="Create new window"
          >
            +
          </button>
        )}
      </div>

      <div className="tmux-button-container" ref={menuRef}>
        <button
          className={`tmux-button ${prefixMode || menuOpen ? 'tmux-button-active' : ''}`}
          onClick={handleTmuxButtonClick}
          title="Tmux commands (Ctrl+a)"
          aria-label="Open tmux menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <i className="fa-solid fa-terminal"></i>
          <span className="tmux-button-label">tmux</span>
        </button>

        {menuOpen && (
          <div className="tmux-dropdown">
            <div className="tmux-dropdown-header">
              <span>Commands</span>
              <span className="tmux-dropdown-hint">{prefixKey} + key</span>
            </div>
            {DEFAULT_MENU_ITEMS.map((item) => (
              <button
                key={item.key}
                className="tmux-dropdown-item"
                onClick={() => handleMenuItemClick(item)}
                title={item.description}
              >
                <i className={`fa-solid ${item.icon}`}></i>
                <span className="tmux-dropdown-item-label">{item.label}</span>
                <span className="tmux-dropdown-item-key">{item.key}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
