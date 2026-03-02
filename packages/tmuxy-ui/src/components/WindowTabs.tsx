/**
 * WindowTabs - Displays tmux window tabs in the status bar
 *
 * Plain text tab names: light gray for inactive, green for active.
 * Right-click opens a context menu with tab operations.
 */

import { useMemo, useCallback, useState } from 'react';
import { ControlledMenu, MenuItem, MenuDivider } from '@szhsin/react-menu';
import {
  useAppSend,
  useAppSelectorShallow,
  useAppSelector,
  selectVisibleWindows,
  selectWindows,
  selectKeyBindings,
} from '../machines/AppContext';
import { executeMenuAction } from './menus/menuActions';
import { getKeybindingLabel } from './menus/keybindingLabel';
import type { KeyBindings } from '../machines/types';

function KeyLabel({ keybindings, command }: { keybindings: KeyBindings | null; command: string }) {
  const label = getKeybindingLabel(keybindings, command);
  if (!label) return null;
  return <span className="menu-keybinding">{label}</span>;
}

interface TabContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  windowIndex: number;
}

export function WindowTabs() {
  const send = useAppSend();
  const rawWindows = useAppSelectorShallow(selectVisibleWindows);
  const allWindows = useAppSelector(selectWindows);
  const keybindings = useAppSelector(selectKeyBindings);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    windowIndex: 0,
  });

  // Dedup safety net: ensure no duplicate window IDs reach the DOM
  const visibleWindows = useMemo(
    () => [...new Map(rawWindows.map((w) => [w.id, w])).values()],
    [rawWindows],
  );

  const isSingleWindow =
    allWindows.filter((w) => !w.isPaneGroupWindow && !w.isFloatWindow).length <= 1;

  const handleWindowClick = useCallback(
    (windowIndex: number) => {
      send({ type: 'SEND_COMMAND', command: `select-window -t ${windowIndex}` });
    },
    [send],
  );

  const handleNewWindow = useCallback(() => {
    send({ type: 'SEND_COMMAND', command: 'new-window' });
  }, [send]);

  const handleContextMenu = useCallback((e: React.MouseEvent, windowIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, windowIndex });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const handleAction = useCallback(
    (actionId: string) => {
      executeMenuAction(send, actionId);
      closeContextMenu();
    },
    [send, closeContextMenu],
  );

  const handleCloseSpecificTab = useCallback(() => {
    send({
      type: 'SEND_COMMAND',
      command: `kill-window -t :${contextMenu.windowIndex}`,
    });
    closeContextMenu();
  }, [send, contextMenu.windowIndex, closeContextMenu]);

  const handleRenameSpecificTab = useCallback(() => {
    // Select the window first, then prompt rename
    send({
      type: 'SEND_COMMAND',
      command: `select-window -t ${contextMenu.windowIndex}`,
    });
    setTimeout(() => {
      send({
        type: 'SEND_COMMAND',
        command: 'command-prompt -I "#W" "rename-window -- \'%%\'"',
      });
    }, 50);
    closeContextMenu();
  }, [send, contextMenu.windowIndex, closeContextMenu]);

  return (
    <div className="tab-list">
      {visibleWindows.map((window) => (
        <span
          key={window.id}
          className={`tab-name ${window.active ? 'tab-name-active' : ''}`}
          onClick={() => handleWindowClick(window.index)}
          onContextMenu={(e) => handleContextMenu(e, window.index)}
          role="tab"
          aria-selected={window.active}
          aria-label={`Tab ${window.index}: ${window.name}${window.active ? ' (active)' : ''}`}
        >
          {window.name || `Tab ${window.index}`}
        </span>
      ))}
      <button
        className="tab-add"
        onClick={handleNewWindow}
        title="New tab"
        aria-label="Create new tab"
      >
        +
      </button>

      <ControlledMenu
        state={contextMenu.visible ? 'open' : 'closed'}
        anchorPoint={{ x: contextMenu.x, y: contextMenu.y }}
        onClose={closeContextMenu}
        transition={false}
      >
        <MenuItem onClick={() => handleAction('tab-new')}>
          New Tab
          <KeyLabel keybindings={keybindings} command="new-window" />
        </MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('tab-next')} disabled={isSingleWindow}>
          Next Tab
          <KeyLabel keybindings={keybindings} command="next-window" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('tab-previous')} disabled={isSingleWindow}>
          Previous Tab
          <KeyLabel keybindings={keybindings} command="previous-window" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('tab-last')} disabled={isSingleWindow}>
          Last Tab
          <KeyLabel keybindings={keybindings} command="last-window" />
        </MenuItem>
        <MenuDivider />
        <MenuItem onClick={handleRenameSpecificTab}>
          Rename Tab
          <KeyLabel
            keybindings={keybindings}
            command={'command-prompt -I "#W" "rename-window -- \'%%\'"'}
          />
        </MenuItem>
        <MenuDivider />
        <MenuItem onClick={handleCloseSpecificTab}>
          Close Tab
          <KeyLabel keybindings={keybindings} command="kill-window" />
        </MenuItem>
      </ControlledMenu>
    </div>
  );
}
