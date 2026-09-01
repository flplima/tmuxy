/**
 * WindowTabs - the tmux window tabs in the status bar.
 *
 * The tabs share the strip equally (`flex: 1 1 0` each) and centre their label,
 * so the strip reads as one row of even slots rather than a ragged left-aligned
 * list, and a tab doesn't jump sideways when a neighbour is renamed.
 *
 * The active tab is marked by BRIGHTNESS alone — full opacity and pure white
 * against the others' dimmed grey — with no pill or background behind it. A
 * single tab is not "active" in any useful sense, so it renders as a plain title
 * with no highlight at all.
 *
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

  const isSingleTab = visibleWindows.length === 1;

  return (
    <LogProfiler id="WindowTabs">
      <div className={`tab-list${isSingleTab ? ' tab-list-single' : ''}`}>
        {visibleWindows.map((window, idx) => {
          const visualIndex = idx + 1;
          return (
            <span
              key={window.id}
              className={`tab-name ${window.active && !isSingleTab ? 'tab-name-active' : ''}`}
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
