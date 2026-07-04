/**
 * StatusBar - Top bar with hamburger menu and window tabs
 *
 * Content is centered to match pane/status-bar width (totalWidth * charWidth).
 *
 * On macOS Tauri: hides the hamburger menu (native menu bar is used instead),
 * adds spacing for the traffic light window buttons, and makes the bar draggable
 * via Tauri's startDragging() JS API on mousedown. The second mousedown of a
 * double-click toggles window zoom instead, since startDragging() swallows the
 * native dblclick event before it can reach onDoubleClick.
 */

import { memo, useCallback } from 'react';
import type { RenderTabline } from '../App';
import { useAppSelector, useAppState, selectGridDimensions } from '../machines/AppContext';
import { selectReconnectAttempt } from '../machines/selectors';
import { isTauri } from '../tmux/adapters';
import { LogProfiler } from '../utils/renderLog';
import { WindowTabs } from './WindowTabs';
import { AppMenu } from './menus/AppMenu';
import { SidebarToggle } from './SidebarToggle';
import { ConnectionStatus } from './ConnectionStatus';
import './StatusBar.css';

const isMacTauri = isTauri() && typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);

export const StatusBar = memo(function StatusBar({
  renderTabline,
}: {
  renderTabline?: RenderTabline;
}) {
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);
  const isReconnecting = useAppState('reconnecting');
  const reconnectAttempt = useAppSelector(selectReconnectAttempt);

  const contentWidth = totalWidth > 0 ? totalWidth * charWidth : undefined;

  // On macOS Tauri, mousedown on the statusbar starts window dragging
  // via the Tauri JS API (data-tauri-drag-region doesn't work reliably).
  // The second mousedown of a double-click toggles zoom instead — calling
  // startDragging() swallows the native dblclick event, so we check the
  // click count here rather than relying on onDoubleClick.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isMacTauri || e.buttons !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, [role="tab"], .tab-add, .app-menu-button, .sidebar-toggle')) return;

    if (e.detail === 2) {
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        getCurrentWindow().toggleMaximize();
      });
      return;
    }

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().startDragging();
    });
  }, []);

  // On non-macOS Tauri, startDragging isn't called so the native dblclick
  // event still fires — handle it here to toggle maximize, matching the
  // native Windows / Linux titlebar gesture.
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!isTauri() || isMacTauri) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, [role="tab"], .tab-add, .app-menu-button, .sidebar-toggle')) return;

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().toggleMaximize();
    });
  }, []);

  const defaultContent = (
    <>
      {isMacTauri ? <div className="traffic-light-spacer" /> : <AppMenu />}
      <SidebarToggle />
      <WindowTabs />
    </>
  );

  return (
    <LogProfiler id="StatusBar">
      <div className="statusbar" onMouseDown={handleMouseDown} onDoubleClick={handleDoubleClick}>
        <div
          className="statusbar-inner"
          style={contentWidth ? { width: contentWidth, margin: '0 auto' } : undefined}
        >
          {renderTabline ? renderTabline({ children: defaultContent }) : defaultContent}
          <ConnectionStatus reconnecting={isReconnecting} reconnectAttempt={reconnectAttempt} />
        </div>
      </div>
    </LogProfiler>
  );
});
