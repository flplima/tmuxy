/**
 * AppMenu - Application-level hamburger menu with submenus
 *
 * Uses @szhsin/react-menu for menu rendering.
 * Submenus: Pane, Tab, Session, Theme, View, Debug, Help
 * Keybinding labels are derived from server-provided keybindings.
 *
 * On macOS Tauri this hamburger is not rendered — `StatusBar` swaps it for the
 * traffic-light spacer and the app uses the native macOS menu bar built in the
 * Tauri layer (`gui.rs` `build_app_menu` / `handle_menu_event`). The web build
 * and non-macOS Tauri (which have no native menu bar) render it as the primary
 * app menu.
 */

import { Menu, MenuItem, SubMenu, MenuDivider } from '@szhsin/react-menu';
import '@szhsin/react-menu/dist/index.css';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  useAppConfig,
  selectKeyBindings,
  selectIsSinglePane,
  selectWindows,
  selectThemeName,
  selectThemeMode,
  selectAvailableThemes,
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
  const isSinglePane = useAppSelector(selectIsSinglePane);
  const windows = useAppSelectorShallow(selectWindows);
  const themeName = useAppSelector(selectThemeName);
  const themeMode = useAppSelector(selectThemeMode);
  const availableThemes = useAppSelector(selectAvailableThemes);

  const isSingleWindow = windows.filter((w) => w.windowType === 'tab').length <= 1;

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
      </SubMenu>

      <SubMenu label="Debug">
        <MenuItem
          onClick={() =>
            copyToClipboard('state', (text) => send({ type: 'SHOW_STATUS_MESSAGE', text }))
          }
        >
          Copy XState Snapshot
        </MenuItem>
        <MenuItem
          onClick={() =>
            copyToClipboard('events', (text) => send({ type: 'SHOW_STATUS_MESSAGE', text }))
          }
        >
          Copy Recent Events
        </MenuItem>
        <MenuItem
          onClick={() =>
            copyToClipboard('dom', (text) => send({ type: 'SHOW_STATUS_MESSAGE', text }))
          }
        >
          Copy DOM Snapshot
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

/**
 * Copy a debug payload to the system clipboard via navigator.clipboard.
 * Mirrors the native Tauri Debug menu so the Web build (and Tauri's hamburger
 * menu fallback) can hand users the same state dump for bug reports.
 */
function copyToClipboard(
  kind: 'state' | 'events' | 'dom',
  showMessage: (text: string) => void,
): void {
  let payload: string;
  let label: string;
  try {
    if (kind === 'state') {
      payload = JSON.stringify(window.app?.getSnapshot?.()?.context ?? null, null, 2);
      label = 'Copied XState snapshot to clipboard';
    } else if (kind === 'events') {
      const events = window.getRecentEvents?.() ?? [];
      payload = JSON.stringify(events, null, 2);
      label = `Copied ${events.length} recent events to clipboard`;
    } else {
      payload = (window.getSnapshot?.() ?? []).join('\n');
      label = 'Copied DOM snapshot to clipboard';
    }
  } catch (e) {
    showMessage(`Could not read debug data: ${String(e)}`);
    return;
  }
  navigator.clipboard.writeText(payload).then(
    () => showMessage(label),
    (e: unknown) => showMessage(`Clipboard write failed: ${String(e)}`),
  );
}
