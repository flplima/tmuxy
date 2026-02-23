/**
 * WindowTabs - Displays tmux window tabs in the status bar
 *
 * Dark gray rounded buttons with hover-only close buttons.
 * Filters out special windows (pane groups, floats).
 */

import { useCallback } from 'react';
import { useAppSend, useAppSelector, selectVisibleWindows } from '../machines/AppContext';

export function WindowTabs() {
  const send = useAppSend();
  const visibleWindows = useAppSelector(selectVisibleWindows);

  const handleWindowClick = useCallback(
    (windowIndex: number) => {
      send({ type: 'SEND_COMMAND', command: `select-window -t ${windowIndex}` });
    },
    [send],
  );

  const handleNewWindow = useCallback(() => {
    send({ type: 'SEND_COMMAND', command: 'new-window' });
  }, [send]);

  const handleCloseWindow = useCallback(
    (windowIndex: number, e: React.MouseEvent) => {
      e.stopPropagation();
      send({ type: 'SEND_COMMAND', command: `kill-window -t :${windowIndex}` });
    },
    [send],
  );

  return (
    <div className="tab-list">
      {visibleWindows.map((window) => (
        <div key={window.index} className={`tab ${window.active ? 'tab-active' : ''}`}>
          <button
            className="tab-button"
            onClick={() => handleWindowClick(window.index)}
            aria-label={`Window ${window.index}: ${window.name}${window.active ? ' (active)' : ''}`}
            aria-pressed={window.active}
          >
            <span className="tab-name">{window.name || `Window ${window.index}`}</span>
          </button>
          <button
            className="tab-close"
            onClick={(e) => handleCloseWindow(window.index, e)}
            title="Close window"
            aria-label={`Close window ${window.index}`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path
                d="M3 3L9 9M9 3L3 9"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
      <button
        className="tab-add"
        onClick={handleNewWindow}
        title="New window"
        aria-label="Create new window"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <path
            d="M7 2V12M2 7H12"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
