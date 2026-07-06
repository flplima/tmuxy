/**
 * WindowTabs - Displays tmux window tabs in the status bar
 *
 * Plain text tab names: light gray for inactive, green for active.
 * Right-click opens a context menu with tab operations.
 */

import { memo, useMemo, useCallback, useState } from 'react';
import { useAppSend, useAppSelectorShallow, selectVisibleWindows } from '../machines/AppContext';
import { TabContextMenu } from './TabContextMenu';
import { haptics } from '../utils/haptics';
import { LogProfiler } from '../utils/renderLog';
import type { TmuxWindow } from '../machines/types';

interface TabContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  windowIndex: number;
}

/**
 * Memoized (no props): context.windows gets a fresh array identity on every
 * model tick; the shallow selectors below keep re-renders to actual window
 * changes, and the memo shields against parent re-renders.
 */
export const WindowTabs = memo(function WindowTabs() {
  const send = useAppSend();
  const rawWindows = useAppSelectorShallow(selectVisibleWindows);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    windowIndex: 0,
  });

  // Dedup safety net: ensure no duplicate window IDs reach the DOM
  const visibleWindows = useMemo(
    () => [...new Map(rawWindows.map((w) => [w.id, w])).values()],
    [rawWindows],
  );

  const handleWindowClick = useCallback(
    (window: TmuxWindow) => {
      haptics.trigger(10);
      send({ type: 'SELECT_TAB', windowId: window.id, windowIndex: window.index });
    },
    [send],
  );

  const handleNewWindow = useCallback(() => {
    send({ type: 'CREATE_TAB' });
  }, [send]);

  const handleContextMenu = useCallback((e: React.MouseEvent, windowIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, windowIndex });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  return (
    <LogProfiler id="WindowTabs">
      <div className="tab-list">
        {visibleWindows.map((window, idx) => {
          const visualIndex = idx + 1;
          return (
            <span
              key={window.id}
              className={`tab-name ${window.active ? 'tab-name-active' : ''}`}
              onClick={() => handleWindowClick(window)}
              onContextMenu={(e) => handleContextMenu(e, window.index)}
              role="tab"
              aria-selected={window.active}
              aria-label={`Tab ${visualIndex}: ${window.name}${window.active ? ' (active)' : ''}`}
            >
              {visualIndex}:{window.name || `Tab ${visualIndex}`}
            </span>
          );
        })}
        <button
          className="tab-add"
          onClick={handleNewWindow}
          title="New tab"
          aria-label="Create new tab"
        >
          +
        </button>

        {contextMenu.visible && (
          <TabContextMenu
            windowIndex={contextMenu.windowIndex}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={closeContextMenu}
          />
        )}
      </div>
    </LogProfiler>
  );
});
