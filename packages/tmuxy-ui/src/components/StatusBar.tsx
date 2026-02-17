/**
 * StatusBar - Top bar with hamburger menu, window tabs, and session dropdown
 *
 * Content is centered to match pane/status-bar width (totalWidth * charWidth).
 */

import {
  useAppSelector,
  selectGridDimensions,
  selectSessionName,
} from '../machines/AppContext';
import { WindowTabs } from './WindowTabs';
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
        <button className="statusbar-hamburger" aria-label="Menu">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="3" width="12" height="1.5" rx="0.5" />
            <rect x="2" y="7.25" width="12" height="1.5" rx="0.5" />
            <rect x="2" y="11.5" width="12" height="1.5" rx="0.5" />
          </svg>
        </button>
        <WindowTabs />
        <button className="statusbar-session" aria-label="Session">
          <span className="statusbar-session-name">{sessionName}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M2 3.5L5 7L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
