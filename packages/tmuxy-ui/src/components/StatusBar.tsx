/**
 * StatusBar - Top bar with hamburger menu and window tabs
 *
 * Content is centered to match pane/status-bar width (totalWidth * charWidth).
 *
 * On macOS Tauri: hides the hamburger menu (native menu bar is used instead),
 * adds spacing for the traffic light window buttons, and makes the bar draggable
 * via Tauri's startDragging() JS API on mousedown.
 */

import { useCallback } from 'react';
import type { RenderTabline } from '../App';
import { useAppSelector, selectGridDimensions } from '../machines/AppContext';
import { isTauri } from '../tmux/adapters';
import { WindowTabs } from './WindowTabs';
import { AppMenu } from './menus/AppMenu';
import './StatusBar.css';

const isMacTauri = isTauri() && typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);

export function StatusBar({ renderTabline }: { renderTabline?: RenderTabline }) {
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);

  const contentWidth = totalWidth > 0 ? totalWidth * charWidth : undefined;

  // On macOS Tauri, mousedown on the statusbar starts window dragging
  // via the Tauri JS API (data-tauri-drag-region doesn't work reliably)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isMacTauri || e.buttons !== 1) return;
    // Don't drag if clicking on an interactive element
    const target = e.target as HTMLElement;
    if (target.closest('button, [role="tab"], .tab-add, .app-menu-button')) return;

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().startDragging();
    });
  }, []);

  const defaultContent = (
    <>
      {isMacTauri ? <div className="traffic-light-spacer" /> : <AppMenu />}
      <WindowTabs />
    </>
  );

  return (
    <div className="statusbar" onMouseDown={handleMouseDown}>
      <div
        className="statusbar-inner"
        style={contentWidth ? { width: contentWidth, margin: '0 auto' } : undefined}
      >
        {renderTabline ? renderTabline({ children: defaultContent }) : defaultContent}
      </div>
    </div>
  );
}
