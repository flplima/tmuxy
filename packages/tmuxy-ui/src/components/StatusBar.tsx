/**
 * StatusBar - Top bar with hamburger menu and window tabs
 *
 * Content is centered to match pane/status-bar width (totalWidth * charWidth).
 */

import type { RenderTabline } from '../App';
import { useAppSelector, selectGridDimensions } from '../machines/AppContext';
import { WindowTabs } from './WindowTabs';
import { AppMenu } from './menus/AppMenu';
import './StatusBar.css';

export function StatusBar({ renderTabline }: { renderTabline?: RenderTabline }) {
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);

  const contentWidth = totalWidth > 0 ? totalWidth * charWidth : undefined;

  const defaultContent = (
    <>
      <AppMenu />
      <WindowTabs />
    </>
  );

  return (
    <div className="statusbar">
      <div
        className="statusbar-inner"
        style={contentWidth ? { width: contentWidth, margin: '0 auto' } : undefined}
      >
        {renderTabline ? renderTabline({ children: defaultContent }) : defaultContent}
      </div>
    </div>
  );
}
