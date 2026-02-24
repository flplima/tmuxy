/**
 * PaneHeader - Tab-style pane header with close and add buttons
 *
 * Always shows panes as tabs (even single panes).
 * Pattern: |tab1 x| tab2 x| + |
 * Scrollable when tabs overflow.
 * Right-click shows context menu with pane operations.
 */

import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useAppSend, usePane, usePaneGroup, useCopyModeState } from '../machines/AppContext';
import { PaneContextMenu } from './PaneContextMenu';
import type { TmuxPane } from '../tmux/types';

/**
 * Compute a stable tmuxy-tab title from pane data
 * Uses command > title > tmuxId to avoid blink from borderTitle changes
 */
function getTabTitle(pane: TmuxPane): string {
  if (pane.inMode) {
    return '[COPY]';
  }
  // Show the current command (pane_current_command from tmux)
  if (pane.command) {
    return pane.command;
  }
  // Fallback to pane ID
  return pane.tmuxId;
}

/**
 * Memoized tmuxy-tab component to prevent unnecessary re-renders
 */
const PaneTab = memo(function PaneTab({
  pane,
  isSelectedTab,
  isActivePane,
  titleOverride,
  onClick,
  onContextMenu,
  onClose,
  onDragStart,
}: {
  pane: TmuxPane;
  isSelectedTab: boolean;
  isActivePane: boolean;
  titleOverride?: string;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClose: (e: React.MouseEvent) => void;
  onDragStart: (e: React.MouseEvent) => void;
}) {
  const tabTitle = titleOverride ?? getTabTitle(pane);

  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Don't start drag from close button
    if (target.classList.contains('tmuxy-pane-tab-close') || target.tagName === 'BUTTON') {
      return;
    }
    onDragStart(e);
  };

  return (
    <div
      className={`tmuxy-pane-tab ${isActivePane ? 'tmuxy-pane-tab-active' : ''} ${isSelectedTab ? 'tmuxy-pane-tab-selected' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseDown={handleMouseDown}
      role="tmuxy-tab"
      aria-selected={isSelectedTab}
      aria-label={`Pane ${pane.tmuxId}`}
    >
      <span className="tmuxy-pane-tab-title">{tabTitle}</span>
      <button
        className="tmuxy-pane-tab-close"
        onClick={onClose}
        title="Close pane"
        aria-label={`Close pane ${pane.tmuxId}`}
      >
        ×
      </button>
    </div>
  );
});

interface PaneHeaderProps {
  paneId: string;
  /** Override the tmuxy-tab title for this pane (used by widgets) */
  titleOverride?: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetPaneId: string;
}

export function PaneHeader({ paneId, titleOverride }: PaneHeaderProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { groupPanes, activePaneId } = usePaneGroup(paneId);
  const copyState = useCopyModeState(paneId);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetPaneId: '',
  });

  // Scroll selected tmuxy-tab into view
  useEffect(() => {
    if (!tabsRef.current || !activePaneId) return;
    const selectedTab = tabsRef.current.querySelector('.tmuxy-pane-tab-selected');
    if (selectedTab) {
      selectedTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activePaneId]);

  const handleContextMenu = useCallback((e: React.MouseEvent, targetPaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      targetPaneId,
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  if (!pane) return null;

  const { tmuxId, active: isActive, inMode } = pane;

  // Build list of panes to show as tabs
  // If in a group, show all group panes; otherwise just this pane
  const tabPanes = groupPanes && groupPanes.length > 0 ? groupPanes : [pane];
  const activeTabId = activePaneId ?? tmuxId;

  const handleClose = (e: React.MouseEvent, closePaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    send({ type: 'CLOSE_PANE', paneId: closePaneId });
  };

  const handleTabClick = (e: React.MouseEvent, clickedPaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    send({ type: 'TAB_CLICK', paneId: clickedPaneId });
  };

  const handleAddPane = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Add a new pane to this group (or create a group if single pane)
    send({ type: 'SEND_TMUX_COMMAND', command: 'tmuxy-pane-group-add' });
  };

  const handleTabDragStart = (e: React.MouseEvent, dragPaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    send({
      type: 'DRAG_START',
      paneId: dragPaneId,
      startX: e.clientX,
      startY: e.clientY,
    });
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    e.preventDefault();
    e.stopPropagation();
    send({ type: 'ZOOM_PANE', paneId: tmuxId });
  };

  const isInCopyMode = inMode || !!copyState;
  const headerClass = `tmuxy-pane-header ${isActive ? 'tmuxy-pane-header-active' : ''} ${isInCopyMode ? 'tmuxy-pane-header-copy-mode' : ''}`;

  return (
    <div
      className={headerClass}
      onDoubleClick={handleDoubleClick}
      role="tablist"
      aria-label={`Pane tabs`}
    >
      <div className="tmuxy-pane-tabs" ref={tabsRef}>
        {tabPanes.map((tabPane) => {
          const isSelectedTab = tabPane.tmuxId === activeTabId;
          // Tab is "active" (green) only if this pane is the active tmux pane
          // AND it's the selected tmuxy-tab in the group
          const isActivePane = tabPane.active && isSelectedTab;

          return (
            <PaneTab
              key={tabPane.tmuxId}
              pane={tabPane}
              isSelectedTab={isSelectedTab}
              isActivePane={isActivePane}
              titleOverride={tabPane.tmuxId === paneId ? titleOverride : undefined}
              onClick={(e) => handleTabClick(e, tabPane.tmuxId)}
              onContextMenu={(e) => handleContextMenu(e, tabPane.tmuxId)}
              onClose={(e) => handleClose(e, tabPane.tmuxId)}
              onDragStart={(e) => handleTabDragStart(e, tabPane.tmuxId)}
            />
          );
        })}
      </div>
      <button
        className="tmuxy-pane-tab-add"
        onClick={handleAddPane}
        title="Add pane to group"
        aria-label="Add new pane to group"
      >
        +
      </button>
      {contextMenu.visible && (
        <PaneContextMenu
          paneId={contextMenu.targetPaneId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
