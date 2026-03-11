/**
 * AppMenu - Application-level hamburger menu with submenus
 *
 * Uses @szhsin/react-menu for menu rendering.
 * 6 submenus: Pane, Tab, Session, Theme, View, Help
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
  useAppConfig,
  selectKeyBindings,
  selectVisiblePanes,
  selectWindows,
  selectThemeName,
  selectThemeMode,
  selectAvailableThemes,
  selectCursorBlink,
} from '../../machines/AppContext';
import { getKeybindingLabel } from './keybindingLabel';
import { executeMenuAction } from './menuActions';
import { PaneMenuItems } from './PaneMenuItems';
import type { KeyBindings } from '../../machines/types';
import './AppMenu.css';

function KeyLabel({ keybindings, command }: { keybindings: KeyBindings | null; command: string }) {
  const label = getKeybindingLabel(keybindings, command);
  if (!label) return null;
  return <span className="menu-keybinding">{label}</span>;
}

export function AppMenu() {
  const send = useAppSend();
  const { isDemo } = useAppConfig();
  const keybindings = useAppSelector(selectKeyBindings);
  const visiblePanes = useAppSelector(selectVisiblePanes);
  const windows = useAppSelector(selectWindows);
  const themeName = useAppSelector(selectThemeName);
  const themeMode = useAppSelector(selectThemeMode);
  const availableThemes = useAppSelector(selectAvailableThemes);
  const cursorBlink = useAppSelector(selectCursorBlink);

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
        <PaneMenuItems
          keybindings={keybindings}
          isSinglePane={isSinglePane}
          onAction={handleAction}
        />
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
        <MenuItem onClick={() => handleAction('session-new')} disabled={isDemo}>
          New Session
        </MenuItem>
        <MenuItem onClick={() => handleAction('session-rename')} disabled={isDemo}>
          Rename Session
          <KeyLabel
            keybindings={keybindings}
            command={'command-prompt -I "#S" "rename-session -- \'%%\'"'}
          />
        </MenuItem>
        <MenuItem onClick={() => handleAction('session-detach')} disabled={isDemo}>
          Detach Session
          <KeyLabel keybindings={keybindings} command="detach-client" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('session-kill')} disabled={isDemo}>
          Kill Session
        </MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => handleAction('session-reload-config')} disabled={isDemo}>
          Reload Config
        </MenuItem>
      </SubMenu>

      <SubMenu label="Theme">
        <MenuItem onClick={() => send({ type: 'SET_THEME_MODE', mode: 'dark' })}>
          {themeMode === 'dark' ? '\u25CF ' : '\u25CB '}Dark Mode
        </MenuItem>
        <MenuItem onClick={() => send({ type: 'SET_THEME_MODE', mode: 'light' })}>
          {themeMode === 'light' ? '\u25CF ' : '\u25CB '}Light Mode
        </MenuItem>
        {availableThemes.length > 0 && <MenuDivider />}
        {availableThemes.map((t) => (
          <MenuItem key={t.name} onClick={() => send({ type: 'SET_THEME', name: t.name })}>
            {themeName === t.name ? '\u2713 ' : '\u2003 '}
            {t.displayName}
          </MenuItem>
        ))}
      </SubMenu>

      <SubMenu label="View">
        <MenuItem onClick={() => handleAction('view-zoom')}>
          Zoom Pane
          <KeyLabel keybindings={keybindings} command="resize-pane -Z" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('view-layout-even-horizontal')}>
          Even Horizontal
        </MenuItem>
        <MenuItem onClick={() => handleAction('view-layout-even-vertical')}>Even Vertical</MenuItem>
        <MenuItem onClick={() => handleAction('view-layout-main-horizontal')}>
          Main Horizontal
        </MenuItem>
        <MenuItem onClick={() => handleAction('view-layout-main-vertical')}>Main Vertical</MenuItem>
        <MenuItem onClick={() => handleAction('view-layout-tiled')}>Tiled</MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => send({ type: 'INCREASE_FONT_SIZE' })}>Make Text Bigger</MenuItem>
        <MenuItem onClick={() => send({ type: 'DECREASE_FONT_SIZE' })}>Make Text Smaller</MenuItem>
        <MenuItem onClick={() => send({ type: 'RESET_FONT_SIZE' })}>Make Text Normal Size</MenuItem>
        <MenuDivider />
        <MenuItem onClick={() => send({ type: 'TOGGLE_CURSOR_BLINK' })}>
          {cursorBlink ? '\u2713 ' : '\u2003 '}Blinking Cursor
        </MenuItem>
      </SubMenu>

      <SubMenu label="Help">
        <MenuItem onClick={() => handleAction('help-github')}>
          Tmuxy on GitHub<span className="menu-external">{'\u2197'}</span>
        </MenuItem>
      </SubMenu>
    </Menu>
  );
}
