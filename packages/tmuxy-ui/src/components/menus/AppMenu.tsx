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

import {
  Menu,
  MenuItem,
  SubMenu,
  MenuDivider,
  MenuHeader,
  MenuRadioGroup,
} from '@szhsin/react-menu';
import '@szhsin/react-menu/dist/index.css';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  useAppConfig,
  selectKeyBindings,
  selectIsSinglePane,
  selectMarkedPaneId,
  selectWindows,
  selectThemeName,
  selectThemeMode,
  selectAvailableThemes,
  selectTraceSettings,
} from '../../machines/AppContext';
import type { TraceLevel } from '../../machines/types';
import { isTauri } from '../../tmux/adapters';
import { restartApp } from '../../utils/restartApp';
import { activeCloseTarget, executeMenuAction } from './menuActions';
import { PaneMenuItems } from './PaneMenuItems';
import { KeyLabel } from './KeyLabel';
import './AppMenu.css';

export function AppMenu() {
  const send = useAppSend();
  const { isDemo } = useAppConfig();
  const keybindings = useAppSelector(selectKeyBindings);
  const isSinglePane = useAppSelector(selectIsSinglePane);
  const markedPaneId = useAppSelector(selectMarkedPaneId);
  const windows = useAppSelectorShallow(selectWindows);
  const themeName = useAppSelector(selectThemeName);
  const themeMode = useAppSelector(selectThemeMode);
  const availableThemes = useAppSelector(selectAvailableThemes);
  const activePaneId = useAppSelector((c) => c.activePaneId);
  const focusedFloatPaneId = useAppSelector((c) => c.focusedFloatPaneId);
  const trace = useAppSelector(selectTraceSettings);

  const isSingleWindow = windows.filter((w) => w.windowType === 'tab').length <= 1;

  const handleAction = (actionId: string) => {
    executeMenuAction(send, actionId, activeCloseTarget(activePaneId, focusedFloatPaneId));
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
          isMarked={markedPaneId !== null && markedPaneId === activePaneId}
          hasMarked={markedPaneId !== null}
          onAction={handleAction}
        />
      </SubMenu>

      <SubMenu label="Tab">
        <MenuItem onClick={() => handleAction('tab-new')}>
          New Tab
          <KeyLabel keybindings={keybindings} command="new-window" />
        </MenuItem>
        <MenuItem onClick={() => handleAction('tab-overview')}>
          Show All Tabs
          <span className="menu-keybinding">ctrl+0</span>
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

      {/*
        Debug — the local action trace and nothing else (docs/TELEMETRY.md).
        Settings are read on open rather than held: the backend is the
        authority (a DO_NOT_TRACK kill switch can refuse an enable), and the
        native macOS menu can flip the same switch behind this one's back.
      */}
      <SubMenu
        label="Debug"
        onMenuChange={(e) => {
          if (e.open) send({ type: 'FETCH_TRACE_SETTINGS' });
        }}
      >
        <MenuItem
          type="checkbox"
          checked={trace?.enabled ?? false}
          disabled={trace?.locked ?? false}
          onClick={(e) => send({ type: 'SET_TRACE_ENABLED', enabled: !!e.checked })}
        >
          Enable Traces
        </MenuItem>

        <MenuDivider />
        <MenuHeader>Trace Level</MenuHeader>
        <MenuRadioGroup
          value={trace?.level ?? 'shape'}
          onRadioChange={(e) => send({ type: 'SET_TRACE_LEVEL', level: e.value as TraceLevel })}
        >
          <MenuItem type="radio" value="shape" disabled={!trace?.enabled}>
            Shape
          </MenuItem>
          <MenuItem type="radio" value="labeled" disabled={!trace?.enabled}>
            Labeled
          </MenuItem>
          <MenuItem type="radio" value="full" disabled={!trace?.enabled}>
            Full
          </MenuItem>
        </MenuRadioGroup>

        <MenuDivider />
        {/* The trace file lives on the machine running the backend, so only the
            desktop app can open it — a browser tab cannot. */}
        {isTauri() && (
          <MenuItem disabled={!trace?.enabled} onClick={() => send({ type: 'OPEN_TRACE_FILE' })}>
            Open trace.ndjson
          </MenuItem>
        )}
        <MenuItem
          disabled={!trace?.enabled || !trace?.path}
          onClick={() =>
            copyTracePath(trace?.path ?? null, (text) =>
              send({ type: 'SHOW_STATUS_MESSAGE', text }),
            )
          }
        >
          Copy trace.ndjson Path
        </MenuItem>

        <MenuDivider />
        <MenuItem onClick={restartApp}>Restart App</MenuItem>
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
 * Put the trace file's path on the clipboard. The path itself is the useful
 * thing to hand around (`tmuxy trace`, `jq`, an editor); the file can be
 * hundreds of MB, so this never copies its contents.
 */
function copyTracePath(path: string | null, showMessage: (text: string) => void): void {
  if (!path) {
    showMessage('No trace file path available');
    return;
  }
  navigator.clipboard.writeText(path).then(
    () => showMessage(`Copied ${path}`),
    (e: unknown) => showMessage(`Clipboard write failed: ${String(e)}`),
  );
}
