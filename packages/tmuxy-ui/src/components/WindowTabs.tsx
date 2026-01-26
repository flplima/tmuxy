/**
 * WindowTabs - Displays tmux window tabs in the status bar
 *
 * Uses hooks to access state and send events directly.
 */

import { useState, useCallback } from 'react';
import {
  useAppSend,
  useAppSelector,
  selectWindows,
  selectDragTargetNewWindow,
} from '../machines/AppContext';

export function WindowTabs() {
  const send = useAppSend();
  const windows = useAppSelector(selectWindows);
  const isDraggingToNewWindow = useAppSelector(selectDragTargetNewWindow);

  const [hoveredWindow, setHoveredWindow] = useState<number | null>(null);

  // Filter out pane group windows (they are hidden and managed separately)
  const visibleWindows = windows.filter((w) => !w.isPaneGroupWindow);
  const hasMultipleWindows = visibleWindows.length > 1;

  const handleWindowClick = useCallback(
    (windowIndex: number) => {
      send({ type: 'SEND_COMMAND', command: `select-window -t ${windowIndex}` });
    },
    [send]
  );

  const handleCloseWindow = useCallback(
    (windowIndex: number) => {
      send({ type: 'SEND_COMMAND', command: `kill-window -t :${windowIndex}` });
    },
    [send]
  );

  const handleNewWindow = useCallback(() => {
    send({ type: 'SEND_COMMAND', command: 'new-window' });
  }, [send]);

  const handleCloseClick = (e: React.MouseEvent, windowIndex: number) => {
    e.stopPropagation();
    handleCloseWindow(windowIndex);
  };

  return (
    <div className="window-tabs">
      {visibleWindows.map((window) => (
        <div
          key={window.index}
          className={`window-tab ${window.active ? 'window-tab-active' : ''}`}
          onClick={() => handleWindowClick(window.index)}
          onMouseEnter={() => setHoveredWindow(window.index)}
          onMouseLeave={() => setHoveredWindow(null)}
          role="button"
          tabIndex={0}
          aria-label={`Window ${window.index}: ${window.name}${window.active ? ' (active)' : ''}`}
          aria-pressed={window.active}
        >
          <span className="window-index">{window.index}</span>
          <span className="window-name">{window.name}</span>
          {hasMultipleWindows && hoveredWindow === window.index && (
            <button
              className="window-close"
              onClick={(e) => handleCloseClick(e, window.index)}
              title="Close window"
              aria-label={`Close window ${window.index}`}
            >
              &times;
            </button>
          )}
        </div>
      ))}
      {isDraggingToNewWindow ? (
        <div className="window-tab window-tab-placeholder">
          <span className="window-name">New Window</span>
        </div>
      ) : (
        <button
          className="window-new"
          onClick={handleNewWindow}
          title="New window"
          aria-label="Create new window"
        >
          +
        </button>
      )}
    </div>
  );
}
