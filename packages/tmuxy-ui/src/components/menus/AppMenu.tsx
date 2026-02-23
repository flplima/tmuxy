/**
 * AppMenu - Application-level hamburger menu with submenus
 *
 * Uses @szhsin/react-menu for menu rendering.
 * 5 submenus: Pane, Tab, Session, View, Help
 * Keybinding labels are derived from server-provided keybindings.
 *
 * TODO: Add native Tauri menu integration (useNativeMenu). For now, always show
 * the web-based hamburger menu even in Tauri.
 */

import { Menu, MenuItem, SubMenu, MenuDivider } from '@szhsin/react-menu';
import '@szhsin/react-menu/dist/index.css';
import {
  useAppSend,
  useAppSelector,
  selectKeyBindings,
  selectVisiblePanes,
  selectWindows,
} from '../../machines/AppContext';
import { getKeybindingLabel } from './keybindingLabel';
import { executeMenuAction } from './menuActions';
import type { KeyBindings } from '../../machines/types';
import './AppMenu.css';

/** Whether to use native Tauri menu (always false for now) */
export const useNativeMenu = false;

function KeyLabel({ keybindings, command }: { keybindings: KeyBindings | null; command: string }) {
  const label = getKeybindingLabel(keybindings, command);
  if (!label) return null;
  return <span className="menu-keybinding">{label}</span>;
}

export function AppMenu() {
  const send = useAppSend();
  const keybindings = useAppSelector(selectKeyBindings);
  const visiblePanes = useAppSelector(selectVisiblePanes);
  const windows = useAppSelector(selectWindows);

  const isSinglePane = visiblePanes.length <= 1;
  const isSingleWindow =
    windows.filter((w) => !w.isPaneGroupWindow && !w.isFloatWindow).length <= 1;

  const handleAction = (actionId: string) => {
    executeMenuAction(send, actionId);
  };

  const menuButton = (
    <button className="app-menu-button" aria-label="Menu">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <rect x="2" y="3" width="12" height="1.5" rx="0.5" />
        <rect x="2" y="7.25" width="12" height="1.5" rx="0.5" />
        <rect x="2" y="11.5" width="12" height="1.5" rx="0.5" />
      </svg>
    </button>
  );

  return (
    <Menu menuButton={menuButton} transition={false}>
      <SubMenu label="Pane">
        <MenuItem onClick={() => handleAction('pane-split-below')}>
          New Pane Below
          <KeyLabel keybindings={keybindings} command="split-window -v" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-split-right')}>
          New Pane Right
          <KeyLabel keybindings={keybindings} command="split-window -h" />
        </MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('pane-navigate-up')} disabled={isSinglePane}>
          Navigate Up
          <KeyLabel keybindings={keybindings} command="select-pane -U" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-navigate-down')} disabled={isSinglePane}>
          Navigate Down
          <KeyLabel keybindings={keybindings} command="select-pane -D" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-navigate-left')} disabled={isSinglePane}>
          Navigate Left
          <KeyLabel keybindings={keybindings} command="select-pane -L" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-navigate-right')} disabled={isSinglePane}>
          Navigate Right
          <KeyLabel keybindings={keybindings} command="select-pane -R" />
        </MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('pane-next')} disabled={isSinglePane}>
          Next Pane
          <KeyLabel keybindings={keybindings} command="select-pane -t :.+" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-previous')} disabled={isSinglePane}>
          Previous Pane
          <KeyLabel keybindings={keybindings} command="last-pane" />
        </MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('pane-swap-prev')} disabled={isSinglePane}>
          Swap with Previous
          <KeyLabel keybindings={keybindings} command="swap-pane -U" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-swap-next')} disabled={isSinglePane}>
          Swap with Next
          <KeyLabel keybindings={keybindings} command="swap-pane -D" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-move-new-tab')}>
          Move to New Tab
          <KeyLabel keybindings={keybindings} command="break-pane" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-add-to-group')}>Add Pane to Group</MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('pane-copy-mode')}>
          Copy Mode
          <KeyLabel keybindings={keybindings} command="copy-mode" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-paste')}>
          Paste
          <KeyLabel keybindings={keybindings} command="paste-buffer" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('pane-clear')}>Clear Screen</MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('pane-close')}>
          Close Pane
          <KeyLabel keybindings={keybindings} command="kill-pane" />
        </MenuItem>
      </SubMenu>

      <SubMenu label="Tab">
        <MenuItem onClick={() => handleAction('tab-new')}>
          New Tab
          <KeyLabel keybindings={keybindings} command="new-window" />
        </MenuItem>
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
        <MenuItem onClick={() => handleAction('tab-rename')}>
          Rename Tab
          <KeyLabel
            keybindings={keybindings}
            command={'command-prompt -I "#W" "rename-window -- \'%%\'"'}
          />
        </MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('tab-close')}>
          Close Tab
          <KeyLabel keybindings={keybindings} command="kill-window" />
        </MenuItem>
      </SubMenu>

      <SubMenu label="Session">
        <MenuItem onClick={() => handleAction('session-new')}>New Session</MenuItem>
        <MenuItem onClick={() => handleAction('session-rename')}>
          Rename Session
          <KeyLabel
            keybindings={keybindings}
            command={'command-prompt -I "#S" "rename-session -- \'%%\'"'}
          />
        </MenuItem>
        <MenuItem onClick={() => handleAction('session-detach')}>
          Detach Session
          <KeyLabel keybindings={keybindings} command="detach-client" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('session-kill')}>Kill Session</MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('session-reload-config')}>Reload Config</MenuItem>
      </SubMenu>

      <SubMenu label="View">
        <MenuItem onClick={() => handleAction('view-zoom')}>
          Zoom Pane
          <KeyLabel keybindings={keybindings} command="resize-pane -Z" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('view-next-layout')}>
          Next Layout
          <KeyLabel keybindings={keybindings} command="next-layout" />
        </MenuItem>
      </SubMenu>

      <SubMenu label="Help">
        <MenuItem onClick={() => handleAction('help-keybindings')}>
          Show Key Bindings
          <KeyLabel keybindings={keybindings} command="list-keys" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('help-github')}>
          Tmuxy on GitHub<span className="menu-external">{'\u2197'}</span>
        </MenuItem>
      </SubMenu>
    </Menu>
  );
}
