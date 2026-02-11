/**
 * WindowTabs - Displays tmux window tabs in the status bar
 *
 * Minimalist flat buttons for each tmux window.
 * Filters out special windows (pane groups, floats).
 */

import { useCallback } from 'react';
import {
  useAppSend,
  useAppSelector,
  selectWindows,
} from '../machines/AppContext';

export function WindowTabs() {
  const send = useAppSend();
  const windows = useAppSelector(selectWindows);

  // Filter out special windows (pane groups and floats)
  const visibleWindows = windows.filter(
    (w) => !w.isPaneGroupWindow && !w.isFloatWindow
  );

  const handleWindowClick = useCallback(
    (windowIndex: number) => {
      send({ type: 'SEND_COMMAND', command: `select-window -t ${windowIndex}` });
    },
    [send]
  );

  const handleNewWindow = useCallback(() => {
    send({ type: 'SEND_COMMAND', command: 'new-window' });
  }, [send]);

  return (
    <div className="window-tabs">
      {visibleWindows.map((window) => (
        <button
          key={window.index}
          className={`window-tab ${window.active ? 'window-tab-active' : ''}`}
          onClick={() => handleWindowClick(window.index)}
          aria-label={`Window ${window.index}: ${window.name}${window.active ? ' (active)' : ''}`}
          aria-pressed={window.active}
        >
          <span className="window-name">{window.name || `Window ${window.index}`}</span>
        </button>
      ))}
      <button
        className="window-tab window-tab-add"
        onClick={handleNewWindow}
        title="New window"
        aria-label="Create new window"
      >
        +
      </button>
    </div>
  );
}
