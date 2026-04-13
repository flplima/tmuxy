/**
 * StatusBar - Top bar with hamburger menu and window tabs
 *
 * Content is centered to match pane/status-bar width (totalWidth * charWidth).
 *
 * On macOS Tauri: hides the hamburger menu (native menu bar is used instead),
 * adds spacing for the traffic light window buttons, and makes the bar draggable
 * via Tauri's data-tauri-drag-region attribute.
 */

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

  const defaultContent = (
    <>
      {isMacTauri ? <div className="traffic-light-spacer" /> : <AppMenu />}
      <WindowTabs />
    </>
  );

  // Tauri uses data-tauri-drag-region (not CSS -webkit-app-region) for window dragging
  const dragProps = isMacTauri ? { 'data-tauri-drag-region': true } : {};

  return (
    <div className="statusbar" {...dragProps}>
      <div
        className="statusbar-inner"
        style={contentWidth ? { width: contentWidth, margin: '0 auto' } : undefined}
        {...dragProps}
      >
        {renderTabline ? renderTabline({ children: defaultContent }) : defaultContent}
      </div>
    </div>
  );
}
