/**
 * StatusBar - Top bar with hamburger menu, window tabs, and session dropdown
 *
 * Content is centered to match pane/status-bar width (totalWidth * charWidth).
 */

import { useAppSelector, selectGridDimensions, selectSessionName } from '../machines/AppContext';
import { WindowTabs } from './WindowTabs';
import { AppMenu } from './menus/AppMenu';
import './StatusBar.css';

export function StatusBar() {
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);
  const sessionName = useAppSelector(selectSessionName);

  const contentWidth = totalWidth > 0 ? totalWidth * charWidth : undefined;

  return (
    <div className="statusbar">
      <div
        className="statusbar-inner"
        style={contentWidth ? { width: contentWidth, margin: '0 auto' } : undefined}
      >
        <AppMenu />
        <WindowTabs />
        <button className="statusbar-session" aria-label="Session">
          <span className="statusbar-session-name">{sessionName}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path
              d="M2 3.5L5 7L8 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
