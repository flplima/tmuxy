/**
 * StatusBar - Top bar with hamburger menu and window tabs
 *
 * Content is centered to match pane/status-bar width (totalWidth * charWidth).
 *
 * In the desktop app the bar is also the window's title bar (see
 * tmux/desktopWindow.ts): empty space drags the window and double-clicking it
 * performs the native title-bar gesture. On macOS the hamburger menu is hidden
 * (the native menu bar is used instead), room is reserved for the traffic-light
 * buttons, and the bar reports its height so those buttons stay centred on it.
 */

import { memo, useCallback } from 'react';
import type { RenderTabline } from '../App';
import { useAppSelector, useAppState, selectGridDimensions } from '../machines/AppContext';
import { selectReconnectAttempt } from '../machines/selectors';
import { isTauri } from '../tmux/adapters';
import {
  isMacTauri,
  reportTitlebarHeight,
  startWindowDrag,
  titlebarDoubleClick,
} from '../tmux/desktopWindow';
import { LogProfiler } from '../utils/renderLog';
import { WindowTabs } from './WindowTabs';
import { AppMenu } from './menus/AppMenu';
import { SidebarToggle } from './SidebarToggle';
import { ConnectionStatus } from './ConnectionStatus';
import './StatusBar.css';

/** Interactive chrome inside the bar — clicks on these never drag or zoom the window. */
const CONTROLS = 'button, [role="tab"], .tab-add, .app-menu-button, .sidebar-toggle';

const isControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest(CONTROLS) !== null;

export const StatusBar = memo(function StatusBar({
  renderTabline,
}: {
  renderTabline?: RenderTabline;
}) {
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);
  const isReconnecting = useAppState('reconnecting');
  const reconnectAttempt = useAppSelector(selectReconnectAttempt);

  const contentWidth = totalWidth > 0 ? totalWidth * charWidth : undefined;

  // On macOS, mousedown on empty bar space hands the click to the OS as a
  // window drag via startDragging(), which swallows the native dblclick
  // before it reaches onDoubleClick — so the second mousedown of a
  // double-click (e.detail === 2) performs the title-bar gesture instead.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isMacTauri || e.buttons !== 1 || isControl(e.target)) return;
    if (e.detail === 2) titlebarDoubleClick();
    else startWindowDrag();
  }, []);

  // Other desktop platforms never call startDragging, so the native dblclick
  // still fires — the same gesture toggles maximize there.
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!isTauri() || isMacTauri || isControl(e.target)) return;
    titlebarDoubleClick();
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
      <div
        ref={reportTitlebarHeight}
        className="statusbar"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
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
